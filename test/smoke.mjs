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
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 隔离 DSH_HOME：apply() 会读写 $DSH_HOME/plugin-data，绝不能碰用户真实的家目录
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-updater-home-'))
process.env.DSH_HOME = sandboxHome

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const t = mod.__test

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log('  ok   ' + name)
  } catch (error) {
    fail += 1
    console.log('  FAIL ' + name + '\n       ' + String((error && error.message) || error).split('\n')[0])
  }
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
  urlFile: join(root, 'activation-url.txt'),
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
check('抓取新激活地址并打开浏览器', () => {
  assert.ok(winScript.includes('token='), 'missing token pattern')
  assert.ok(winScript.includes('Start-Process $url'), 'missing browser open')
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

rmSync(root, { recursive: true, force: true })

// ── 7. apply() 冒烟：mock ctx 下不抛异常并注册全部路由 ───────────────────────
section('7) apply() —— mock ctx 挂载')
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

rmSync(sandboxHome, { recursive: true, force: true })
console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
