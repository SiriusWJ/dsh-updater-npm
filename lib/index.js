/**
 * dsh-updater-npm —— Host 面
 *
 * 本地 DSH 更新器 + 官方文档同步器：
 *  1) 自动检查 @deepseek-ai/dsh 的 npm 最新版本，设置页一键通过 npm 升级；
 *  2) 把 deepseek-ai/deepseek-harness 官方 docs/ 增量同步到本地
 *     （按 GitHub blob sha 跳过未变化文件，断点可续）；
 *  3) 基于本地文档建立索引（标题/标题树/摘要/语言），提供两个只读模型工具：
 *     dsh_docs_search —— 搜索本地 DSH 官方文档索引
 *     dsh_docs_read   —— 读取一篇本地文档（支持按章节聚焦）
 *
 * 路由（POST 均做同源保护）：
 *   GET  /dsh-updater-npm/check        检查更新（10 分钟内返回缓存）
 *   POST /dsh-updater-npm/update       执行 npm 升级
 *   GET  /dsh-updater-npm/docs/status  文档同步状态
 *   POST /dsh-updater-npm/docs/sync    触发官方文档同步
 *   GET  /dsh-updater-npm/docs/search  本地文档索引搜索（?q=&lang=&limit=）
 *   GET  /dsh-updater-npm/docs/read    读取一篇本地文档（?path=...&section=...）
 *
 * timer：每 30 分钟自动检查更新；文档同步受设置页开关控制（默认关闭），
 * 开启后首次启动若本地无文档则后台同步一次，此后每 24 小时静默增量同步。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync, realpathSync } from 'node:fs'
import { dirname, join, basename, extname, normalize, resolve, sep, delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'

export const name = 'dsh-updater-npm'
// 'tools' 必须作为硬依赖注入：插件在异步 effect 里注册文档工具，
// 若不注入 tools，apply 可能在 tools 服务就绪前激活，ctx.get('tools')
// 返回 undefined 导致注册被静默跳过（dsh_docs_search/read 缺失）。
// 参考 dsh-find-plugin：export const inject = ['tools']。
export const inject = ['agentPresets', 'timer', 'webServer', 'tools']

// ────────────────────────────────────────────────────────────────────────────
// 国际化（zh / en）
// 宿主端默认读取系统环境自动选择语言：优先 LANG/LC_ALL/LC_MESSAGES 环境变量，
// 其次 Node Intl 默认区域（Windows 跟随系统显示语言）；HTTP 路由可用
// ?uilang=en|zh 由客户端显式覆盖（客户端界面语言以浏览器/设置页选择为准）。
// ────────────────────────────────────────────────────────────────────────────

const HOST_I18N = {
  zh: {
    headCommitFail: '获取 head commit 失败: {err}',
    treeFail: '获取文件树失败: {err}',
    treeBad: '文件树响应格式异常',
    docsListEmpty: '官方 docs 清单为空',
    downloadStart: '开始下载 {n} 篇文档…',
    downloading: '下载 {done}/{total}',
    writeFail: '写入失败',
    rebuildingIndex: '正在重建文档索引…',
    indexRebuildFail: '索引重建失败: {err}',
    docsNotSynced: '本地文档尚未同步，请先在设置页同步官方文档',
    emptyQuery: '查询词不能为空',
    docNotFound: '未找到文档: {path}',
    readFail: '读取失败: {err}',
    truncated: '\n…（内容过长已截断）',
    npmSpawnFail: 'npm 启动失败: {err}',
    npmRunning: '正在执行 npm install -g @deepseek-ai/dsh@latest…',
    npmRunningOwn: '正在执行 npm install -g @deepseek-ai/dsh@latest…（使用当前实例自带的 npm，只更新当前运行副本）',
    npmExecFail: 'npm 执行失败: {err}',
    progressElapsed: '已进行 {sec}',
    updateDone: '更新完成',
    updateFailed: '更新失败',
    npmExitCode: 'npm 退出码 {code}',
    updatedHint: '已更新到 v{version}，重启 DSH 后生效',
    upToDateHint: '已是最新版本，无需更新',
    updateNoEffect: 'npm 更新已执行，但当前运行副本的版本未变化（{before} → {after}）——更新可能落在了另一个 dsh 副本，或该副本不由这个 npm 管理。请检查 PATH 中的 npm 与多个 dsh 安装。',
    locateFail: '无法定位 dsh 安装目录（既不是 bin.js 也不是 preset 反推路径）',
    locateFailShort: '无法定位 dsh 安装目录',
    checkTimeout: '检查超时，请稍后重试',
    busyUpdate: '一次只允许一个更新操作，请稍候重试',
    locating: '正在定位 dsh 安装目录…',
    sourceModeUpdate: '当前以源码树模式运行（{dir}），npm 全局更新不会改变运行实例。请先在源码树执行 git pull + pnpm install 更新，或改用 npm-global 方式启动 dsh 后再点更新。',
    sourceWarning: '当前以源码树模式运行（{dir}，v{version}）。已支持源码树更新：将执行 git pull + 依赖安装，不会影响 npm 全局安装或其他副本。',
    // 源码树（git）更新
    sourceOnly: '该操作仅适用于源码树模式',
    gitUnavailable: '不是 git 仓库或 git 不可用，无法执行源码树更新',
    gitDirty: '工作区有未提交修改，更新前请先提交或 git stash',
    sourceFetching: '正在 git fetch 远端…',
    sourcePulling: '正在 git pull（仅快进合并）…',
    sourceInstall: '正在安装依赖（{cmd} install）…',
    sourceDiverged: '本地分支与远端已分叉（非快进），git pull --ff-only 失败；请先手动合并或 rebase 后再更新',
    sourceUpdatedHint: '源码树已更新到 {commit}，重启 DSH 后生效',
    sourceUpToDateHint: '源码树已是最新，无需更新',
    // PowerShell 7 一键安装（Windows）
    pwshWinOnly: '仅 Windows 平台支持一键安装 PowerShell 7',
    pwshInstalling: '正在安装 PowerShell 7（pwsh）…',
    pwshWinget: '正在用 winget 安装 PowerShell 7…',
    pwshMsi: 'winget 不可用，改用官方 MSI 静默安装 PowerShell 7…',
    pwshMsiNoRelease: '无法获取 PowerShell 最新版本信息',
    pwshMsiNoAsset: '未找到 win-x64 MSI 安装包',
    pwshMsiDownload: '正在下载 {file} …',
    pwshMsiDownloadFail: 'PowerShell 7 安装包下载失败',
    pwshMsiInstall: '正在静默安装 MSI（可能需要管理员权限）…',
    pwshInstalled: '✅ PowerShell 7 已安装，重启 DSH 后生效',
    pwshInstallFail: 'PowerShell 7 安装失败（可能需要管理员权限）: ',
    pwshInstallTimeout: '等待 pwsh 就绪超时，请检查安装结果后重启 DSH',
    // staged 更新（Windows 运行实例 EBUSY 防护）
    updateStaging: '正在下载并安装 v{version} 到暂存目录（不触碰运行中的部署，避免 EBUSY）…',
    updateStagingVerify: '正在校验暂存的新版本…',
    updateStagingFail: '暂存安装失败: {err}',
    updateFinisher: '新版本已就绪，正在启动更新完成器：DSH 将自动退出并重启完成更新…',
    deployBrokenWarn: '⚠️ 部署目录不完整（可能是上次更新中断），重启后可能无法启动。建议点击「修复部署」重新安装当前版本。',
    repairBtn: '修复部署（重装当前版本）',
    repairRunning: '正在修复部署…（完成后 DSH 自动重启）',
    repairDone: '✅ 部署已修复，DSH 即将自动重启',
    repairFail: '部署修复失败: ',
    busySync: '文档同步正在进行中，请稍候重试',
    docsDisabled: '文档同步未开启——请先在设置页打开「同步官方文档」开关。',
    fetchingList: '正在获取官方文档清单…',
    syncFail: '同步失败: {err}',
    syncDone: '同步完成：{synced} 个更新 / {skipped} 个未变 / {failed} 个失败',
    // 工具描述与输出
    searchToolDesc: '搜索 DeepSeek Harness（DSH）官方文档的本地索引。索引由 dsh-updater-npm 插件从 deepseek-ai/deepseek-harness 的 docs/ 同步而来。返回带路径、标题、标题树与摘要的排序命中结果；之后用 dsh_docs_read 读取全文。中文文档以 .zh.md 结尾，查询含中文时自动优先返回中文。',
    readToolDesc: '从已同步的文档索引中读取一篇本地 DeepSeek Harness（DSH）官方文档的完整内容。传 dsh_docs_search 返回的精确路径（如 "docs/user/develop/basic/tool.md"），或唯一文件名如 "tool.md"。可传 section 聚焦某个标题（大小写不敏感的子串）。返回 markdown 原文，超过 80KB 截断。',
    noMatchResult: '（无匹配结果）',
    searchHead: 'DSH 文档搜索 "{query}"：共 {total} 条，显示 {shown} 条',
    readFailHead: '读取失败：{err}',
    readHead: 'DSH 文档 {path}{section}{size}{truncated}',
    readSection: ' 章节「{section}」',
    readChars: '（{n} 字符',
    readTruncated: '，已截断',
    // 控制台
    toolsRegistered: '[dsh-updater-npm] 已注册文档工具 dsh_docs_search / dsh_docs_read',
    toolsRegisterFail: '[dsh-updater-npm] 工具注册失败: {err}',
    docsFirstSyncDone: '[dsh-updater-npm] 官方文档首次同步完成: {n} 个文件',
  },
  en: {
    headCommitFail: 'Failed to fetch head commit: {err}',
    treeFail: 'Failed to fetch file tree: {err}',
    treeBad: 'Malformed file tree response',
    docsListEmpty: 'Official docs list is empty',
    downloadStart: 'Downloading {n} docs…',
    downloading: 'Downloading {done}/{total}',
    writeFail: 'write failed',
    rebuildingIndex: 'Rebuilding docs index…',
    indexRebuildFail: 'Index rebuild failed: {err}',
    docsNotSynced: 'Local docs not synced yet — sync the official docs in Settings first',
    emptyQuery: 'Query must not be empty',
    docNotFound: 'Document not found: {path}',
    readFail: 'Read failed: {err}',
    truncated: '\n…(content truncated)',
    npmSpawnFail: 'npm failed to start: {err}',
    npmRunning: 'Running npm install -g @deepseek-ai/dsh@latest…',
    npmRunningOwn: 'Running npm install -g @deepseek-ai/dsh@latest… (using the running instance\'s own npm; only the running copy is touched)',
    npmExecFail: 'npm execution failed: {err}',
    progressElapsed: 'elapsed {sec}',
    updateDone: 'Update complete',
    updateFailed: 'Update failed',
    npmExitCode: 'npm exit code {code}',
    updatedHint: 'Updated to v{version} — restart DSH to apply',
    upToDateHint: 'Already up to date, nothing to update',
    updateNoEffect: 'npm update ran but the running copy\'s version did not change ({before} → {after}) — the update may have landed on another dsh copy, or this copy is not managed by this npm. Check the npm on PATH and your dsh installations.',
    locateFail: 'Could not locate the dsh install directory (neither bin.js nor preset fallback)',
    locateFailShort: 'Could not locate the dsh install directory',
    checkTimeout: 'Check timed out, please retry later',
    busyUpdate: 'Only one update operation at a time, please retry later',
    locating: 'Locating dsh install directory…',
    sourceModeUpdate: 'Running in source-tree mode ({dir}); npm global update will not change the running instance. Run git pull + pnpm install in the source tree first, or start dsh in npm-global mode, then update.',
    sourceWarning: 'Running in source-tree mode ({dir}, v{version}). Source-tree updates are supported: git pull + dependency install, without touching the npm global install or other copies.',
    // 源码树（git）更新
    sourceOnly: 'This operation only applies to source-tree mode',
    gitUnavailable: 'Not a git repository, or git is unavailable — cannot run a source-tree update',
    gitDirty: 'The working tree has uncommitted changes — commit or stash them before updating',
    sourceFetching: 'Running git fetch…',
    sourcePulling: 'Running git pull (fast-forward only)…',
    sourceInstall: 'Installing dependencies ({cmd} install)…',
    sourceDiverged: 'Local branch diverged from the remote (not fast-forward); git pull --ff-only failed. Merge or rebase manually first.',
    sourceUpdatedHint: 'Source tree updated to {commit} — restart DSH to apply',
    sourceUpToDateHint: 'Source tree already up to date',
    // PowerShell 7 一键安装（Windows）
    pwshWinOnly: 'One-click PowerShell 7 install is only supported on Windows',
    pwshInstalling: 'Installing PowerShell 7 (pwsh)…',
    pwshWinget: 'Installing PowerShell 7 via winget…',
    pwshMsi: 'winget unavailable — installing PowerShell 7 via the official MSI…',
    pwshMsiNoRelease: 'Could not fetch the latest PowerShell release info',
    pwshMsiNoAsset: 'No win-x64 MSI asset found',
    pwshMsiDownload: 'Downloading {file} …',
    pwshMsiDownloadFail: 'PowerShell 7 installer download failed',
    pwshMsiInstall: 'Running the silent MSI install (admin rights may be required)…',
    pwshInstalled: '✅ PowerShell 7 installed — restart DSH to apply',
    pwshInstallFail: 'PowerShell 7 install failed (admin rights may be required): ',
    pwshInstallTimeout: 'Timed out waiting for pwsh — check the install result and restart DSH',
    // staged 更新（Windows 运行实例 EBUSY 防护）
    updateStaging: 'Staging v{version} into a temp dir (the running deployment is left untouched, avoiding EBUSY)…',
    updateStagingVerify: 'Verifying the staged package…',
    updateStagingFail: 'Staging install failed: {err}',
    updateFinisher: 'New version ready — starting the update finisher: DSH will exit and restart itself to finish…',
    deployBrokenWarn: '⚠️ The deployment directory is incomplete (possibly an interrupted update) — DSH may fail to start after a restart. Click "Repair deployment" to reinstall the current version.',
    repairBtn: 'Repair deployment (reinstall current version)',
    repairRunning: 'Repairing the deployment… (DSH restarts automatically when done)',
    repairDone: '✅ Deployment repaired — DSH is about to restart',
    repairFail: 'Deployment repair failed: ',
    busySync: 'A docs sync is already in progress, please retry later',
    docsDisabled: 'Docs sync is off — enable the "Sync official docs" switch in Settings first.',
    fetchingList: 'Fetching official docs list…',
    syncFail: 'Sync failed: {err}',
    syncDone: 'Sync complete: {synced} updated / {skipped} unchanged / {failed} failed',
    searchToolDesc: 'Search the local index of the official DeepSeek Harness (DSH) documentation. The index is synced from deepseek-ai/deepseek-harness docs/ by the dsh-updater-npm plugin. Returns ranked file hits with path, title, headings and a short excerpt; then use dsh_docs_read to fetch the full content. Chinese docs end with .zh.md and are preferred automatically when the query contains CJK.',
    readToolDesc: 'Read the full content of one local DeepSeek Harness (DSH) official document from the synced docs index. Pass the exact path returned by dsh_docs_search (e.g. "docs/user/develop/basic/tool.md"), or a unique basename like "tool.md". Optionally pass section to focus on one heading (case-insensitive substring). Returns the document markdown content, truncated at 80KB.',
    noMatchResult: '(no matches)',
    searchHead: 'DSH doc search "{query}": {total} hits, showing {shown}',
    readFailHead: 'Read failed: {err}',
    readHead: 'DSH doc {path}{section}{size}{truncated}',
    readSection: ' section "{section}"',
    readChars: ' ({n} chars',
    readTruncated: ', truncated',
    toolsRegistered: '[dsh-updater-npm] Registered doc tools dsh_docs_search / dsh_docs_read',
    toolsRegisterFail: '[dsh-updater-npm] Tool registration failed: {err}',
    docsFirstSyncDone: '[dsh-updater-npm] First official docs sync complete: {n} files',
  },
}

/** 读取系统环境语言：环境变量优先，其次 Intl 默认区域，非中文一律回退英文。 */
function detectSystemLang() {
  for (const v of [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]) {
    if (v) {
      const m = /^([a-z]{2})/i.exec(String(v))
      if (m) return m[1].toLowerCase() === 'zh' ? 'zh' : 'en'
    }
  }
  try {
    const loc = String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase()
    const prim = loc.split('-')[0]
    if (prim === 'zh' || prim === 'en') return prim
  } catch (e) { /* ignore */ }
  return 'en'
}

const SYSTEM_LANG = detectSystemLang()

/** 路由层：客户端 ?uilang= 覆盖，否则用系统语言。 */
function uiLang(reqLang) {
  const l = String(reqLang || '').toLowerCase()
  return l === 'zh' ? 'zh' : l === 'en' ? 'en' : SYSTEM_LANG
}

/** 取字典文案并做 {key} 占位符替换；未指定语言时回退系统语言。 */
function tr(lang, key, params) {
  const L = lang === 'en' ? 'en' : lang === 'zh' ? 'zh' : SYSTEM_LANG
  const dict = L === 'en' ? HOST_I18N.en : HOST_I18N.zh
  let s = dict[key]
  if (s === undefined) s = HOST_I18N.zh[key] !== undefined ? HOST_I18N.zh[key] : key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split('{' + k + '}').join(String(v))
    }
  }
  return s
}

/** 读取 JSON 文件，失败返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

/** 安全写 JSON（先建目录，UTF-8）。 */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 安全写文本（先建目录，UTF-8）。 */
function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

// ────────────────────────────────────────────────────────────────────────────
// 官方文档同步
// ────────────────────────────────────────────────────────────────────────────

const DOCS_REPO = 'deepseek-ai/deepseek-harness'
const DOCS_BRANCH = 'master'
const GITHUB_API = 'https://api.github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const UA_HEADERS = {
  'User-Agent': 'dsh-updater-npm',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

/** $DSH_HOME 或默认 ~/.dsh。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 本地文档根目录。 */
function docsRoot() {
  return join(dshHome(), 'docs-sync')
}

/** 索引文件路径。 */
function indexFile() {
  return join(docsRoot(), '.index.json')
}

/** 插件数据目录。 */
function pluginDataDir() {
  return join(dshHome(), 'plugin-data', 'dsh-updater-npm')
}

/** 插件配置文件路径。 */
function docsConfigFile() {
  return join(pluginDataDir(), 'config.json')
}

/** 读取插件配置（默认文档同步关闭）。 */
function readDocsConfig() {
  const cfg = readJson(docsConfigFile())
  return { docsEnabled: !!(cfg && cfg.docsEnabled) }
}

/** 写插件配置。 */
function writeDocsConfig(cfg) {
  writeJson(docsConfigFile(), cfg)
}

/** 带超时的 fetch，返回 { ok, status, json, text, error }。 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      return { ok: false, status: res.status, json: null, text: null, error: 'HTTP ' + String(res.status) }
    }
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (e) { /* 非 JSON */ }
    return { ok: true, status: res.status, json, text, error: null }
  } catch (e) {
    return { ok: false, status: 0, json: null, text: null, error: String((e && e.message) || e) }
  }
}

/**
 * 获取官方 docs 的文件清单（仅 markdown）。
 * @returns {Promise<{ref: string, files: Array<{path, sha, size}>, error: string|null}>}
 */
async function fetchDocsTree(lang) {
  // 1) head commit sha（raw URL 用）
  const head = await fetchWithTimeout(`${GITHUB_API}/repos/${DOCS_REPO}/commits/${DOCS_BRANCH}`, { headers: UA_HEADERS })
  if (!head.ok) return { ref: null, files: [], error: tr(lang, 'headCommitFail', { err: head.error || '' }) }
  const ref = head.json && head.json.sha ? String(head.json.sha) : DOCS_BRANCH

  // 2) 递归 tree（已验证不截断），过滤 docs/*.md
  const tree = await fetchWithTimeout(`${GITHUB_API}/repos/${DOCS_REPO}/git/trees/${DOCS_BRANCH}?recursive=1`, { headers: UA_HEADERS }, 20000)
  if (!tree.ok) return { ref, files: [], error: tr(lang, 'treeFail', { err: tree.error || '' }) }
  const data = tree.json
  if (!data || !Array.isArray(data.tree)) return { ref, files: [], error: tr(lang, 'treeBad') }
  const files = data.tree
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string' && entry.path.startsWith('docs/') && entry.path.endsWith('.md'))
    .map((entry) => ({ path: entry.path, sha: String(entry.sha || ''), size: Number(entry.size) || 0 }))
  return { ref, files, error: null }
}

/** 从 markdown 提取标题、标题树、摘要、语言。 */
function analyzeMarkdown(text, path) {
  const lines = text.split(/\r?\n/)
  const headings = []
  let title = ''
  for (const line of lines) {
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      const heading = m[2].trim()
      if (title === '' && m[1].length === 1) title = heading
      headings.push(heading)
    } else if (title === '' && line.trim() !== '' && !line.startsWith('<!--')) {
      // 无 h1 时用首个非空行作标题
      title = line.trim().slice(0, 120)
    }
  }
  // 摘要：剥掉 markdown 语法，取正文前若干字符
  const plain = lines
    .map((line) => line.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s+/, '').replace(/[*_~>|-]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
  const excerpt = plain.slice(0, 500)
  const lang = /\.zh\.md$/i.test(path) ? 'zh' : 'en'
  return { title: title || basename(path, extname(path)), headings, excerpt, lang }
}

/** 重建本地索引（扫描 docs 根目录下的 markdown）。 */
function rebuildIndex() {
  const root = docsRoot()
  const entries = []
  if (existsSync(root)) {
    const walk = (dir) => {
      let names = []
      try { names = readdirSync(dir) } catch (e) { return }
      for (const name of names) {
        if (name === '.index.json') continue
        const full = join(dir, name)
        let st
        try { st = statSync(full) } catch (e) { continue }
        if (st.isDirectory()) walk(full)
        else if (name.endsWith('.md')) {
          const rel = resolve(full).slice(root.length).replace(/\\/g, '/').replace(/^\//, '')
          try {
            const text = readFileSync(full, 'utf8')
            const meta = analyzeMarkdown(text, rel)
            entries.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs, ...meta })
          } catch (e) { /* 跳过不可读文件 */ }
        }
      }
    }
    walk(root)
  }
  const index = {
    version: 1,
    updatedAt: Date.now(),
    sourceRef: indexSourceRef(),
    count: entries.length,
    files: entries,
  }
  writeJson(indexFile(), index)
  return index
}

/** 读取索引中的 sourceRef。 */
function indexSourceRef() {
  const idx = readJson(indexFile())
  return idx && typeof idx.sourceRef === 'string' ? idx.sourceRef : null
}

/** 读取本地索引（无则返回 null）。 */
function readIndex() {
  const idx = readJson(indexFile())
  if (idx && Array.isArray(idx.files)) return idx
  return null
}

/**
 * 同步官方文档到本地（增量）。
 * @returns {Promise<{ok, synced, skipped, failed, total, ref, error?, syncedAt}>}
 */
async function syncDocs(onProgress = null, lang = SYSTEM_LANG) {
  const { ref, files, error } = await fetchDocsTree(lang)
  if (error !== null) return { ok: false, error }
  if (files.length === 0) return { ok: false, error: tr(lang, 'docsListEmpty') }
  if (onProgress) onProgress({ phase: 'downloading', done: 0, total: files.length, current: '', message: tr(lang, 'downloadStart', { n: files.length }) })

  // 旧索引：path → sha
  const old = readIndex()
  const known = {}
  if (old) for (const f of old.files || []) known[f.path] = f.sha || ''

  const root = docsRoot()
  let synced = 0
  let skipped = 0
  let failed = 0
  const failures = []

  // 并发下载池
  const concurrency = 6
  let cursor = 0
  const worker = async () => {
    while (true) {
      const i = cursor
      cursor += 1
      if (i >= files.length) return
      const file = files[i]
      if (onProgress) onProgress({ phase: 'downloading', done: cursor, total: files.length, current: file.path, message: tr(lang, 'downloading', { done: cursor, total: files.length }) })
      const target = join(root, ...file.path.split('/'))
      if (known[file.path] === file.sha && existsSync(target)) {
        skipped += 1
        continue
      }
      const raw = await fetchWithTimeout(`${GITHUB_RAW}/${DOCS_REPO}/${ref}/${file.path}`, {}, 20000)
      if (!raw.ok) {
        failed += 1
        if (failures.length < 10) failures.push(file.path + ' (' + (raw.error || '') + ')')
        continue
      }
      try {
        writeText(target, raw.text || '')
        synced += 1
      } catch (e) {
        failed += 1
        if (failures.length < 10) failures.push(file.path + ' (' + tr(lang, 'writeFail') + ')')
      }
    }
  }
  const workers = []
  for (let w = 0; w < concurrency; w += 1) workers.push(worker())
  await Promise.all(workers)

  // 清理本地多余文件（上次同步有、这次没有的 md）
  if (old) {
    const current = new Set(files.map((f) => f.path))
    for (const f of old.files || []) {
      if (current.has(f.path)) continue
      const target = join(root, ...f.path.split('/'))
      try { if (existsSync(target)) rmSync(target) } catch (e) { /* 忽略 */ }
    }
  }

  // 重建索引并记录 ref（把 GitHub blob sha 合并进条目，供下次增量跳过）
  if (onProgress) onProgress({ phase: 'indexing', done: files.length, total: files.length, current: '', message: tr(lang, 'rebuildingIndex') })
  try {
    const shaMap = {}
    for (const f of files) shaMap[f.path] = f.sha
    const index = rebuildIndex()
    for (const entry of index.files) entry.sha = shaMap[entry.path] || ''
    index.sourceRef = ref
    index.syncedAt = Date.now()
    writeJson(indexFile(), index)
  } catch (e) {
    return { ok: true, synced, skipped, failed, total: files.length, ref, error: tr(lang, 'indexRebuildFail', { err: String((e && e.message) || e) }) }
  }

  return { ok: true, synced, skipped, failed, total: files.length, ref, failures, syncedAt: Date.now() }
}

/** 文档同步状态。 */
function docsStatus() {
  const idx = readIndex()
  const root = docsRoot()
  let fileCount = 0
  let sizeBytes = 0
  try {
    const walk = (dir) => {
      let names = []
      try { names = readdirSync(dir) } catch (e) { return }
      for (const name of names) {
        const full = join(dir, name)
        let st
        try { st = statSync(full) } catch (e) { continue }
        if (st.isDirectory()) walk(full)
        else if (name.endsWith('.md')) { fileCount += 1; sizeBytes += st.size }
      }
    }
    if (existsSync(root)) walk(root)
  } catch (e) { /* 保持默认值 */ }
  const zh = idx ? (idx.files || []).filter((f) => f.lang === 'zh').length : 0
  return {
    ok: idx !== null,
    syncedAt: idx && idx.syncedAt ? idx.syncedAt : null,
    sourceRef: idx && idx.sourceRef ? idx.sourceRef : null,
    count: idx ? idx.count : fileCount,
    en: idx ? (idx.count || 0) - zh : 0,
    zh,
    sizeBytes,
    root,
    indexed: idx !== null && (idx.count || 0) > 0,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 本地文档搜索 / 读取
// ────────────────────────────────────────────────────────────────────────────

/** 简单分词：英文单词 + CJK 连续片段（片段整体 + 逐字，保证短语与单字都能命中）。 */
function tokenize(text) {
  const tokens = []
  const re = /[A-Za-z0-9_]+|[\u3400-\u9fff\u3040-\u30ff]+/g
  let m
  while ((m = re.exec(text)) !== null) {
    const tok = m[0].toLowerCase()
    tokens.push(tok)
    if (tok.length > 1 && /[\u3400-\u9fff\u3040-\u30ff]/.test(tok)) {
      for (const ch of tok) tokens.push(ch)
    }
  }
  return tokens
}

function hasCJK(text) {
  return /[\u3400-\u9fff\u3040-\u30ff]/.test(text)
}

/** 本地索引搜索。lang 为文档语言过滤（auto/en/zh），uilang 为界面语言。 */
function searchDocs(query, lang = 'auto', limit = 8, uilang) {
  const idx = readIndex()
  if (!idx) return { ok: false, error: tr(uilang, 'docsNotSynced'), results: [] }
  const q = String(query || '').trim()
  if (q === '') return { ok: false, error: tr(uilang, 'emptyQuery'), results: [] }
  const qLower = q.toLowerCase()
  const qTokens = tokenize(q)
  const preferZh = lang === 'zh' || (lang === 'auto' && hasCJK(q))
  const cap = Math.max(1, Math.min(20, Number(limit) || 8))

  const scored = []
  for (const f of idx.files || []) {
    if (lang === 'en' && f.lang !== 'en') continue
    if (lang === 'zh' && f.lang !== 'zh') continue
    let score = 0
    const pathLower = f.path.toLowerCase()
    const titleLower = String(f.title || '').toLowerCase()
    const headingText = (f.headings || []).join(' ').toLowerCase()
    const excerptLower = String(f.excerpt || '').toLowerCase()

    if (pathLower.includes(qLower)) score += 3
    if (titleLower.includes(qLower)) score += 4
    if (qTokens.length > 0) {
      for (const t of qTokens) {
        if (titleLower.includes(t)) score += 3
        else if (pathLower.includes(t)) score += 2
        else if (headingText.includes(t)) score += 1.5
        else if (excerptLower.includes(t)) score += 1
      }
    }
    if (score <= 0) continue
    // 自动语言偏好：命中查询语言的文档加权
    if (lang === 'auto') score *= f.lang === (preferZh ? 'zh' : 'en') ? 1.2 : 1.0
    scored.push({
      path: f.path,
      title: f.title || f.path,
      lang: f.lang,
      score: Math.round(score * 100) / 100,
      headings: (f.headings || []).slice(0, 12),
      excerpt: (f.excerpt || '').slice(0, 260),
    })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return { ok: true, query: q, lang: preferZh ? 'zh' : 'en', total: scored.length, results: scored.slice(0, cap) }
}

/**
 * 安全地把用户给的路径解析到本地 docs 根下的文件。
 * 支持完整相对路径（docs/...、去掉 docs/ 前缀、带/不带 .md）以及 basename 唯一匹配。
 */
function resolveDocPath(input) {
  const root = docsRoot()
  const idx = readIndex()
  let p = String(input || '').trim().replace(/\\/g, '/')
  p = p.replace(/^\.?\//, '').replace(/^docs\//, '').replace(/^\.md$/, '')
  const candidates = []
  candidates.push(p)
  if (!p.endsWith('.md')) candidates.push(p + '.md')
  for (const c of candidates) {
    const abs = resolve(root, c)
    if (abs.startsWith(root + sep) || abs === root) {
      if (existsSync(abs) && statSync(abs).isFile()) return abs
    }
  }
  // basename 唯一匹配（对 zh/en 双语文档友好）
  const base = basename(p, extname(p))
  if (idx && Array.isArray(idx.files)) {
    const matches = idx.files.filter((f) => basename(f.path, '.md') === base || f.path.endsWith('/' + p) || f.path === p)
    if (matches.length === 1) return join(root, ...matches[0].path.split('/'))
  }
  return null
}

/** 读取一篇文档，可选按章节聚焦。 */
function readDoc(input, section, uilang) {
  const file = resolveDocPath(input)
  if (file === null) return { ok: false, error: tr(uilang, 'docNotFound', { path: String(input || '') }) }
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { return { ok: false, error: tr(uilang, 'readFail', { err: String((e && e.message) || e) }) } }
  const rel = resolve(file).slice(docsRoot().length).replace(/\\/g, '/').replace(/^\//, '')
  const meta = analyzeMarkdown(text, rel)
  let content = text
  let matched = null
  const cap = 80000
  if (section && section.trim() !== '') {
    const lines = text.split(/\r?\n/)
    const want = section.trim().toLowerCase()
    let start = -1
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i])
      if (m && m[2].trim().toLowerCase().includes(want)) { start = i; break }
    }
    if (start >= 0) {
      matched = lines[start].replace(/^#{1,6}\s+/, '')
      const level = /^\s{0,3}(#{1,6})/.exec(lines[start])[1].length
      let end = lines.length
      for (let i = start + 1; i < lines.length; i += 1) {
        const m = /^\s{0,3}(#{1,6})\s+/.exec(lines[i])
        if (m && m[1].length <= level) { end = i; break }
      }
      content = lines.slice(start, end).join('\n')
    }
  }
  let truncated = false
  if (content.length > cap) { content = content.slice(0, cap) + tr(uilang, 'truncated'); truncated = true }
  return { ok: true, path: rel, title: meta.title, lang: meta.lang, section: matched, size: content.length, truncated, content }
}

// ────────────────────────────────────────────────────────────────────────────
// 版本比较（更新优化：本地比远端新时不再提示更新）
// ────────────────────────────────────────────────────────────────────────────

/** 解析版本号 "x.y.z(-pre)"，失败返回 null。 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] }
}

/** semver 风格比较：>0 表示 a 比 b 新，<0 表示旧，0 相等。 */
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return String(a).localeCompare(String(b))
  for (let i = 0; i < 3; i += 1) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  if (pa.pre === undefined && pb.pre === undefined) return 0
  if (pa.pre === undefined) return 1 // 正式版 > 预发布
  if (pb.pre === undefined) return -1
  const sa = pa.pre.split('.')
  const sb = pb.pre.split('.')
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    const x = sa[i]
    const y = sb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y)
    if (xn) return 1
    if (yn) return -1
    return x.localeCompare(y)
  }
  return 0
}

// ────────────────────────────────────────────────────────────────────────────
// 更新检查 / npm 升级（多副本保护）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 定位当前运行实例所属 Node 安装的 npm CLI。
 * 运行实例位于 <root>/node_modules/@deepseek-ai/dsh 时，其自带的 npm 是
 * <root>/node_modules/npm/bin/npm-cli.js，用 process.execPath（正在运行 dsh 的
 * node）执行它，`install -g` 只会落到 <root>/node_modules —— 即当前运行副本，
 * 绝不会因 PATH 上的 npm 属于别的 Node 安装而把更新写到别的副本。
 * @returns {{nodeExe: string, npmCli: string, nodeRoot: string, modulesDir: string}|null}
 */
function npmCliFor(installDir) {
  const norm = resolve(installDir)
  const idx = norm.lastIndexOf(sep + '@deepseek-ai')
  // 常规：<root>/node_modules/@deepseek-ai/dsh；兜底：installDir 本身就是 Node 根
  let modulesDir = null
  if (idx >= 0) modulesDir = norm.slice(0, idx)                            // ...\node_modules
  else if (existsSync(join(norm, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) modulesDir = join(norm, 'node_modules')
  if (modulesDir === null) return null
  const nodeRoot = dirname(modulesDir)                                     // Node 安装根
  const npmCli = join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) return null
  return { nodeExe: process.execPath, npmCli, nodeRoot, modulesDir }
}

/** 解析 junction/symlink 到真实路径（失败时回退原路径）。 */
function realPathOf(p) {
  try { return realpathSync(p) } catch (e) { return resolve(p) }
}

/** 从 PATH 收集所有 Node 安装根目录（含 node.exe / node 的目录）。 */
function pathNodeRoots() {
  const roots = new Set()
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const entry of String(process.env.PATH || '').split(delimiter)) {
    const dir = String(entry || '').trim()
    if (dir === '') continue
    try { if (existsSync(join(dir, exe))) roots.add(resolve(dir)) } catch (e) { /* 忽略 */ }
  }
  return [...roots]
}

/** PATH 上能解析到的 npm 全局根（node_modules 目录集合）。 */
function pathNpmGlobalRoots() {
  const roots = new Set()
  for (const r of pathNodeRoots()) {
    if (existsSync(join(r, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) roots.add(join(r, 'node_modules'))
  }
  return [...roots]
}

/**
 * 检测用户环境中的其他 @deepseek-ai/dsh 副本（排除当前运行实例）。
 * 按「node_modules 候选目录」扫描：当前实例所属 Node 安装、PATH 上所有
 * Node 安装的全局目录、DSH profiles（共享 node_modules 与各 profile）。
 * 用 realpath 去重：junction/symlink 解析后与运行实例同一物理目录的不计入
 * 副本（例如 profiles\node_modules 里指向运行实例的联接镜像）。
 * @returns {Array<{path: string, version: string|null}>}
 */
function detectOtherCopies(installDir) {
  const copies = []
  const seen = new Set([realPathOf(installDir)])
  const modules = new Set()
  const own = npmCliFor(installDir)
  if (own !== null) modules.add(own.modulesDir)
  for (const r of pathNodeRoots()) modules.add(join(r, 'node_modules'))
  const profilesDir = join(dshHome(), 'profiles')
  try {
    for (const name of readdirSync(profilesDir)) {
      modules.add(join(profilesDir, name))                    // profiles/node_modules
      modules.add(join(profilesDir, name, 'node_modules'))    // profiles/web/node_modules
    }
  } catch (e) { /* 目录不存在时忽略 */ }
  for (const m of modules) {
    const dir = resolve(m, '@deepseek-ai', 'dsh')
    if (!existsSync(join(dir, 'package.json'))) continue
    const real = realPathOf(dir)
    if (seen.has(real)) continue                              // 指向运行实例的联接 → 跳过
    seen.add(real)
    const p = readJson(join(dir, 'package.json'))
    copies.push({ path: real, version: p !== null && typeof p.version === 'string' ? p.version : null })
  }
  return copies
}

/**
 * 定位 @deepseek-ai/dsh 的安装目录，并识别运行模式。
 * 模式：
 *  - 'source'：源码树运行（argv[1] 是 apps/cli/src/bin.ts / bin.ts / 含 tsx），
 *    installDir = 仓库根（含 pnpm-workspace.yaml 的目录）。npm -g 更新不影响它，
 *    必须 git pull 才能升级运行实例。
 *  - 'npm-global'：npm 全局安装运行（argv[1] 是 <install>/lib/bin.js），
 *    installDir = 包安装目录，npm install -g 直接生效。
 * 回退：cordis preset 路径反推（视为 npm-global）。
 * @returns {Promise<{installDir: string, mode: 'source'|'npm-global'}|null>}
 */
async function locateInstall(ctx) {
  const argv1 = process.argv[1]
  if (argv1 !== undefined) {
    const a = String(argv1).replace(/\\/g, '/')
    // 源码树模式：bin.ts / tsx / apps/ 特征
    if (/bin\.ts$/.test(a) || a.includes('/apps/') || a.includes('tsx')) {
      // 从 argv[1]（可能相对 cwd）上溯找仓库根：含 pnpm-workspace.yaml 的目录
      const abs = a.startsWith('/') || /^[a-zA-Z]:/.test(a) ? a : join(process.cwd(), a)
      let dir = dirname(abs)
      for (let i = 0; i < 6; i += 1) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'package.json'))) {
          return { installDir: dir, mode: 'source' }
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      // 找不到 workspace 标志，退回 cwd 或 npm-global 反推
      if (existsSync(join(process.cwd(), 'package.json'))) return { installDir: process.cwd(), mode: 'source' }
    } else if (/bin\.js$/.test(a)) {
      const install = dirname(dirname(argv1))
      if (existsSync(join(install, 'package.json'))) return { installDir: install, mode: 'npm-global' }
    }
  }
  try {
    const list = await ctx.agentPresets.list()
    const preset = list.find((p) => p.id === 'cordis') || list[0]
    if (preset === undefined || preset === null) return null
    const suffix = '/agent-presets/' + preset.id + '/agent.cordis.yml'
    const normalized = String(preset.path).replace(/\\/g, '/')
    if (normalized.endsWith(suffix)) {
      const configDir = normalized.slice(0, -suffix.length)
      const install = configDir.replace(/\/config$/, '')
      if (existsSync(join(install, 'package.json'))) return { installDir: install, mode: 'npm-global' }
    }
  } catch (e) { /* 回退失败 */ }
  return null
}

/** 读本地版本。 */
function localVersionOf(installDir) {
  const pkg = readJson(join(installDir, 'package.json'))
  return pkg !== null && typeof pkg.version === 'string' ? pkg.version : null
}

/** 查 npm registry 最新版本。 */
async function remoteVersionOf() {
  try {
    const res = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest', { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { version: null, error: 'registry HTTP ' + String(res.status) }
    const json = await res.json()
    return {
      version: json !== null && typeof json === 'object' && typeof json.version === 'string' ? json.version : null,
      error: null,
    }
  } catch (e) {
    return { version: null, error: String((e && e.message) || e) }
  }
}

/** 秒 → "42s" / "1m 23s" 展示。 */
function formatSec(total) {
  const s = Math.max(0, Math.floor(total))
  if (s < 60) return String(s) + 's'
  return Math.floor(s / 60) + 'm ' + String(s % 60) + 's'
}

/**
 * 执行 npm 全局升级（多副本保护）：
 *  - 优先用当前运行实例所属 Node 安装自带的 npm CLI（<root>/node_modules/npm/bin/npm-cli.js），
 *    只更新当前运行副本；找不到才退回 PATH 上的 npm；
 *  - 以 --loglevel=http 运行：npm 在非 TTY/管道下默认几乎不输出流式日志（进度条是
 *    TTY 专属、fetch 行在 notice 级别被隐藏），界面会长时间"无进度"；http 级别让
 *    每条 fetch 实时落到 stderr 管道，配合 5s 心跳保证进度区持续滚动；
 *  - 完成后回读「当前运行副本」的版本做校验：若 expectUpdate 为真但版本没变，
 *    说明更新落到了别的副本（或该副本不由这个 npm 管理），返回 warning 而不是假成功。
 */
function runNpmUpdate(installDir, beforeVersion, onProgress = null, uilang, expectUpdate = false) {
  return new Promise((resolve) => {
    const own = npmCliFor(installDir)
    const base = ['install', '-g', '@deepseek-ai/dsh@latest', '--no-audit', '--no-fund', '--loglevel=http', '--progress=false']
    const cmd = own !== null
      ? { kind: 'own', argv: [own.nodeExe, own.npmCli, ...base] }
      : { kind: 'path', argv: ['npm', ...base] }
    let child
    try {
      child = spawn(cmd.argv[0], cmd.argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: cmd.kind === 'path' && process.platform === 'win32',
      })
    } catch (e) {
      resolve({ ok: false, error: tr(uilang, 'npmSpawnFail', { err: String((e && e.message) || e) }) })
      return
    }
    let stdout = ''
    let stderr = ''
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    const timer = setTimeout(() => {
      try { child.kill() } catch (e) { /* already gone */ }
    }, 900000)
    const pushProgress = () => {
      if (onProgress) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-4).join('\n')
        const baseMsg = tr(uilang, cmd.kind === 'own' ? 'npmRunningOwn' : 'npmRunning')
        onProgress({
          phase: 'running', done: 0, total: 0, current: '',
          message: baseMsg + ' · ' + tr(uilang, 'progressElapsed', { sec: formatSec(elapsed) }),
          detail, elapsed,
        })
      }
    }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8192); lastOutputAt = Date.now(); pushProgress() })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); lastOutputAt = Date.now(); pushProgress() })
    // 心跳：长时间无输出（如网络等待）时也上报一次，保证界面进度区始终有活动
    const heartbeat = setInterval(() => {
      if (Date.now() - lastOutputAt >= 5000) pushProgress()
    }, 5000)
    child.on('error', (e) => {
      clearTimeout(timer)
      clearInterval(heartbeat)
      resolve({ ok: false, error: tr(uilang, 'npmExecFail', { err: String((e && e.message) || e) }) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearInterval(heartbeat)
      const afterVersion = localVersionOf(installDir)
      const updated = code === 0 && afterVersion !== null && afterVersion !== beforeVersion
      let warning = null
      let hint = null
      if (code === 0) {
        if (updated) {
          hint = tr(uilang, 'updatedHint', { version: afterVersion })
        } else if (expectUpdate) {
          // npm 成功但当前运行副本没变 → 更新很可能落到了别的副本
          warning = tr(uilang, 'updateNoEffect', { before: String(beforeVersion), after: String(afterVersion) })
        } else {
          hint = tr(uilang, 'upToDateHint')
        }
      }
      if (onProgress) onProgress({ phase: 'done', done: 1, total: 1, current: '', message: code === 0 ? tr(uilang, 'updateDone') : tr(uilang, 'updateFailed'), detail: (stderr || stdout).trim().slice(-400) })
      resolve({
        ok: code === 0,
        beforeVersion,
        version: afterVersion,
        updated,
        needsRestart: updated,
        warning,
        usedNpm: cmd.kind,
        npmCli: own !== null ? own.npmCli : null,
        stdout: stdout.trim().slice(-600),
        stderr: stderr.trim().slice(-600),
        error: code !== 0 ? (stderr.trim().slice(-400) || tr(uilang, 'npmExitCode', { code: String(code) })) : null,
        hint,
      })
    })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// 模型工具：dsh_docs_search / dsh_docs_read
// ────────────────────────────────────────────────────────────────────────────

/** 从安装目录动态加载 dsh-tools 的 defineTool（兼容 npm 提升/嵌套两种布局）。 */
async function loadDefineTool(installDir) {
  try {
    const req = createRequire(join(installDir, 'package.json'))
    const toolsPath = req.resolve('@deepseek-ai/dsh-tools')
    const mod = await import(pathToFileURL(toolsPath).href)
    if (typeof mod.defineTool === 'function') return mod.defineTool
    return null
  } catch (e) {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 源码树（git）更新
// ────────────────────────────────────────────────────────────────────────────

const GIT_TIMEOUT = 60000

/** 在指定目录执行 git 命令，收集 stdout/stderr（可选实时进度回调）。 */
function runGit(dir, args, onProgress = null) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String((e && e.message) || e) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch (e) { /* already gone */ } }, GIT_TIMEOUT)
    const push = () => {
      if (onProgress) onProgress((stdout + stderr).trim().split(/\r?\n/).slice(-4).join('\n'))
    }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8192); push() })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); push() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, stdout, stderr: String((e && e.message) || e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }) })
  })
}

/**
 * 检测 git 是否已安装（可执行）。spawn 报 ENOENT / 命令不存在 → 未安装。
 */
async function gitAvailable() {
  const v = await runGit(process.cwd(), ['--version'])
  if (v.ok) return true
  const msg = String(v.stderr || '').toLowerCase()
  const isMissing = v.code === -1 && /enoent|not recognized|not found|不是内部或外部命令|spawn git/i.test(msg)
  return !isMissing
}

/**
 * 读取源码树 git 信息（不 fetch）：仓库根、分支、本地提交、远端名、工作区是否脏。
 * @returns {Promise<{root, branch, localHead, remote, dirty}|null>}
 */
async function gitInfo(installDir) {
  const top = await runGit(installDir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return null
  const root = top.stdout.trim()
  const [branchR, headR, remoteR, stR] = await Promise.all([
    runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(root, ['rev-parse', 'HEAD']),
    runGit(root, ['remote']),
    runGit(root, ['status', '--porcelain']),
  ])
  return {
    root,
    branch: branchR.ok ? branchR.stdout.trim() : null,
    localHead: headR.ok ? headR.stdout.trim().slice(0, 7) : null,
    remote: remoteR.ok ? remoteR.stdout.trim().split(/\r?\n/).filter(Boolean)[0] || null : null,
    dirty: stR.ok ? stR.stdout.trim() !== '' : false,
  }
}

/** fetch 远端并计算 ahead/behind 与远端提交。 */
async function gitRemoteState(info) {
  const remote = info.remote || 'origin'
  const fetch = await runGit(info.root, ['fetch', remote])
  if (!fetch.ok) return null
  const ref = remote + '/' + (info.branch || 'HEAD')
  const [behindR, aheadR, headR] = await Promise.all([
    runGit(info.root, ['rev-list', '--count', 'HEAD..' + ref]),
    runGit(info.root, ['rev-list', '--count', ref + '..HEAD']),
    runGit(info.root, ['rev-parse', ref]),
  ])
  return {
    behind: behindR.ok ? Number(behindR.stdout.trim() || 0) : null,
    ahead: aheadR.ok ? Number(aheadR.stdout.trim() || 0) : null,
    remoteHead: headR.ok ? headR.stdout.trim().slice(0, 7) : null,
  }
}

/** 在源码树安装依赖：有 pnpm 锁/工作区用 pnpm，否则 npm。 */
function runDepsInstall(root, onProgress) {
  const usePnpm = existsSync(join(root, 'pnpm-lock.yaml')) || existsSync(join(root, 'pnpm-workspace.yaml'))
  const cmd = usePnpm ? 'pnpm' : 'npm'
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, ['install'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: { ...process.env, CI: 'true' },
      })
    } catch (e) {
      resolve({ ok: false, cmd, error: String((e && e.message) || e) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch (e) { /* already gone */ } }, 10 * 60 * 1000)
    const push = () => {
      if (onProgress) onProgress((stdout + stderr).trim().split(/\r?\n/).slice(-4).join('\n'))
    }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8192); push() })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); push() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, cmd, error: String((e && e.message) || e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, cmd, code, detail: (stderr || stdout).trim().slice(-400) }) })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// PowerShell 7（pwsh）检测与一键安装（Windows）
// ────────────────────────────────────────────────────────────────────────────

const PWSH_WIN_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

/** 检测某个命令是否在 PATH 上（where/which）。 */
function commandAvailable(name) {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' })
    probe.on('error', () => resolve(false))
    probe.on('close', (code) => resolve(code === 0))
  })
}

/**
 * 检测 pwsh 是否已安装：优先检查标准安装路径（当前进程的 PATH 看不到新装的
 * pwsh，所以文件存在即算已装），否则查 PATH。非 Windows 返回 null（不检测）。
 */
async function pwshInstalledCheck() {
  if (process.platform !== 'win32') return null
  try { if (existsSync(PWSH_WIN_PATH)) return true } catch (e) { /* 忽略 */ }
  return commandAvailable('pwsh')
}

/** 执行一条安装命令（winget / msiexec），流式回传输出尾部。 */
function runInstallCmd(argv, onProgress, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e), detail: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    const timer = setTimeout(() => { try { child.kill() } catch (e) { /* already gone */ } }, timeoutMs)
    const push = () => {
      if (onProgress) onProgress((stdout + stderr).trim().split(/\r?\n/).slice(-4).join('\n'))
    }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8192); lastOutputAt = Date.now(); push() })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); lastOutputAt = Date.now(); push() })
    // 心跳：静默安装（如 msiexec /qn）长时间无输出时仍上报活动状态
    const heartbeat = setInterval(() => {
      if (Date.now() - lastOutputAt < 5000) return
      if (onProgress) {
        const elapsed = formatSec((Date.now() - startedAt) / 1000)
        const tail = (stdout + stderr).trim().split(/\r?\n/).slice(-3).join('\n')
        onProgress((tail === '' ? '' : tail + '\n') + '[still running ' + elapsed + ']')
      }
    }, 5000)
    child.on('error', (e) => { clearTimeout(timer); clearInterval(heartbeat); resolve({ ok: false, error: String((e && e.message) || e), detail: (stderr || stdout).trim().slice(-400) }) })
    child.on('close', (code) => { clearTimeout(timer); clearInterval(heartbeat); resolve({ ok: code === 0, code, detail: (stderr || stdout).trim().slice(-400), stdout: stdout.trim().slice(-600), stderr: stderr.trim().slice(-600) }) })
  })
}

/** 下载二进制文件（MSI）到本地。 */
async function downloadBinary(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!res.ok) return false
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return true
}

/** 通过官方 GitHub Release 的 win-x64 MSI 静默安装 PowerShell 7。 */
async function installPwshMsi(uilang, push) {
  push(tr(uilang, 'pwshMsi'), '')
  const rel = await fetchWithTimeout('https://api.github.com/repos/PowerShell/PowerShell/releases/latest', { headers: UA_HEADERS }, 20000)
  if (!rel.ok || !rel.json) return { ok: false, error: tr(uilang, 'pwshMsiNoRelease') }
  const asset = (rel.json.assets || []).find((a) => /^PowerShell-\d[\d.]*-win-x64\.msi$/i.test(a.name))
  if (!asset) return { ok: false, error: tr(uilang, 'pwshMsiNoAsset') }
  const tmp = join(tmpdir(), asset.name)
  try {
    push(tr(uilang, 'pwshMsiDownload', { file: asset.name }), '')
    if (!(await downloadBinary(asset.browser_download_url, tmp))) return { ok: false, error: tr(uilang, 'pwshMsiDownloadFail') }
    push(tr(uilang, 'pwshMsiInstall'), '')
    const msi = await runInstallCmd(['msiexec', '/i', tmp, '/qn', '/norestart'], (d) => push(tr(uilang, 'pwshMsiInstall'), d))
    return { ok: msi.ok, method: 'msi', detail: msi.detail, error: msi.ok ? null : (msi.detail || tr(uilang, 'pwshInstallFail')) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), detail: '' }
  } finally {
    try { rmSync(tmp, { force: true }) } catch (e) { /* 忽略 */ }
  }
}

/** 安装后轮询 pwsh.exe 是否就绪（最长 ~120s）。 */
async function waitForPwsh(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (existsSync(PWSH_WIN_PATH)) return true } catch (e) { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

// ────────────────────────────────────────────────────────────────────────────
// staged 更新（Windows 运行实例 EBUSY 防护）+ 失败恢复
// ────────────────────────────────────────────────────────────────────────────

/** 检查部署目录关键文件是否完整（npm 包入口 + 清单）。 */
function deploymentBroken(installDir) {
  if (!existsSync(join(installDir, 'package.json'))) return true
  if (!existsSync(join(installDir, 'lib', 'bin.js'))) return true
  return false
}

/**
 * 用运行实例自带 npm 把目标版本安装到独立 staging 目录（--prefix），
 * 完全不触碰部署目录 → Windows 上不会撞 EBUSY。
 * @returns {Promise<{ok, stagingPkg, version, error}>}
 */
async function installStaged(installDir, targetVersion, stagingDir, uilang, push) {
  const own = npmCliFor(installDir)
  const argv = own !== null
    ? [own.nodeExe, own.npmCli, 'install', '--prefix', stagingDir, '--no-save', '--no-audit', '--no-fund', '@deepseek-ai/dsh@' + targetVersion]
    : ['npm', 'install', '--prefix', stagingDir, '--no-save', '--no-audit', '--no-fund', '@deepseek-ai/dsh@' + targetVersion]
  const run = await runInstallCmd(argv, (d) => push(tr(uilang, 'updateStaging', { version: targetVersion }), d), 10 * 60 * 1000)
  if (!run.ok) return { ok: false, error: tr(uilang, 'updateStagingFail', { err: (run.detail || run.error || 'npm') }) }
  const stagingPkg = join(stagingDir, 'node_modules', '@deepseek-ai', 'dsh')
  if (deploymentBroken(stagingPkg)) {
    return { ok: false, error: tr(uilang, 'updateStagingFail', { err: 'staged package incomplete' }) }
  }
  const pj = readJson(join(stagingPkg, 'package.json'))
  const version = pj !== null && typeof pj.version === 'string' ? pj.version : null
  return { ok: true, stagingPkg, version }
}

/**
 * 生成 PowerShell 更新完成器：等待/终止当前 dsh 进程 → 原子替换部署目录
 * （旧目录改名备份，新包移入，校验失败自动恢复旧版）→ 重启 dsh web。
 * @returns 脚本路径
 */
function writeFinisherScript(opts) {
  const { installDir, stagingPkg, currentPid, nodeExe, binJs, extraArgs, logFile } = opts
  const script = join(pluginDataDir(), 'finisher-' + Date.now() + '.ps1')
  const argList = [binJs, ...extraArgs].map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(', ')
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'function Log($m) { try { Add-Content -Path ' + "'" + logFile.replace(/'/g, "''") + "'" + " -Value ((Get-Date -Format o) + ' ' + $m) } catch {} }",
    "Log 'finisher started'",
    // 1) 等待当前 dsh 进程退出（温和等 20s，超时强制终止）
    "$deadline = (Get-Date).AddSeconds(20)",
    'while ((Get-Process -Id ' + currentPid + " -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }",
    'Get-Process -Id ' + currentPid + ' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
    'Start-Sleep -Milliseconds 1000',
    // 2) 校验 staging 新包
    "if (-not (Test-Path '" + stagingPkg.replace(/'/g, "''") + "\\package.json') -or -not (Test-Path '" + stagingPkg.replace(/'/g, "''") + "\\lib\\bin.js')) { Log 'staging invalid, aborting (current install kept)'; exit 1 }",
    // 3) 原子替换 + 失败恢复
    "$old = '" + installDir.replace(/'/g, "''") + ".old-' + [DateTime]::Now.ToString('yyyyMMddHHmmss')",
    'try {',
    "  Rename-Item -Path '" + installDir.replace(/'/g, "''") + "' -NewName $old",
    "  Move-Item -Path '" + stagingPkg.replace(/'/g, "''") + "' -Destination '" + installDir.replace(/'/g, "''") + "'",
    "  if (-not (Test-Path '" + installDir.replace(/'/g, "''") + "\\package.json')) { throw 'post-swap check failed' }",
    "  Remove-Item -Path $old -Recurse -Force -ErrorAction SilentlyContinue",
    "  Log 'swap OK'",
    '} catch {',
    "  Log ('swap failed: ' + $_.Exception.Message + '; restoring old install')",
    "  Remove-Item -Path '" + installDir.replace(/'/g, "''") + "' -Recurse -Force -ErrorAction SilentlyContinue",
    '  Rename-Item -Path $old -NewName ' + "'" + installDir.replace(/'/g, "''") + "'",
    "  Log 'restored old install'",
    '}',
    // 4) 重启 dsh web（原命令行）
    "Log 'restarting dsh'",
    'Start-Process -FilePath ' + "'" + nodeExe.replace(/'/g, "''") + "'" + ' -ArgumentList @(' + argList + ') -WorkingDirectory ' + "'" + dirname(installDir).replace(/'/g, "''") + "'",
  ]
  writeText(script, lines.join('\n'))
  return script
}

/** detached 启动 PowerShell 脚本（主进程退出后继续执行）。 */
function spawnDetached(scriptPath) {
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      stdio: 'ignore',
      detached: true,
      shell: false,
    })
    child.unref()
    return true
  } catch (e) {
    return false
  }
}

/** 注册两个只读文档工具（幂等：注册返回 disposer，由 effect 生命周期清理）。 */
async function registerDocTools(ctx, installDir) {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    console.warn('[dsh-updater-npm] tools 服务不可用，文档工具未注册（插件 inject 应包含 tools）')
    return []
  }
  const defineTool = await loadDefineTool(installDir)
  if (defineTool === null) {
    console.warn('[dsh-updater-npm] 无法从 ' + installDir + ' 解析 @deepseek-ai/dsh-tools，文档工具未注册')
    return []
  }

  const disposers = []
  const searchTool = defineTool({
    name: 'dsh_docs_search',
    description: tr(SYSTEM_LANG, 'searchToolDesc'),
    parameters: {
      query: { type: 'string', required: true, description: 'Search keywords, e.g. "register tool", "插件开发", "cordis service".' },
      lang: { type: 'string', enum: ['auto', 'en', 'zh'], description: 'Language preference: auto (default, prefers zh when the query contains CJK), en, or zh.' },
      limit: { type: 'integer', description: 'Max results to return (default 8, max 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          lang: { type: 'string' },
          total: { type: 'integer', required: true },
          error: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                title: { type: 'string', required: true },
                lang: { type: 'string', required: true },
                score: { type: 'number', required: true },
                headings: { type: 'array', items: { type: 'string' } },
                excerpt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = value.results.map((r) => `- [${r.lang}] ${r.title} (score ${r.score}) ${r.path}`)
        const body = lines.length > 0 ? lines.join('\n') : tr(SYSTEM_LANG, 'noMatchResult')
        return [{ type: 'text', text: tr(SYSTEM_LANG, 'searchHead', { query: value.query, total: value.total, shown: value.results.length }) + '\n' + body }]
      },
    },
    execute(args) {
      const result = searchDocs(args.query, args.lang || 'auto', args.limit || 8)
      // 输出 schema 声明 error 为 string：无错误时省略字段，不能置 null（校验会拒）
      const out = {
        query: result.query || String(args.query || ''),
        lang: result.lang || 'auto',
        total: result.results ? result.results.length : 0,
        results: result.results || [],
      }
      if (result.error) out.error = result.error
      return Promise.resolve(out)
    },
  })
  disposers.push(tools.register(searchTool))

  const readTool = defineTool({
    name: 'dsh_docs_read',
    description: tr(SYSTEM_LANG, 'readToolDesc'),
    parameters: {
      path: { type: 'string', required: true, description: 'Document path from dsh_docs_search results, e.g. "docs/user/develop/basic/tool.md" or a unique basename "tool.md".' },
      section: { type: 'string', description: 'Optional heading substring to focus the returned content on one section.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          title: { type: 'string', required: true },
          lang: { type: 'string' },
          section: { type: 'string' },
          content: { type: 'string', required: true },
          size: { type: 'integer' },
          truncated: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const head = value.error
          ? tr(SYSTEM_LANG, 'readFailHead', { err: value.error })
          : tr(SYSTEM_LANG, 'readHead', {
              path: value.path,
              section: value.section ? tr(SYSTEM_LANG, 'readSection', { section: value.section }) : '',
              size: tr(SYSTEM_LANG, 'readChars', { n: value.size }),
              truncated: value.truncated ? tr(SYSTEM_LANG, 'readTruncated') : '',
            }) + ')'
        return [{ type: 'text', text: head + '\n\n' + String(value.content || '') }]
      },
    },
    execute(args) {
      const result = readDoc(args.path, args.section)
      // section / error 声明为 string：无值时省略字段，不能置 null（校验会拒）
      const out = {
        path: result.path || String(args.path || ''),
        title: result.title || String(args.path || ''),
        lang: result.lang || 'en',
        content: result.content || '',
        size: result.size || 0,
        truncated: !!result.truncated,
      }
      if (result.section) out.section = result.section
      if (result.error) out.error = result.error
      return Promise.resolve(out)
    },
  })
  disposers.push(tools.register(readTool))
  return disposers
}

// ────────────────────────────────────────────────────────────────────────────
// apply
// ────────────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  let cached = null
  let checking = false
  let updating = false
  let syncing = false
  // 文档同步开关（默认关闭）：开启后才自动同步官方文档并注册 dsh_docs 工具
  let docsEnabled = readDocsConfig().docsEnabled
  let toolDisposers = []

  /** 注册文档工具（仅当开关开启且未注册时）。 */
  const registerToolsNow = async () => {
    if (!docsEnabled || toolDisposers.length > 0) return
    const located = await locateInstall(ctx)
    if (located === null) {
      console.warn('[dsh-updater-npm] 无法定位 dsh 安装目录，文档工具未注册')
      return
    }
    const { installDir } = located
    const ds = await registerDocTools(ctx, installDir)
    if (ds.length > 0) {
      toolDisposers = ds
      console.log(tr(SYSTEM_LANG, 'toolsRegistered'))
    }
  }

  /** 注销文档工具。 */
  const unregisterToolsNow = () => {
    toolDisposers.forEach((d) => { try { d() } catch (e) { /* 忽略 */ } })
    toolDisposers = []
  }

  /** 切换文档同步开关：开启 → 注册工具 + 无索引时立即同步；关闭 → 注销工具。 */
  const setDocsEnabled = async (enable) => {
    docsEnabled = !!enable
    writeDocsConfig({ docsEnabled })
    if (docsEnabled) {
      registerToolsNow().catch((e) => { console.error(tr(SYSTEM_LANG, 'toolsRegisterFail', { err: String((e && e.message) || e) })) })
      if (docsStatus().indexed === false) sync(SYSTEM_LANG).catch(() => { /* 静默 */ })
    } else {
      unregisterToolsNow()
    }
    return { ok: true, enabled: docsEnabled }
  }

  const runFullCheck = async () => {
    const located = await locateInstall(ctx)
    if (located === null) return { ok: false, error: tr(SYSTEM_LANG, 'locateFail') }
    const { installDir, mode } = located
    const localVersion = localVersionOf(installDir)
    const copies = detectOtherCopies(installDir)
    const pwshInstalled = await pwshInstalledCheck()
    if (mode === 'source') {
      // 源码树模式：有更新 = git 落后；附带 git 状态供 UI 展示
      const info = await gitInfo(installDir)
      let git = null
      let hasUpdate = false
      let gitError = null // 'git-missing' | 'not-repo' | 'git-fetch-failed'（客户端本地化提示）
      if (info !== null) {
        const st = await gitRemoteState(info)
        if (st !== null) {
          git = { ...info, ...st }
          hasUpdate = st.behind !== null && st.behind > 0
        } else {
          git = info
          gitError = 'git-fetch-failed'
        }
      } else {
        gitError = (await gitAvailable()) ? 'not-repo' : 'git-missing'
      }
      return {
        ok: true,
        installDir,
        mode,
        localVersion,
        remoteVersion: null,
        hasUpdate,
        updateMethod: 'source-git-pull',
        copies,
        pwshInstalled,
        git,
        gitError,
        // sourceWarning 由 check() 按请求语言即时生成
        remoteError: null,
        checkedAt: Date.now(),
      }
    }
    const remote = await remoteVersionOf()
    const hasUpdate = remote.version !== null && localVersion !== null && compareVersions(remote.version, localVersion) > 0
    // 多副本保护：只关心当前运行的这个，其余副本仅列出、绝不更新
    const own = npmCliFor(installDir)
    const pathNpm = pathNpmGlobalRoots()
    const npmMismatch = own !== null && pathNpm.length > 0 && !pathNpm.includes(own.modulesDir)
    const updateMethod = own !== null ? 'npm-global-own' : 'npm-global-path'
    return {
      ok: true,
      installDir,
      mode,
      localVersion,
      remoteVersion: remote.version,
      hasUpdate,
      updateMethod,
      copies,                 // 环境中的其他 dsh 副本（不含当前运行实例）
      pwshInstalled,          // Windows 上 pwsh 是否已安装（非 Windows 为 null）
      deployBroken: deploymentBroken(installDir), // 部署目录是否完整（半拆半装检测）
      npmMismatch,            // PATH 上的 npm 与当前实例是否同属一套 Node 安装
      // sourceWarning 由 check() 按请求语言即时生成（缓存的原始数据不含本地化文案）
      remoteError: remote.error,
      checkedAt: Date.now(),
    }
  }

  /** 按请求语言补充 sourceWarning（源码树模式提示）。 */
  const withSourceWarning = (data, uilang) => {
    if (data && data.ok && data.mode === 'source' && data.sourceWarning === undefined) {
      return { ...data, sourceWarning: tr(uilang, 'sourceWarning', { dir: data.installDir, version: data.localVersion }) }
    }
    return data
  }

  const check = async (uilang) => {
    try {
      const now = Date.now()
      if (cached !== null && now - cached.at < 10 * 60 * 1000) {
        return { ...withSourceWarning(cached.data, uilang), cached: true }
      }
      if (checking) {
        if (cached !== null) return { ...withSourceWarning(cached.data, uilang), cached: true }
        for (let i = 0; i < 40; i += 1) {
          if (!checking && cached !== null) return { ...withSourceWarning(cached.data, uilang), cached: true }
          await ctx.timer.timeout(1000)
        }
        return { ok: false, error: tr(uilang, 'checkTimeout') }
      }
      checking = true
      try {
        const data = await runFullCheck()
        cached = { data, at: data.checkedAt || now }
        return { ...withSourceWarning(data, uilang), cached: false }
      } finally {
        checking = false
      }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error).slice(0, 500) }
    }
  }

  const progress = { type: null, phase: 'idle', message: '', detail: '', done: 0, total: 0, current: '', startedAt: 0, updatedAt: 0 }
  const setProgress = (patch) => { Object.assign(progress, patch, { updatedAt: Date.now() }) }

  const update = async (uilang) => {
    if (updating) return { ok: false, error: tr(uilang, 'busyUpdate') }
    updating = true
    setProgress({ type: 'update', phase: 'starting', message: tr(uilang, 'locating'), detail: '', done: 0, total: 0, current: '', startedAt: Date.now() })
    try {
      const located = await locateInstall(ctx)
      if (located === null) return { ok: false, error: tr(uilang, 'locateFailShort') }
      const { installDir, mode } = located
      if (mode === 'source') {
        const msg = tr(uilang, 'sourceModeUpdate', { dir: installDir })
        setProgress({ type: 'update', phase: 'error', message: msg, detail: '' })
        return { ok: false, error: msg, mode }
      }
      const beforeVersion = localVersionOf(installDir)
      // 多副本保护：更新前先盘点环境中的其他 dsh 副本（只更新当前运行实例）
      const copies = detectOtherCopies(installDir)
      // 期望有更新时才做“版本未变=更新落空”的判定（避免把“已是最新”误报为异常）
      let expectUpdate = false
      if (cached !== null && Date.now() - cached.at < 10 * 60 * 1000) {
        expectUpdate = cached.data.hasUpdate === true
      } else {
        try {
          const c = await check(uilang)
          expectUpdate = !!(c && c.ok && c.hasUpdate)
        } catch (e) { /* 保持 false */ }
      }
      setProgress({ type: 'update', phase: 'running', message: tr(uilang, npmCliFor(installDir) !== null ? 'npmRunningOwn' : 'npmRunning') })
      // Windows：更新目标即运行实例自身（含 native 依赖），原地 npm install 会撞
      // EBUSY（用户已遇到：lib 被锁、半拆半装）。改为 staged 安装 + 完成器替换。
      const result = process.platform === 'win32'
        ? await updateStagedFlow(installDir, beforeVersion, uilang, expectUpdate)
        : await runNpmUpdate(installDir, beforeVersion, (p) => setProgress({ type: 'update', ...p }), uilang, expectUpdate)
      const now = Date.now()
      cached = { data: { ...result, checkedAt: now, installDir, copies }, at: now }
      setProgress({ type: 'update', phase: result.ok ? 'done' : 'error', message: result.hint || result.error, detail: (result.stderr || result.stdout || '').slice(-400) })
      return { ...result, copies }
    } finally {
      updating = false
    }
  }

  /**
   * Windows staged 更新：把新版本完整安装到独立 staging 目录（不触碰部署目录，
   * 无 EBUSY）→ 校验 → 生成并 detached 启动 PowerShell 完成器：等当前 dsh 进程
   * 退出后原子替换部署目录（旧目录改名备份，新包移入，校验失败自动恢复旧版），
   * 再按原命令行重启 dsh web。
   */
  const updateStagedFlow = async (installDir, beforeVersion, uilang, expectUpdate) => {
    const push = (message, detail) => setProgress({ type: 'update', phase: 'running', message, detail: detail || '', done: 0, total: 0, current: '' })
    let target = cached && cached.data && typeof cached.data.remoteVersion === 'string' ? cached.data.remoteVersion : null
    if (target === null) {
      const rv = await remoteVersionOf()
      target = rv.version
    }
    if (target === null) return { ok: false, error: tr(uilang, 'updateStagingFail', { err: 'cannot resolve target version' }) }
    const stagingDir = join(pluginDataDir(), 'staging-' + Date.now())
    const cleanupStaging = () => { try { rmSync(stagingDir, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } }
    const staged = await installStaged(installDir, target, stagingDir, uilang, push)
    if (!staged.ok) { cleanupStaging(); push(staged.error, ''); return { ok: false, error: staged.error } }
    if (staged.version !== target) { cleanupStaging(); const msg = tr(uilang, 'updateStagingFail', { err: 'staged version mismatch' }); push(msg, ''); return { ok: false, error: msg } }
    const script = writeFinisherScript({
      installDir,
      stagingPkg: staged.stagingPkg,
      currentPid: process.pid,
      nodeExe: process.execPath,
      binJs: join(installDir, 'lib', 'bin.js'),
      extraArgs: process.argv.slice(2),
      logFile: join(pluginDataDir(), 'finisher.log'),
    })
    if (!spawnDetached(script)) { cleanupStaging(); const msg = tr(uilang, 'updateStagingFail', { err: 'cannot launch finisher' }); push(msg, ''); return { ok: false, error: msg } }
    push(tr(uilang, 'updateFinisher'), '')
    return { ok: true, mode: 'npm-global', staged: true, updated: true, needsRestart: true, beforeVersion, version: target, hint: tr(uilang, 'updateFinisher') }
  }

  /** 修复部署（半拆半装恢复）：staged 重装当前版本 + 完成器替换并重启。 */
  const repairDeployment = async (uilang) => {
    if (updating) return { ok: false, error: tr(uilang, 'busyUpdate') }
    const located = await locateInstall(ctx)
    if (located === null) return { ok: false, error: tr(uilang, 'locateFailShort') }
    const { installDir, mode } = located
    if (mode !== 'npm-global') return { ok: false, error: tr(uilang, 'sourceOnly') }
    const current = localVersionOf(installDir) || (await remoteVersionOf()).version || 'latest'
    const stagingDir = join(pluginDataDir(), 'repair-' + Date.now())
    const cleanupStaging = () => { try { rmSync(stagingDir, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } }
    const staged = await installStaged(installDir, current, stagingDir, uilang, () => {})
    if (!staged.ok) { cleanupStaging(); return { ok: false, error: staged.error } }
    const script = writeFinisherScript({
      installDir,
      stagingPkg: staged.stagingPkg,
      currentPid: process.pid,
      nodeExe: process.execPath,
      binJs: join(installDir, 'lib', 'bin.js'),
      extraArgs: process.argv.slice(2),
      logFile: join(pluginDataDir(), 'finisher.log'),
    })
    if (!spawnDetached(script)) { cleanupStaging(); return { ok: false, error: tr(uilang, 'repairFail') + 'cannot launch finisher' } }
    return { ok: true, hint: tr(uilang, 'repairDone') }
  }

  /** 源码树更新：git fetch → pull（仅快进）→ 安装依赖 → 校验提交变化。 */
  const updateSource = async (uilang) => {
    if (updating) return { ok: false, error: tr(uilang, 'busyUpdate') }
    const located = await locateInstall(ctx)
    if (located === null) return { ok: false, error: tr(uilang, 'locateFailShort') }
    if (located.mode !== 'source') return { ok: false, error: tr(uilang, 'sourceOnly') }
    if (!(await gitAvailable())) return { ok: false, error: tr(uilang, 'gitUnavailable'), gitError: 'git-missing' }
    const info = await gitInfo(located.installDir)
    if (info === null) return { ok: false, error: tr(uilang, 'gitUnavailable'), gitError: 'not-repo' }
    if (info.dirty) return { ok: false, error: tr(uilang, 'gitDirty'), gitError: 'dirty' }

    updating = true
    const push = (phase, message, detail) => setProgress({ type: 'source-update', phase, message, detail: detail || '', done: 0, total: 0, current: '' })
    setProgress({ type: 'source-update', phase: 'starting', message: tr(uilang, 'sourceFetching'), detail: '', done: 0, total: 0, current: '', startedAt: Date.now() })
    try {
      const remote = info.remote || 'origin'
      const before = info.localHead
      // 1) fetch
      const fetched = await runGit(info.root, ['fetch', remote], (d) => push('running', tr(uilang, 'sourceFetching'), d))
      if (!fetched.ok) {
        push('error', tr(uilang, 'syncFail', { err: (fetched.stderr || fetched.stdout || 'git fetch') }), '')
        return { ok: false, error: tr(uilang, 'syncFail', { err: (fetched.stderr || 'git fetch') }), gitError: 'git-fetch-failed' }
      }
      // 2) pull（仅快进，避免自动创建合并提交）
      const pull = await runGit(info.root, ['pull', '--ff-only', remote, info.branch || 'HEAD'], (d) => push('running', tr(uilang, 'sourcePulling'), d))
      const afterR = await runGit(info.root, ['rev-parse', 'HEAD'])
      const after = afterR.ok ? afterR.stdout.trim().slice(0, 7) : null
      const updated = after !== null && after !== before
      if (!pull.ok) {
        const msg = tr(uilang, 'sourceDiverged')
        push('error', msg, (pull.stderr || pull.stdout || '').slice(-400))
        return { ok: false, error: msg, gitError: 'diverged', before, after }
      }
      // 3) 安装依赖
      const inst = await runDepsInstall(info.root, (d) => push('running', tr(uilang, 'sourceInstall', { cmd: 'pnpm' }), d))
      if (!inst.ok) {
        const msg = tr(uilang, 'syncFail', { err: (inst.error || 'install') })
        push('error', msg, (inst.detail || ''))
        return { ok: false, error: msg, before, after, updated }
      }
      const hint = updated ? tr(uilang, 'sourceUpdatedHint', { commit: after }) : tr(uilang, 'sourceUpToDateHint')
      push('done', hint, (pull.stdout || '') + (inst.ok ? '' : '\n' + (inst.detail || '')))
      const now = Date.now()
      cached = { data: { ok: true, mode: 'source', installDir: located.installDir, before, after, updated, needsRestart: updated, hint, checkedAt: now }, at: now }
      return { ok: true, mode: 'source', before, after, updated, needsRestart: updated, hint }
    } finally {
      updating = false
    }
  }

  /** 一键安装 PowerShell 7（仅 Windows）：优先 winget，回落官方 MSI。 */
  const installPwsh = async (uilang) => {
    if (process.platform !== 'win32') return { ok: false, error: tr(uilang, 'pwshWinOnly') }
    if (updating) return { ok: false, error: tr(uilang, 'busyUpdate') }
    if (await pwshInstalledCheck()) return { ok: true, hint: tr(uilang, 'pwshInstalled') }
    updating = true
    const push = (message, detail) => setProgress({ type: 'install-pwsh', phase: 'running', message, detail: detail || '', done: 0, total: 0, current: '' })
    setProgress({ type: 'install-pwsh', phase: 'starting', message: tr(uilang, 'pwshInstalling'), detail: '', done: 0, total: 0, current: '', startedAt: Date.now() })
    try {
      let result = null
      // 1) winget（最简路径）
      if (await commandAvailable('winget')) {
        push(tr(uilang, 'pwshWinget'), '')
        const r = await runInstallCmd(['winget', 'install', '--id', 'Microsoft.PowerShell', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent'], (d) => push(tr(uilang, 'pwshWinget'), d))
        const ready = await waitForPwsh()
        if (r.ok || ready) {
          result = { ok: true, method: 'winget', hint: tr(uilang, 'pwshInstalled') }
        } else if (await commandAvailable('winget')) {
          // winget 存在但安装未生效 → 继续走 MSI
          result = null
        } else {
          result = { ok: false, error: tr(uilang, 'pwshInstallFail') + (r.detail || ''), detail: r.detail }
        }
      }
      // 2) MSI 回落
      if (result === null) {
        const msi = await installPwshMsi(uilang, push)
        const ready = await waitForPwsh()
        result = ready
          ? { ok: true, method: msi.ok ? 'msi' : 'msi-unknown', hint: tr(uilang, 'pwshInstalled') }
          : { ok: false, method: 'msi', error: msi.error || tr(uilang, 'pwshInstallTimeout'), detail: msi.detail || '' }
      }
      const now = Date.now()
      setProgress({ type: 'install-pwsh', phase: result.ok ? 'done' : 'error', message: result.hint || result.error, detail: result.detail || '', done: 1, total: 1, current: '' })
      cached = { data: { ...cached && cached.data ? cached.data : {}, pwshInstalled: await pwshInstalledCheck(), checkedAt: now }, at: now }
      return { ok: result.ok, hint: result.hint || null, error: result.error || null, method: result.method || null }
    } finally {
      updating = false
    }
  }

  const sync = async (uilang) => {
    if (syncing) return { ok: false, error: tr(uilang, 'busySync') }
    syncing = true
    setProgress({ type: 'docs-sync', phase: 'starting', message: tr(uilang, 'fetchingList'), detail: '', done: 0, total: 0, current: '', startedAt: Date.now() })
    try {
      const result = await syncDocs((p) => setProgress({ type: 'docs-sync', ...p }), uilang)
      if (!result.ok) setProgress({ type: 'docs-sync', phase: 'error', message: tr(uilang, 'syncFail', { err: result.error || '' }), detail: '' })
      else setProgress({ type: 'docs-sync', phase: 'done', message: tr(uilang, 'syncDone', { synced: result.synced, skipped: result.skipped, failed: result.failed || 0 }), detail: '' })
      return result
    } finally {
      syncing = false
    }
  }

  const progressSnapshot = () => ({ ...progress })

  const status = () => docsStatus()

  const search = (query, lang, limit, uilang) => searchDocs(query, lang, limit, uilang)

  const read = (path, section, uilang) => readDoc(path, section, uilang)

  // ── HTTP 路由 ─────────────────────────────────────────────────────────────
  const respond = async (req, res, fn) => {
    let body
    try {
      body = await fn()
    } catch (error) {
      body = { ok: false, error: String((error && error.message) || error).slice(0, 500) }
    }
    const text = JSON.stringify(body)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  }

  /** True when the request's Origin matches its Host — required on the POST routes. */
  const sameOrigin = (request) => {
    const origin = request.headers.origin
    const host = request.headers.host
    if (origin === undefined || host === undefined) return false
    try {
      return new URL(origin).host === host
    } catch (e) {
      return false
    }
  }

  /** 从请求 URL 读取 ?uilang=（客户端界面语言），非法值回退系统语言。 */
  const uilangOf = (req) => uiLang(new URL(req.url, 'http://localhost').searchParams.get('uilang'))

  ctx.inject(['webServer'], (hostCtx) => {
    const host = hostCtx
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/check',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        const uilang = uilangOf(req)
        respond(req, res, () => check(uilang))
      },
    }), 'dsh-updater-npm: check route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/update',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        if (!sameOrigin(req)) {
          const text = JSON.stringify({ ok: false, error: 'cross-origin request rejected' })
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(text)
          return
        }
        const uilang = uilangOf(req)
        respond(req, res, () => update(uilang))
      },
    }), 'dsh-updater-npm: update route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/update-source',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        if (!sameOrigin(req)) {
          const text = JSON.stringify({ ok: false, error: 'cross-origin request rejected' })
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(text)
          return
        }
        const uilang = uilangOf(req)
        respond(req, res, () => updateSource(uilang))
      },
    }), 'dsh-updater-npm: update-source route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/install-pwsh',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        if (!sameOrigin(req)) {
          const text = JSON.stringify({ ok: false, error: 'cross-origin request rejected' })
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(text)
          return
        }
        const uilang = uilangOf(req)
        respond(req, res, () => installPwsh(uilang))
      },
    }), 'dsh-updater-npm: install-pwsh route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/repair',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        if (!sameOrigin(req)) {
          const text = JSON.stringify({ ok: false, error: 'cross-origin request rejected' })
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(text)
          return
        }
        const uilang = uilangOf(req)
        respond(req, res, () => repairDeployment(uilang))
      },
    }), 'dsh-updater-npm: repair route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/progress',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        respond(req, res, progressSnapshot)
      },
    }), 'dsh-updater-npm: progress route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/docs/status',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        respond(req, res, () => ({ ...status(), enabled: docsEnabled }))
      },
    }), 'dsh-updater-npm: docs status route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/docs/sync',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        if (!sameOrigin(req)) {
          const text = JSON.stringify({ ok: false, error: 'cross-origin request rejected' })
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(text)
          return
        }
        const uilang = uilangOf(req)
        // 开关关闭时拒绝手动同步
        respond(req, res, () => docsEnabled ? sync(uilang) : ({ ok: false, error: tr(uilang, 'docsDisabled') }))
      },
    }), 'dsh-updater-npm: docs sync route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/docs/enabled',
      handler: (req, res) => {
        if (req.method === 'GET') {
          respond(req, res, () => ({ ok: true, enabled: docsEnabled }))
          return
        }
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return }
        if (!sameOrigin(req)) {
          const text = JSON.stringify({ ok: false, error: 'cross-origin request rejected' })
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(text)
          return
        }
        const enable = new URL(req.url, 'http://localhost').searchParams.get('enabled') === '1'
        respond(req, res, () => setDocsEnabled(enable))
      },
    }), 'dsh-updater-npm: docs enabled route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/docs/search',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        const url = new URL(req.url, 'http://localhost')
        const q = url.searchParams.get('q') || ''
        const lang = url.searchParams.get('lang') || 'auto'
        const limit = Number(url.searchParams.get('limit') || 8)
        const uilang = uiLang(url.searchParams.get('uilang'))
        respond(req, res, () => search(q, lang, limit, uilang))
      },
    }), 'dsh-updater-npm: docs search route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/docs/read',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        const url = new URL(req.url, 'http://localhost')
        const path = url.searchParams.get('path') || ''
        const section = url.searchParams.get('section') || ''
        const uilang = uiLang(url.searchParams.get('uilang'))
        respond(req, res, () => read(path, section, uilang))
      },
    }), 'dsh-updater-npm: docs read route')
  })

  // ── 文档工具注册（受同步开关控制：默认关闭不注册） ─────────────────────────
  ctx.effect(() => {
    registerToolsNow().catch((e) => { console.error(tr(SYSTEM_LANG, 'toolsRegisterFail', { err: String((e && e.message) || e) })) })
    return () => { unregisterToolsNow() }
  })

  // ── 定时任务 ──────────────────────────────────────────────────────────────
  // 每 30 分钟自动检查更新并刷新缓存
  ctx.timer.interval(() => {
    if (checking) return
    checking = true
    runFullCheck()
      .then((data) => { cached = { data, at: data.checkedAt || Date.now() } })
      .catch(() => { /* 静默失败，保留旧缓存 */ })
      .finally(() => { checking = false })
  }, 30 * 60 * 1000)

  // 首次启动：开关开启且本地没有文档索引时，后台同步一次官方文档
  if (docsEnabled && docsStatus().indexed === false) {
    sync(SYSTEM_LANG)
      .then((r) => { if (r.ok) console.log(tr(SYSTEM_LANG, 'docsFirstSyncDone', { n: r.synced })) })
      .catch(() => { /* 静默 */ })
  }

  // 每 24 小时静默增量同步官方文档（仅开关开启时）
  ctx.timer.interval(() => {
    if (syncing || !docsEnabled) return
    sync(SYSTEM_LANG).catch(() => { /* 静默 */ })
  }, 24 * 60 * 60 * 1000)
}

// 仅供本地冒烟测试使用，不参与插件契约（Cordis 只消费 name/inject/apply）。
export const __test = {
  docsRoot,
  syncDocs,
  docsStatus,
  searchDocs,
  readDoc,
  analyzeMarkdown,
  compareVersions,
  parseVersion,
  tokenize,
  hasCJK,
  detectSystemLang,
  uiLang,
  tr,
  SYSTEM_LANG,
  npmCliFor,
  pathNodeRoots,
  pathNpmGlobalRoots,
  detectOtherCopies,
  localVersionOf,
  realPathOf,
  loadDefineTool,
  registerDocTools,
  readDocsConfig,
  writeDocsConfig,
  gitAvailable,
  gitInfo,
  runGit,
  commandAvailable,
  pwshInstalledCheck,
  deploymentBroken,
  writeFinisherScript,
}
