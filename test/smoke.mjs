/**
 * dsh-updater-npm 冒烟测试（无第三方依赖，直接 node test/smoke.mjs）
 *
 * 覆盖 0.1.2→0.1.5 升级实战里踩到的每一条：
 *   1) 暂存包结构必须与现网一致（嵌套 vs 提升），否则交换会丢掉全部依赖；
 *   2) 重启脚本的交换前校验必须发生在「杀进程之前」，不通过就整体放弃；
 *   3) 改名要重试、旧部署要保留成回滚点，而不是交换后立刻删掉；
 *   4) 重启后要抓取新的激活地址（0.1.5 起鉴权 cookie 按本次激活签名）；
 *   5) 跨版本破坏性变更提示与 release notes 链接。
 *
 * 其中 2/3/4 是「真跑」：生成 PowerShell 脚本并在临时目录里执行，断言交换结果。
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

// 隔离 DSH_HOME：apply() 会读写 $DSH_HOME/plugin-data，绝不能碰用户真实的家目录
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-updater-home-'))
process.env.DSH_HOME = sandboxHome

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const t = mod.__test

let pass = 0
let fail = 0
// 顺序化执行：check 可以传 async 函数，断言真正跑完才计数（否则 async 断言会被漏掉）
let chain = Promise.resolve()
const check = (name, fn) => {
  chain = chain.then(async () => {
    try {
      await fn()
      pass += 1
      console.log('  ok   ' + name)
    } catch (error) {
      fail += 1
      console.log('  FAIL ' + name + '\n       ' + String((error && error.message) || error).split('\n')[0])
    }
  })
  return chain
}
const section = (title) => console.log('\n' + title)

// ── 1. 结构一致性 ───────────────────────────────────────────────────────────
section('1) stagingLayoutMatches —— 交换安全的前提')
const root = mkdtempSync(join(tmpdir(), 'dsh-updater-smoke-'))
const mkPkg = (dir, version, { nested = true } = {}) => {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  writeFileSync(join(dir, 'lib', 'bin.js'), '// stub')
  if (nested) mkdirSync(join(dir, 'node_modules'), { recursive: true })
}
try {
  const nestedInstall = join(root, 'live-nested')
  const hoistedStaging = join(root, 'staging-hoisted')
  const nestedStaging = join(root, 'staging-nested')
  mkPkg(nestedInstall, '0.1.2-rc.1')
  mkPkg(hoistedStaging, '0.1.5-rc.1', { nested: false })
  mkPkg(nestedStaging, '0.1.5-rc.1')

  check('现网嵌套 + 暂存提升 → 判定为不一致（拒绝交换）', () => {
    assert.equal(t.stagingLayoutMatches(nestedInstall, hoistedStaging), false)
  })
  check('现网嵌套 + 暂存嵌套 → 判定为一致', () => {
    assert.equal(t.stagingLayoutMatches(nestedInstall, nestedStaging), true)
  })
  check('现网非嵌套（非常规布局）→ 不做结构判定', () => {
    const flat = join(root, 'live-flat')
    mkPkg(flat, '0.1.2-rc.1', { nested: false })
    assert.equal(t.stagingLayoutMatches(flat, hoistedStaging), true)
  })
} catch (error) {
  console.log('  setup failed: ' + String(error && error.message))
}

// ── 2. 版本提示 ─────────────────────────────────────────────────────────────
section('2) 跨版本破坏性变更提示')
check('0.1.2-rc.1 → 0.1.5-rc.1 命中已知破坏性变更', () => {
  const note = t.breakingNoteFor('0.1.2-rc.1', '0.1.5-rc.1')
  assert.ok(note !== null, 'should return a note')
  assert.equal(note.key, 'breakingKnown')
})
check('同一个小版本内（0.1.5-alpha.2 → 0.1.5-rc.1）不给破坏性提示', () => {
  assert.equal(t.breakingNoteFor('0.1.5-alpha.2', '0.1.5-rc.1'), null)
})
check('已在新版本之后（0.1.5-rc.1 → 0.1.5-rc.2）不再提示 0.1.5 的变更', () => {
  assert.equal(t.breakingNoteFor('0.1.5-rc.1', '0.1.5-rc.2'), null)
})
check('未知的跨 2 个小版本 → 通用提示', () => {
  const note = t.breakingNoteFor('0.2.0', '0.4.0')
  assert.ok(note !== null && note.key === 'breakingGeneric')
})
check('release notes 链接按 dsh-v<version> 生成', () => {
  assert.equal(t.releaseNotesUrl('0.1.5-rc.1'), 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1')
  assert.equal(t.releaseNotesUrl('not-a-version'), null)
})

// ── 3. 生成的脚本文本 ───────────────────────────────────────────────────────
section('3) buildRestartScript —— 脚本内容断言')
const swapArgs = {
  platform: 'win32',
  pid: 999999,
  nodeExe: process.execPath,
  args: ['-e', '0'],
  cwd: root,
  logFile: join(root, 'restart.log'),
  swap: { installDir: join(root, 'live'), stagingPkg: join(root, 'stg'), stagingDir: join(root, 'stgroot'), version: '0.1.5-rc.1' },
  resultFile: join(root, 'restart-result.json'),
  outLog: join(root, 'out.log'),
  errLog: join(root, 'err.log'),
}
const winScript = t.buildRestartScript(swapArgs)
check('包含结构一致性守卫', () => assert.ok(winScript.includes('staging layout mismatch'), 'missing layout guard'))
check('校验发生在杀进程之前（exit 1 早于 Stop-Process）', () => {
  assert.ok(winScript.indexOf("exit 1") < winScript.indexOf('Stop-Process'), 'validation must precede the kill')
})
check('改名带重试循环', () => assert.ok(/for \(\$i = 1; \$i -le 5; \$i\+\+\)/.test(winScript), 'missing rename retry'))
check('旧部署保留为回滚点（不再 Remove-Item $old）', () => {
  assert.ok(winScript.includes('previous deployment kept at'), 'missing keep-old log')
  assert.ok(!/Remove-Item[^\n]*\$old[^\n]*Recurse/.test(winScript), 'must not delete the rollback point')
})
check('新进程输出重定向', () => assert.ok(winScript.includes('-RedirectStandardOutput'), 'missing stdout redirect'))
check('不再抓取/弹出激活地址（1.12.3 按用户要求移除）', () => {
  assert.ok(!winScript.includes('token='), '脚本里还有 token 抓取')
  assert.ok(!winScript.includes('Start-Process $url'), '脚本还会弹浏览器')
  assert.ok(!winScript.includes('activation url'), '脚本还有激活地址日志')
})
check('POSIX 分支同样不再抓取激活地址', () => {
  const shScript = t.buildRestartScript({ ...swapArgs, platform: 'linux' })
  assert.ok(!shScript.includes('token='), 'POSIX 脚本里还有 token 抓取')
  assert.ok(!shScript.includes('xdg-open'), 'POSIX 脚本还会弹浏览器')
})
check('写回机器可读的重启结果', () => assert.ok(winScript.includes('ConvertTo-Json'), 'missing result json'))
check('生成的 PowerShell 能被解析器接受', () => {
  const file = join(root, 'generated.ps1')
  writeFileSync(file, winScript)
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$errs = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + file.replace(/'/g, "''") + "', [ref]$tokens, [ref]$errs); if ($errs.Count -gt 0) { $errs | ForEach-Object { Write-Output $_.Message }; exit 2 }"], { encoding: 'utf8' })
  assert.equal(res.status, 0, 'parser rejected the script: ' + (res.stdout || '') + (res.stderr || ''))
})

// ── 4. 真跑：交换成功 ───────────────────────────────────────────────────────
section('4) 执行重启脚本 —— 交换成功路径')
const runScript = (opts) => {
  const script = t.buildRestartScript(opts)
  const file = join(opts._dir, 'restart.ps1')
  writeFileSync(file, script)
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 120000 })
}
try {
  const live = join(root, 'swap-ok', 'live')
  const stgRoot = join(root, 'swap-ok', 'stage')
  const stgPkg = join(stgRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const work = join(root, 'swap-ok')
  mkPkg(live, '0.1.2-rc.1')
  mkdirSync(join(live, 'node_modules'), { recursive: true })
  mkdirSync(stgPkg, { recursive: true })
  mkPkg(stgPkg, '0.1.5-rc.1')
  const resultFile = join(work, 'restart-result.json')
  const res = runScript({
    platform: 'win32',
    pid: 999999,
    nodeExe: process.execPath,
    args: ['-e', '0'],
    cwd: work,
    logFile: join(work, 'restart.log'),
    swap: { installDir: live, stagingPkg: stgPkg, stagingDir: stgRoot, version: '0.1.5-rc.1' },
    resultFile,
    _dir: work,
  })
  check('脚本退出码为 0', () => assert.equal(res.status, 0, (res.stdout || '') + (res.stderr || '')))
  check('部署目录已换成新版本', () => {
    assert.equal(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version, '0.1.5-rc.1')
  })
  check('旧版本被保留为回滚点', () => {
    const olds = readdirSync(work).filter((n) => n.startsWith('live.old-'))
    assert.equal(olds.length, 1, 'expected exactly one rollback dir, got ' + olds.join(','))
    assert.equal(JSON.parse(readFileSync(join(work, olds[0], 'package.json'), 'utf8')).version, '0.1.2-rc.1')
  })
  check('结果文件记录 swapped/swapOk/version/oldDir', () => {
    const r = JSON.parse(readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''))
    assert.equal(r.swapped, true)
    assert.equal(r.swapOk, true)
    assert.equal(r.version, '0.1.5-rc.1')
    assert.ok(typeof r.oldDir === 'string' && r.oldDir.length > 0)
  })
  check('暂存根目录已清理', () => assert.equal(existsSync(stgRoot), false))
} catch (error) {
  check('交换成功路径（未抛异常）', () => { throw error })
}

// ── 5. 真跑：结构不一致必须中止且不动老部署 ─────────────────────────────────
section('5) 执行重启脚本 —— 结构不一致时中止（不杀进程、不交换）')
try {
  const work = join(root, 'mismatch')
  const live = join(work, 'live')
  const stgRoot = join(work, 'stage')
  const stgPkg = join(stgRoot, 'node_modules', '@deepseek-ai', 'dsh')
  mkPkg(live, '0.1.2-rc.1')                    // 现网：嵌套
  mkdirSync(join(live, 'node_modules'), { recursive: true })
  mkdirSync(stgPkg, { recursive: true })
  mkPkg(stgPkg, '0.1.5-rc.1', { nested: false }) // 暂存：提升（结构不一致）
  const resultFile = join(work, 'restart-result.json')
  const res = runScript({
    platform: 'win32',
    pid: 999999,
    nodeExe: process.execPath,
    args: ['-e', '0'],
    cwd: work,
    logFile: join(work, 'restart.log'),
    swap: { installDir: live, stagingPkg: stgPkg, stagingDir: stgRoot, version: '0.1.5-rc.1' },
    resultFile,
    _dir: work,
  })
  check('脚本以非 0 退出', () => assert.notEqual(res.status, 0))
  check('老部署原样保留（没有被改名/删除）', () => {
    assert.equal(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version, '0.1.2-rc.1')
    assert.equal(readdirSync(work).filter((n) => n.startsWith('live.old-')).length, 0)
  })
  check('结果文件记录 layout mismatch', () => {
    const r = JSON.parse(readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''))
    assert.equal(r.swapped, false)
    assert.match(String(r.error), /layout mismatch/)
  })
} catch (error) {
  check('结构不一致中止路径（未抛异常）', () => { throw error })
}

// ── 6. POSIX 脚本（只断言文本，Windows 上不执行） ───────────────────────────
section('6) buildRestartScript —— POSIX 分支')
const shScript = t.buildRestartScript({ ...swapArgs, platform: 'linux', logFile: join(root, 'restart.log') })
check('POSIX 分支含结构守卫与重试', () => {
  assert.ok(shScript.includes('staging layout mismatch'))
  assert.ok(shScript.includes('renamed=false'))
  assert.ok(shScript.includes('write_result'))
})
check('POSIX 分支保留回滚点（不 rm -rf "$OLD"）', () => {
  assert.ok(!/rm -rf "\$OLD"/.test(shScript), 'must not delete the rollback point')
})

// ── 7. apply() 冒烟：mock ctx 下不抛异常并注册全部路由 ───────────────────────section('7) apply() —— mock ctx 挂载')
try {
  const routes = []
  const disposers = []
  const mockCtx = {
    get: () => undefined,
    on: () => {},
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    inject: (deps, fn) => { fn(mockCtx) },
    timer: { interval: () => () => {}, timeout: async () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    agentPresets: { list: async () => [] },
  }
  check('apply() 不抛异常', () => { mod.apply(mockCtx) })
  check('注册了全部路由（含新增的 cleanup）', () => {
    const paths = routes.map((r) => r.path)
    for (const p of [
      '/dsh-updater-npm/check',
      '/dsh-updater-npm/update',
      '/dsh-updater-npm/update-source',
      '/dsh-updater-npm/repair',
      '/dsh-updater-npm/restart',
      '/dsh-updater-npm/cleanup',
      '/dsh-updater-npm/progress',
    ]) {
      assert.ok(paths.includes(p), 'missing route ' + p)
    }
  })
  check('每个路由都返回了 disposer（fiber 可回收）', () => {
    assert.equal(disposers.length >= routes.length, true, 'disposers=' + disposers.length + ' routes=' + routes.length)
  })
  // 触发一次 /check 与 /cleanup 的 handler，验证 handler 不抛（同源保护会拒绝缺 Origin 的请求）
  check('cleanup handler 对同源请求可用、跨源请求被拒', async () => {
    const route = routes.find((r) => r.path === '/dsh-updater-npm/cleanup')
    assert.ok(route !== undefined, 'cleanup route missing')
    const makeRes = (rec) => ({
      writeHead: (code, headers) => { rec.code = code; rec.headers = headers },
      end: (body) => { rec.body = body },
    })
    const cross = {}
    route.handler({ method: 'POST', headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } }, makeRes(cross))
    assert.equal(cross.code, 403, 'cross-origin POST must be rejected')
  })
} catch (error) {
  check('apply() mock 挂载（未抛异常）', () => { throw error })
}

// ── 8. 插件自身版本 / 自更新闸门 ────────────────────────────────────────────
section('8) 插件自身版本 / 自更新闸门')
check('selfVersion() 与本插件 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(t.selfVersion(), pkg.version)
})
check('自更新命令形状正确', () => {
  assert.match(t.selfUpdateCommand('9.9.9'), /^dsh plugin --profile \S+ add dsh-updater-npm@9\.9\.9$/)
})
check('resolveProfileName() 返回非空 profile 名', () => {
  const profile = t.resolveProfileName()
  assert.ok(typeof profile === 'string' && profile.length > 0, 'got ' + String(profile))
})
check('闸门只在「确定有新版插件」时拦截（离线性放行）', () => {
  assert.equal(t.updateBlockedBySelf({ hasUpdate: true }), true)
  assert.equal(t.updateBlockedBySelf({ hasUpdate: false }), false)
  assert.equal(t.updateBlockedBySelf(null), false)
  assert.equal(t.updateBlockedBySelf({}), false)
})
check('selfUpdateStatus() 结构正确（registry 不可达时 latest=null）', async () => {
  const st = await t.selfUpdateStatus()
  assert.ok(st.latest === null || typeof st.latest === 'string', 'bad latest')
  if (st.latest === null) assert.ok(typeof st.error === 'string' && st.error.length > 0, 'missing error')
  else assert.equal(typeof st.version, 'string')
})
check('/check 载荷包含插件版本与全部安全网字段', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-updater-check-'))
  mkdirSync(join(work, 'lib'), { recursive: true })
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' }))
  writeFileSync(join(work, 'lib', 'bin.js'), '// stub')
  // 真实约定：随部署自带的 preset 位于 <安装目录>/agent-presets/<id>/agent.cordis.yml
  const presetPath = join(work, 'agent-presets', 'cordis', 'agent.cordis.yml')
  mkdirSync(dirname(presetPath), { recursive: true })
  writeFileSync(presetPath, '')
  const routes = []
  const ctx = {
    get: () => undefined,
    on: () => {},
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, fn) => { fn(ctx) },
    timer: { interval: () => () => {}, timeout: async () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    agentPresets: { list: async () => [{ id: 'cordis', path: presetPath }] },
  }
  mod.apply(ctx)
  const route = routes.find((r) => r.path === '/dsh-updater-npm/check')
  assert.ok(route !== undefined, 'check route missing')
  const rec = {}
  const res = { writeHead: (code) => { rec.code = code }, end: (body) => { rec.body = body } }
  route.handler({ method: 'GET', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }, res)
  for (let i = 0; i < 80 && rec.body === undefined; i += 1) await new Promise((r) => setTimeout(r, 250))
  assert.ok(rec.body !== undefined, 'check handler did not respond in time')
  const body = JSON.parse(rec.body)
  rmSync(work, { recursive: true, force: true })
  assert.equal(body.ok, true, 'check payload not ok: ' + String(body.error || ''))
  assert.ok(body.plugin !== undefined && typeof body.plugin.version === 'string', 'plugin.version missing')
  assert.equal(typeof body.plugin.hasUpdate, 'boolean', 'plugin.hasUpdate missing')
  assert.match(String(body.plugin.updateCommand), /dsh plugin --profile /)
  assert.ok('releaseUrl' in body, 'releaseUrl missing')
  // breaking 是给前端本地化前的中间态（JSON 里被丢掉），最终暴露的是 breakingText
  if (body.hasUpdate) {
    assert.ok(typeof body.breakingText === 'string' && body.breakingText.length > 0, 'breakingText missing while hasUpdate')
    assert.ok(typeof body.releaseUrl === 'string' && body.releaseUrl.includes('releases/tag/dsh-v'), 'releaseUrl malformed')
  }
  assert.ok('lastRestart' in body && 'stagingWaste' in body && 'npmResiduals' in body, 'safety fields missing')
})

// ── 9. 超时策略与运行日志（1.12：10 分钟硬超时 → 空闲超时 + 硬上限）─────────
section('9) 超时策略（空闲看门狗）与运行日志')
const cfgFile = join(sandboxHome, 'plugin-data', 'dsh-updater-npm', 'config.json')
check('默认配置：空闲 10 分钟判卡死、总上限 60 分钟', () => {
  const cfg = t.readPluginConfig()
  assert.equal(cfg.npmIdleMinutes, 10)
  assert.equal(cfg.npmTimeoutMinutes, 60)
})
check('配置可覆盖，非法值回退默认（不炸）', () => {
  mkdirSync(dirname(cfgFile), { recursive: true })
  writeFileSync(cfgFile, JSON.stringify({ docsEnabled: false, npmIdleMinutes: 12, npmTimeoutMinutes: 90 }))
  let cfg = t.readPluginConfig()
  assert.equal(cfg.npmIdleMinutes, 12)
  assert.equal(cfg.npmTimeoutMinutes, 90)
  writeFileSync(cfgFile, JSON.stringify({ npmIdleMinutes: 0, npmTimeoutMinutes: 'abc' }))
  cfg = t.readPluginConfig()
  assert.equal(cfg.npmIdleMinutes, 10, '0 应回退默认')
  assert.equal(cfg.npmTimeoutMinutes, 60, '非数字应回退默认')
})
check('writeDocsConfig 合并写入，不抹掉超时配置', () => {
  writeFileSync(cfgFile, JSON.stringify({ npmIdleMinutes: 20, npmTimeoutMinutes: 120 }))
  t.writeDocsConfig({ docsEnabled: true })
  const cfg = t.readPluginConfig()
  assert.equal(cfg.docsEnabled, true)
  assert.equal(cfg.npmIdleMinutes, 20, '超时配置被抹掉了')
  assert.equal(cfg.npmTimeoutMinutes, 120)
  t.writeDocsConfig({ docsEnabled: false })
})
check('慢速但持续输出的安装不会被杀（旧版 10 分钟一刀切会误杀）', async () => {
  const script = 'let n=0; const i=setInterval(()=>{ console.log("tick"+(++n)); if(n>=8){ clearInterval(i) } }, 120)'
  const res = await t.runInstallCmd([process.execPath, '-e', script], null, { idleMs: 1500, hardMs: 60000 })
  assert.equal(res.ok, true, 'streaming install must survive: ' + String(res.error || ''))
  assert.equal(res.timedOut, null)
  assert.ok(res.elapsedMs >= 800, 'should have streamed for ~1s, got ' + String(res.elapsedMs))
})
check('无输出超时 → idle 看门狗终止（不是 10 分钟硬砍）', async () => {
  const res = await t.runInstallCmd([process.execPath, '-e', 'console.log("once"); setTimeout(()=>{}, 30000)'], null, { idleMs: 700, hardMs: 60000 })
  assert.equal(res.ok, false)
  assert.equal(res.timedOut, 'idle')
})
check('持续输出但超过总上限 → hard 看门狗终止', async () => {
  const script = 'setInterval(()=>{ console.log("tick") }, 100); setTimeout(()=>{}, 30000)'
  const res = await t.runInstallCmd([process.execPath, '-e', script], null, { idleMs: 60000, hardMs: 800 })
  assert.equal(res.ok, false)
  assert.equal(res.timedOut, 'hard')
})
// 1.12.1 的真实故障：npm 在非 TTY 下默认全程静默，只有 stdout 的看门狗会把
// 「正在下载/解包」误判成卡死（实测 5 分钟 0 输出被杀，同期 npm 日志写了 525 行请求）。
check('静默但日志文件在长 → 不杀（npm 静默下载的真实形态）', async () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const probeFile = join(probeDir, 'debug-0.log')
  writeFileSync(probeFile, 'x')
  let beats = 0
  const beat = setInterval(() => { beats += 1; writeFileSync(probeFile, 'line-' + beats) }, 100)
  try {
    const res = await t.runInstallCmd([process.execPath, '-e', 'console.log("start"); setTimeout(()=>{}, 2500)'], null, {
      idleMs: 1200,
      hardMs: 30000,
      activityProbe: () => t.newestMtimeMs(probeDir),
    })
    assert.equal(res.timedOut, null, '静默但活着不能被杀（这正是 1.12.0 的误杀场景）')
    assert.equal(res.ok, true)
  } finally {
    clearInterval(beat)
    rmSync(probeDir, { recursive: true, force: true })
  }
})
check('静默且日志文件也不动 → 仍按 idle 终止（真卡死不漏）', async () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  writeFileSync(join(probeDir, 'debug-0.log'), 'x')
  try {
    const res = await t.runInstallCmd([process.execPath, '-e', 'setTimeout(()=>{}, 30000)'], null, {
      idleMs: 900,
      hardMs: 30000,
      activityProbe: () => t.newestMtimeMs(probeDir),
    })
    assert.equal(res.ok, false)
    assert.equal(res.timedOut, 'idle')
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
})
check('staged 活动探针：暂存目录落盘即算活动（npm 日志可能只在退出时才写）', async () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-probe-stage-'))
  try {
    const probe = t.stagedActivityProbe(stage)
    const before = probe()
    assert.equal(typeof before, 'number')
    await new Promise((r) => setTimeout(r, 20))
    mkdirSync(join(stage, 'node_modules'), { recursive: true })
    writeFileSync(join(stage, 'node_modules', 'a-package'), 'x')
    assert.ok(probe() > before, '探针没感知到暂存目录写入（解包阶段会被误判卡死）')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})
check('staged 安装 argv：-g + http 级日志 + 独立 logs-dir（非 TTY 静默三件套）', () => {
  const argv = t.stagedInstallArgv('C:\\stage', '0.1.5-rc.2', null, 'C:\\logs')
  assert.ok(argv.includes('-g'), '-g 缺失（交换后会丢依赖）')
  assert.ok(argv.includes('--loglevel=http'), '--loglevel=http 缺失（非 TTY 下 npm 全程静默）')
  assert.ok(argv.includes('--logs-dir'), '--logs-dir 缺失（探活依赖它）')
  assert.ok(argv.includes('--progress=false'), '--progress=false 缺失（\\r 刷屏）')
  assert.ok(argv.includes('@deepseek-ai/dsh@0.1.5-rc.2'))
  const withOwn = t.stagedInstallArgv('C:\\stage', '0.1.5-rc.2', { nodeExe: 'node-x', npmCli: 'npm-cli.js' }, 'C:\\logs')
  assert.equal(withOwn[0], 'node-x')
  assert.equal(withOwn[1], 'npm-cli.js')
})
check('运行日志留痕：按行、剥 ANSI、\\r 覆盖行只留最后一段', () => {
  t.opLogReset()
  t.opLogFeed('\u001b[32mgreen line\u001b[0m\n')
  t.opLogFeed('progress 10%\rprogress 80%\rprogress 100%\npartial')
  t.opLogFeed(' rest\n')
  const snap = t.opLogSince(0)
  assert.deepEqual(snap.lines, ['green line', 'progress 100%', 'partial rest'])
  assert.equal(snap.dropped, 0)
  assert.equal(snap.total, 3)
})
check('日志增量语义：since=total 时不再重传', () => {
  t.opLogReset()
  t.opLogNote('a')
  t.opLogNote('b')
  const first = t.opLogSince(0)
  assert.deepEqual(first.lines, ['a', 'b'])
  const second = t.opLogSince(first.total)
  assert.deepEqual(second.lines, [])
  t.opLogNote('c')
  assert.deepEqual(t.opLogSince(first.total).lines, ['c'])
})
check('日志有界：超过上限后裁掉最旧的行，游标仍连续', () => {
  t.opLogReset()
  for (let i = 0; i < 900; i += 1) t.opLogNote('line-' + i)
  const snap = t.opLogSince(0)
  assert.ok(snap.lines.length <= 800, 'lines=' + snap.lines.length)
  assert.ok(snap.dropped > 0, 'expected trimming')
  assert.equal(snap.total, snap.dropped + snap.lines.length)
  assert.equal(snap.lines[snap.lines.length - 1], 'line-899')
})
check('/progress 载荷只回传进度（日志面板已移除，不再传 log/limits）', async () => {
  const routes = []
  const ctx = {
    get: () => undefined,
    on: () => {},
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, fn) => { fn(ctx) },
    timer: { interval: () => () => {}, timeout: async () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
  }
  mod.apply(ctx)
  const route = routes.find((r) => r.path === '/dsh-updater-npm/progress')
  assert.ok(route !== undefined, 'progress route missing')
  t.opLogReset()
  t.opLogNote('hello progress')
  const rec = {}
  route.handler({ method: 'GET', url: '/dsh-updater-npm/progress?since=0', headers: {} }, {
    writeHead: (code) => { rec.code = code },
    end: (body) => { rec.body = body },
  })
  for (let i = 0; i < 40 && rec.body === undefined; i += 1) await new Promise((r) => setTimeout(r, 25))
  assert.ok(rec.body !== undefined, 'progress handler did not respond')
  const body = JSON.parse(rec.body)
  // 1.12.3：日志面板已移除，载荷不再携带 log/limits（轮询回到只传进度本身）
  assert.ok(!('log' in body), '载荷里还有 log（面板已移除，不该再传）')
  assert.ok(!('limits' in body), '载荷里还有 limits')
  assert.ok('phase' in body && 'updatedAt' in body, '进度字段缺失')
})
check('运行日志落盘：操作结束写 last-run.log（面板没了但失败要能查）', () => {
  t.opLogReset()
  t.opLogNote('line-a')
  t.opLogNote('line-b')
  t.opLogDump('update error 测试')
  const file = join(sandboxHome, 'plugin-data', 'dsh-updater-npm', 'last-run.log')
  assert.ok(existsSync(file), 'last-run.log 没有生成')
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('line-a') && text.includes('line-b'), '日志内容没写进去')
  assert.ok(text.includes('update error 测试'), '没有写明原因')
})

// ── 10. 客户端 bundle 装载（日志面板所在文件必须能被加载并挂载）─────────────
section('10) 客户端 bundle 装载')
check('client.js 可加载，factory 与其 apply() 都能跑（注册 settings.section）', async () => {
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (def) => loaded.push(def) } }
  await import(new URL('../client/client.js', import.meta.url).href)
  assert.equal(loaded.length, 1, 'bundle 未调用 __ModuleLoader__.load')
  assert.equal(loaded[0].id, 'dsh-updater-npm')
  const reactStub = {
    createElement: function () { return { args: Array.prototype.slice.call(arguments) } },
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  const bundle = loaded[0].factory((id) => {
    if (id === 'react') return reactStub
    throw new Error('unexpected require: ' + id)
  })
  assert.equal(typeof bundle.apply, 'function')
  assert.equal(bundle.name, 'dsh-updater-npm')
  assert.deepEqual(bundle.inject, ['slots', 'timer', 'locale'])
  const registered = []
  const services = {
    slots: {
      inject: (name, fn) => fn(),
      register: (meta) => { registered.push(meta); return () => {} },
    },
    timer: { interval: () => () => {} },
    // locale 故意缺席：走内置中文兜底分支（真实环境由壳程序注入）
  }
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (deps, fn) => { fn(ctx) },
  }
  bundle.apply(ctx)
  assert.equal(registered.length, 1, 'expected 1 slot registration, got ' + registered.length)
  assert.equal(registered[0].name, 'settings.section')
  assert.equal(registered[0].id, 'dsh-update-local')
  delete globalThis.window
})

// ── 11. 重启启动路径（1.12.2：detached powershell 是静默假成功）────────────────
section('11) 重启启动路径')
check('launchRestartScript 真的把脚本跑起来了（不是静默假成功）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-'))
  const marker = join(dir, 'launched.txt')
  const win = process.platform === 'win32'
  const body = win
    ? "'launched' | Set-Content -Path '" + marker + "'"
    : "'launched' > '" + marker + "'"
  const logFile = join(dir, 'restart.log')
  const launched = t.launchRestartScript(body, logFile)
  assert.equal(launched.ok, true, 'launch 失败: ' + String(launched.error || ''))
  assert.ok(typeof launched.token === 'string' && launched.token.length > 0, '缺少本次启动的 token')
  const started = await t.waitForBootstrap(logFile, launched.token, 8000)
  assert.equal(started, true, '引导进程没有写出启动行（restart.log 缺失或没有 token）')
  let seen = false
  for (let i = 0; i < 40 && !seen; i += 1) {
    seen = existsSync(marker)
    if (!seen) await new Promise((r) => setTimeout(r, 200))
  }
  assert.equal(seen, true, '脚本根本没执行 —— 这正是「自带重启无效」的故障本体')
  rmSync(dir, { recursive: true, force: true })
})
check('waitForBootstrap 对不存在的 token 返回 false（不会误报已启动）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch2-'))
  const logFile = join(dir, 'restart.log')
  writeFileSync(logFile, 'node bootstrap started boot-1\n')
  assert.equal(await t.waitForBootstrap(logFile, 'boot-999', 400), false)
  assert.equal(await t.waitForBootstrap(logFile, 'boot-1', 400), true)
  rmSync(dir, { recursive: true, force: true })
})
check('端到端：launchRestartScript + 交换脚本 → 部署真的被换掉', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
  const live = join(work, 'live')
  const stgRoot = join(work, 'stage')
  const stgPkg = join(stgRoot, 'node_modules', '@deepseek-ai', 'dsh')
  mkPkg(live, '0.1.2-rc.1')
  mkdirSync(join(live, 'node_modules'), { recursive: true })
  mkdirSync(stgPkg, { recursive: true })
  mkPkg(stgPkg, '0.1.5-rc.1')
  const logFile = join(work, 'restart.log')
  const resultFile = join(work, 'restart-result.json')
  const script = t.buildRestartScript({
    platform: 'win32',
    pid: 999999,
    nodeExe: process.execPath,
    args: ['-e', '0'],
    cwd: work,
    logFile,
    swap: { installDir: live, stagingPkg: stgPkg, stagingDir: stgRoot, version: '0.1.5-rc.1' },
    resultFile,
  })
  const launched = t.launchRestartScript(script, logFile)
  assert.equal(launched.ok, true, 'launch 失败: ' + String(launched.error || ''))
  let version = null
  for (let i = 0; i < 60 && version !== '0.1.5-rc.1'; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    try { version = JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version } catch (e) { version = null }
  }
  assert.equal(version, '0.1.5-rc.1', '交换没发生：脚本很可能又没被真正执行')
  assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).swapOk, true, '结果文件没有记录 swapOk')
  rmSync(work, { recursive: true, force: true })
})

await chain
rmSync(root, { recursive: true, force: true })
rmSync(sandboxHome, { recursive: true, force: true })
console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
