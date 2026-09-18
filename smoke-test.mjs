// dsh-updater-npm 冒烟测试：node smoke-test.mjs
// 验证 npm CLI 定位与 Windows spawn 回退（不联网、不下载任何包）。
import { pathToFileURL } from 'node:url'
import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const mod = await import(pathToFileURL(join(here, 'lib', 'index.js')).href)
const t = mod.__test

let failed = 0
const check = (name, cond, extra = '') => {
  console.log((cond ? '✓' : '✗') + ' ' + name + (cond ? '' : (extra ? ' — ' + extra : '')))
  if (!cond) failed += 1
}

console.log('=== 1) npmCliFor 定位 ===')
const candidates = []
// 当前进程自身所在安装（若从源码跑，argv[1] 不是 npm 全局安装，用常见前缀兜底）
const selfDir = dirname(dirname(process.argv[1]))
candidates.push(selfDir)
if (process.platform === 'win32' && existsSync(join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'))) {
  candidates.push(join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
}
if (process.env.DSH_HOME) {
  for (const name of ['web', 'tui']) {
    candidates.push(join(process.env.DSH_HOME, 'profiles', name, 'node_modules', '@deepseek-ai', 'dsh'))
  }
}
let own = null
for (const c of candidates) {
  const r = t.npmCliFor(c)
  if (r !== null) { own = r; break }
}
check('npmCliFor 返回非 null（PATH 回退或 prefix 定位）', own !== null)
if (own !== null) {
  check('npm-cli.js 存在: ' + own.npmCli, existsSync(own.npmCli))
  check('node.exe 存在: ' + own.nodeExe, existsSync(own.nodeExe))
}

console.log('\n=== 2) node + npm-cli.js 可直接启动（installStaged 的启动方式）===')
if (own !== null) {
  await new Promise((resolve) => {
    const c = spawn(own.nodeExe, [own.npmCli, '--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => {
      check('npm --version 退出码 0（got ' + code + '）', code === 0)
      if (code === 0) console.log('      npm 版本: ' + out.trim())
      else console.log('      stderr: ' + err.trim().slice(0, 200))
      resolve()
    })
  })
}

console.log('\n=== 3) Windows 裸命令 shell 回退 ===')
if (process.platform === 'win32') {
  await new Promise((resolve) => {
    const c = spawn('npm', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.on('close', (code) => {
      check("spawn('npm', {shell:true}) 退出码 0（got ' + code + '）", code === 0, 'ENOENT 即回归')
      if (code === 0) console.log('      npm 版本: ' + out.trim())
      resolve()
    })
  })
}

console.log('\n=== 4) Windows shell 回退：含空格参数必须自己转义 ===')
// 回退路径是「裸 npm + shell:true」，而 --prefix / --logs-dir 落在用户目录下；
// 用户名带空格时（C:\Users\John Smith）Node 不转义参数，cmd 会把路径拆开。
if (process.platform === 'win32') {
  const argv = ['--prefix', 'C:\\Users\\a b\\stage', 'config', 'get', 'prefix']
  const run = (args) => new Promise((resolve) => {
    const c = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { out += d })
    c.on('error', () => resolve(''))
    c.on('close', () => resolve(out))
  })
  check('quoteWinArg 给含空格参数补引号', t.quoteWinArg('C:\\Users\\a b\\s') === '"C:\\Users\\a b\\s"')
  check('quoteWinArg 不动普通参数', t.quoteWinArg('install') === 'install')
  check('不借 shell 时不改动参数（POSIX 一律不走 shell）',
    t.shellArgv(['a b', 'install'], false).join('|') === 'a b|install')
  const out = await run(t.shellArgv(argv, true))
  check('转义后含空格参数完整传给 npm', !/Unknown command/i.test(out), out.trim().slice(0, 120))
}

console.log('\n=== 5) 平台路径拼接：buildRestartScript 必须跟着 platform 走 ===')
{
  const base = {
    pid: 1, nodeExe: '/usr/bin/node', args: ['bin.js'], cwd: '/tmp', logFile: '/tmp/r.log',
    swap: {
      installDir: '/tmp/inst/node_modules/@deepseek-ai/dsh',
      stagingPkg: '/tmp/stg/node_modules/@deepseek-ai/dsh',
      stagingDir: '/tmp/stg', version: '9.9.9',
    },
    resultFile: '/tmp/res.json',
  }
  const lin = t.buildRestartScript({ ...base, platform: 'linux' })
  check('POSIX 分支用正斜杠拼路径',
    lin.includes("'/tmp/stg/node_modules/@deepseek-ai/dsh/package.json'"))
  check('POSIX 分支不出现反斜杠路径（旧实现会全翻成 \\）', !lin.includes('\\package.json'))
  const win = t.buildRestartScript({ ...base, platform: 'win32', nodeExe: 'C:\\node.exe', cwd: 'C:\\tmp' })
  check('Windows 分支仍用反斜杠拼路径', win.includes('\\package.json'))
}

console.log('\n=== 6) registry 解析：镜像站 / 内网环境 ===')
{
  const tmp = join(tmpdir(), 'dsh-npmrc-' + Date.now())
  writeFileSync(tmp, '# comment\n; another comment\nregistry=https://registry.npmmirror.com/\n')
  check('registryFromNpmrc 跳过注释并取到 registry=',
    t.registryFromNpmrc(tmp) === 'https://registry.npmmirror.com/')
  writeFileSync(tmp, 'registry=not-a-url\n')
  check('非 URL 的值原样返回（由 registryBase 决定不采信）',
    t.registryFromNpmrc(tmp) === 'not-a-url')
  rmSync(tmp, { force: true })
  const rb = t.registryBase()
  check('registryBase 返回可用 http(s) 基址: ' + rb, /^https?:\/\/\S+$/i.test(rb))
}

console.log('\n=== 7) locale bump 契约：导航红点 ===')
{
  // 复刻 dsh-client-locale 的真实校验（register 两参形式的键是 locale id）
  const LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
  check('旧写法 "~nav12345-1" 不是合法 locale id（这就是原 bug）', !LOCALE_ID_PATTERN.test('~nav12345-1'))
  check('新写法使用的 "zh" 是合法 locale id', LOCALE_ID_PATTERN.test('zh'))
  const src = readFileSync(join(here, 'client', 'client.js'), 'utf8')
  check('client 不再把合成键当作 locale id 注册', !/locale\.register\(NS,\s*\{\s*\[/.test(src))
  check('client 改用三参形式 + 唯一命名空间', src.includes('locale.register(NS + ":navbump:"'))
}

console.log('\n=== 8) locateInstall 兜底：只能返回真实安装目录，绝不能猜错 ===')
{
  // 本文件不是 bin.js，所以走的就是兜底分支。能否解析到 DSH 取决于机器
  // （仓库检出无 node_modules，profile 里没有 DSH 时解析不到），所以只断言
  // 「要么 null、要么是一个真的 dsh 安装目录」——不允许出现看似成功的假路径。
  const located = await t.locateInstall(null)
  if (located === null) {
    check('解析不到时返回 null（而不是伪造路径）', true)
  } else {
    check('兜底返回的 installDir 含 package.json', existsSync(join(located.installDir, 'package.json')))
    check('兜底返回的 installDir 含 lib/bin.js', existsSync(join(located.installDir, 'lib', 'bin.js')))
    check('mode 取值合法', located.mode === 'npm-global' || located.mode === 'source')
    console.log('      解析到: ' + located.installDir + '  (' + t.localVersionOf(located.installDir) + ')')
  }
}

console.log('\n' + (failed === 0 ? 'ALL PASSED ✓' : failed + ' FAILED ✗'))
process.exit(failed === 0 ? 0 : 1)
