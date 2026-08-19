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
 * timer：每 30 分钟自动检查更新；首次启动若本地无文档则后台同步一次；
 * 此后每 24 小时静默增量同步官方文档。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { dirname, join, basename, extname, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

export const name = 'dsh-updater-npm'
export const inject = ['agentPresets', 'timer', 'webServer']

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
async function fetchDocsTree() {
  // 1) head commit sha（raw URL 用）
  const head = await fetchWithTimeout(`${GITHUB_API}/repos/${DOCS_REPO}/commits/${DOCS_BRANCH}`, { headers: UA_HEADERS })
  if (!head.ok) return { ref: null, files: [], error: '获取 head commit 失败: ' + (head.error || '') }
  const ref = head.json && head.json.sha ? String(head.json.sha) : DOCS_BRANCH

  // 2) 递归 tree（已验证不截断），过滤 docs/*.md
  const tree = await fetchWithTimeout(`${GITHUB_API}/repos/${DOCS_REPO}/git/trees/${DOCS_BRANCH}?recursive=1`, { headers: UA_HEADERS }, 20000)
  if (!tree.ok) return { ref, files: [], error: '获取文件树失败: ' + (tree.error || '') }
  const data = tree.json
  if (!data || !Array.isArray(data.tree)) return { ref, files: [], error: '文件树响应格式异常' }
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
async function syncDocs(onProgress = null) {
  const { ref, files, error } = await fetchDocsTree()
  if (error !== null) return { ok: false, error }
  if (files.length === 0) return { ok: false, error: '官方 docs 清单为空' }
  if (onProgress) onProgress({ phase: 'downloading', done: 0, total: files.length, current: '', message: '开始下载 ' + files.length + ' 篇文档…' })

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
      if (onProgress) onProgress({ phase: 'downloading', done: cursor, total: files.length, current: file.path, message: '下载 ' + cursor + '/' + files.length })
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
        if (failures.length < 10) failures.push(file.path + ' (写入失败)')
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
  if (onProgress) onProgress({ phase: 'indexing', done: files.length, total: files.length, current: '', message: '正在重建文档索引…' })
  try {
    const shaMap = {}
    for (const f of files) shaMap[f.path] = f.sha
    const index = rebuildIndex()
    for (const entry of index.files) entry.sha = shaMap[entry.path] || ''
    index.sourceRef = ref
    index.syncedAt = Date.now()
    writeJson(indexFile(), index)
  } catch (e) {
    return { ok: true, synced, skipped, failed, total: files.length, ref, error: '索引重建失败: ' + String((e && e.message) || e) }
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

/** 本地索引搜索。 */
function searchDocs(query, lang = 'auto', limit = 8) {
  const idx = readIndex()
  if (!idx) return { ok: false, error: '本地文档尚未同步，请先在设置页同步官方文档', results: [] }
  const q = String(query || '').trim()
  if (q === '') return { ok: false, error: '查询词不能为空', results: [] }
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
function readDoc(input, section) {
  const file = resolveDocPath(input)
  if (file === null) return { ok: false, error: '未找到文档: ' + String(input || '') }
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { return { ok: false, error: '读取失败: ' + String((e && e.message) || e) } }
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
  if (content.length > cap) { content = content.slice(0, cap) + '\n…（内容过长已截断）'; truncated = true }
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
// 更新检查 / npm 升级（原有逻辑）
// ────────────────────────────────────────────────────────────────────────────

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

/** 执行 npm 全局升级，完成后回读版本。 */
function runNpmUpdate(installDir, beforeVersion, onProgress = null) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('npm', ['install', '-g', '@deepseek-ai/dsh@latest'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: { ...process.env, CI: 'true' },
      })
    } catch (e) {
      resolve({ ok: false, error: 'npm 启动失败: ' + String((e && e.message) || e) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch (e) { /* already gone */ }
    }, 180000)
    const pushProgress = () => {
      if (onProgress) {
        const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-4).join('\n')
        onProgress({ phase: 'running', done: 0, total: 0, current: '', message: '正在执行 npm install -g @deepseek-ai/dsh@latest…', detail })
      }
    }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8192); pushProgress() })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); pushProgress() })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: 'npm 执行失败: ' + String((e && e.message) || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const afterVersion = localVersionOf(installDir)
      const updated = code === 0 && afterVersion !== null && afterVersion !== beforeVersion
      if (onProgress) onProgress({ phase: 'done', done: 1, total: 1, current: '', message: code === 0 ? '更新完成' : '更新失败', detail: (stderr || stdout).trim().slice(-400) })
      resolve({
        ok: code === 0,
        beforeVersion,
        version: afterVersion,
        updated,
        needsRestart: updated,
        stdout: stdout.trim().slice(-600),
        stderr: stderr.trim().slice(-600),
        error: code !== 0 ? (stderr.trim().slice(-400) || ('npm 退出码 ' + String(code))) : null,
        hint: code === 0 ? (updated ? '已更新到 v' + afterVersion + '，重启 DSH 后生效' : '已是最新版本，无需更新') : null,
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

/** 注册两个只读文档工具（幂等：注册返回 disposer，由 effect 生命周期清理）。 */
async function registerDocTools(ctx, installDir) {
  const tools = ctx.get('tools')
  if (tools === undefined) return []
  const defineTool = await loadDefineTool(installDir)
  if (defineTool === null) return []

  const disposers = []
  const searchTool = defineTool({
    name: 'dsh_docs_search',
    description:
      'Search the local index of the official DeepSeek Harness (DSH) documentation. ' +
      'The index is synced from deepseek-ai/deepseek-harness docs/ by the dsh-updater-npm plugin. ' +
      'Returns ranked file hits with path, title, headings and a short excerpt; then use dsh_docs_read to fetch the full content. ' +
      'Use this before dsh_docs_read to find the right document. 中文文档以 .zh.md 结尾，查询含中文时自动优先返回中文。',
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
        const body = lines.length > 0 ? lines.join('\n') : '（无匹配结果）'
        return [{ type: 'text', text: `DSH 文档搜索 "${value.query}"：共 ${value.total} 条，显示 ${value.results.length} 条\n${body}` }]
      },
    },
    execute(args) {
      const result = searchDocs(args.query, args.lang || 'auto', args.limit || 8)
      return Promise.resolve({
        query: result.query || String(args.query || ''),
        lang: result.lang || 'auto',
        total: result.results ? result.results.length : 0,
        results: result.results || [],
        error: result.error || null,
      })
    },
  })
  disposers.push(tools.register(searchTool))

  const readTool = defineTool({
    name: 'dsh_docs_read',
    description:
      'Read the full content of one local DeepSeek Harness (DSH) official document from the synced docs index. ' +
      'Pass the exact path returned by dsh_docs_search (e.g. "docs/user/develop/basic/tool.md"), or a unique basename like "tool.md". ' +
      'Optionally pass section to focus on one heading (case-insensitive substring). ' +
      'Returns the document markdown content, truncated at 80KB. 用于开发时查阅 DSH 官方文档原文。',
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
          ? `读取失败：${value.error}`
          : `DSH 文档 ${value.path}${value.section ? ' 章节「' + value.section + '」' : ''}（${value.size} 字符${value.truncated ? '，已截断' : ''}）`
        return [{ type: 'text', text: head + '\n\n' + String(value.content || '') }]
      },
    },
    execute(args) {
      const result = readDoc(args.path, args.section)
      return Promise.resolve({
        path: result.path || String(args.path || ''),
        title: result.title || String(args.path || ''),
        lang: result.lang || 'en',
        section: result.section || null,
        content: result.content || '',
        size: result.size || 0,
        truncated: !!result.truncated,
        error: result.error || null,
      })
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

  const runFullCheck = async () => {
    const located = await locateInstall(ctx)
    if (located === null) return { ok: false, error: '无法定位 dsh 安装目录（既不是 bin.js 也不是 preset 反推路径）' }
    const { installDir, mode } = located
    const localVersion = localVersionOf(installDir)
    const remote = await remoteVersionOf()
    const hasUpdate = remote.version !== null && localVersion !== null && compareVersions(remote.version, localVersion) > 0
    return {
      ok: true,
      installDir,
      mode,
      localVersion,
      remoteVersion: remote.version,
      hasUpdate,
      // 源码树运行：npm 全局更新对运行实例无效，必须 git pull 更新源码树
      sourceWarning: mode === 'source' ? '当前以源码树模式运行（' + installDir + '，v' + localVersion + '）。npm install -g 只更新全局安装，不改变运行中的源码树；请用 git pull 更新源码树，或改用 npm-global 方式启动 dsh。' : null,
      remoteError: remote.error,
      checkedAt: Date.now(),
    }
  }

  const check = async () => {
    try {
      const now = Date.now()
      if (cached !== null && now - cached.at < 10 * 60 * 1000) {
        return { ...cached.data, cached: true }
      }
      if (checking) {
        if (cached !== null) return { ...cached.data, cached: true }
        for (let i = 0; i < 40; i += 1) {
          if (!checking && cached !== null) return { ...cached.data, cached: true }
          await ctx.timer.timeout(1000)
        }
        return { ok: false, error: '检查超时，请稍后重试' }
      }
      checking = true
      try {
        const data = await runFullCheck()
        cached = { data, at: data.checkedAt || now }
        return { ...data, cached: false }
      } finally {
        checking = false
      }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error).slice(0, 500) }
    }
  }

  const progress = { type: null, phase: 'idle', message: '', detail: '', done: 0, total: 0, current: '', startedAt: 0, updatedAt: 0 }
  const setProgress = (patch) => { Object.assign(progress, patch, { updatedAt: Date.now() }) }

  const update = async () => {
    if (updating) return { ok: false, error: '一次只允许一个更新操作，请稍候重试' }
    updating = true
    setProgress({ type: 'update', phase: 'starting', message: '正在定位 dsh 安装目录…', detail: '', done: 0, total: 0, current: '', startedAt: Date.now() })
    try {
      const located = await locateInstall(ctx)
      if (located === null) return { ok: false, error: '无法定位 dsh 安装目录' }
      const { installDir, mode } = located
      if (mode === 'source') {
        const msg = '当前以源码树模式运行（' + installDir + '），npm 全局更新不会改变运行实例。请先在源码树执行 git pull + pnpm install 更新，或改用 npm-global 方式启动 dsh 后再点更新。'
        setProgress({ type: 'update', phase: 'error', message: msg, detail: '' })
        return { ok: false, error: msg, mode }
      }
      const beforeVersion = localVersionOf(installDir)
      setProgress({ type: 'update', phase: 'running', message: '正在执行 npm install -g @deepseek-ai/dsh@latest…' })
      const result = await runNpmUpdate(installDir, beforeVersion, (p) => setProgress({ type: 'update', ...p }))
      const now = Date.now()
      cached = { data: { ...result, checkedAt: now, installDir }, at: now }
      setProgress({ type: 'update', phase: result.ok ? 'done' : 'error', message: result.hint || result.error, detail: (result.stderr || result.stdout || '').slice(-400) })
      return result
    } finally {
      updating = false
    }
  }

  const sync = async () => {
    if (syncing) return { ok: false, error: '文档同步正在进行中，请稍候重试' }
    syncing = true
    setProgress({ type: 'docs-sync', phase: 'starting', message: '正在获取官方文档清单…', detail: '', done: 0, total: 0, current: '', startedAt: Date.now() })
    try {
      const result = await syncDocs((p) => setProgress({ type: 'docs-sync', ...p }))
      if (!result.ok) setProgress({ type: 'docs-sync', phase: 'error', message: '同步失败: ' + (result.error || ''), detail: '' })
      else setProgress({ type: 'docs-sync', phase: 'done', message: '同步完成：' + result.synced + ' 个更新 / ' + result.skipped + ' 个未变 / ' + (result.failed || 0) + ' 个失败', detail: '' })
      return result
    } finally {
      syncing = false
    }
  }

  const progressSnapshot = () => ({ ...progress })

  const status = () => docsStatus()

  const search = (query, lang, limit) => searchDocs(query, lang, limit)

  const read = (path, section) => readDoc(path, section)

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

  ctx.inject(['webServer'], (hostCtx) => {
    const host = hostCtx
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/check',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        respond(req, res, check)
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
        respond(req, res, update)
      },
    }), 'dsh-updater-npm: update route')

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
        respond(req, res, status)
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
        respond(req, res, sync)
      },
    }), 'dsh-updater-npm: docs sync route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: '/dsh-updater-npm/docs/search',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        const url = new URL(req.url, 'http://localhost')
        const q = url.searchParams.get('q') || ''
        const lang = url.searchParams.get('lang') || 'auto'
        const limit = Number(url.searchParams.get('limit') || 8)
        respond(req, res, () => search(q, lang, limit))
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
        respond(req, res, () => read(path, section))
      },
    }), 'dsh-updater-npm: docs read route')
  })

  // ── 模型工具注册（异步初始化，注册失败静默降级） ──────────────────────────
  ctx.effect(() => {
    let disposers = []
    let disposed = false
    ;(async () => {
      const installDir = await locateInstall(ctx)
      if (disposed || installDir === null) return
      const toolDisposers = await registerDocTools(ctx, installDir)
      if (disposed) { toolDisposers.forEach((d) => d()); return }
      disposers = toolDisposers
      if (disposers.length > 0) console.log('[dsh-updater-npm] 已注册文档工具 dsh_docs_search / dsh_docs_read')
    })().catch((e) => { console.error('[dsh-updater-npm] 工具注册失败: ' + String((e && e.message) || e)) })
    return () => {
      disposed = true
      disposers.forEach((d) => d())
    }
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

  // 首次启动：若本地没有文档索引，后台同步一次官方文档
  if (docsStatus().indexed === false) {
    sync()
      .then((r) => { if (r.ok) console.log('[dsh-updater-npm] 官方文档首次同步完成: ' + r.synced + ' 个文件') })
      .catch(() => { /* 静默 */ })
  }

  // 每 24 小时静默增量同步官方文档
  ctx.timer.interval(() => {
    if (syncing) return
    sync().catch(() => { /* 静默 */ })
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
}
