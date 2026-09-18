// dsh-updater-npm 冒烟测试：node smoke-test.mjs
// 验证 npm CLI 定位与 Windows spawn 回退（不联网、不下载任何包）。
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

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
  const out = await run(t.shellArgv(argv, true))
  check('转义后含空格参数完整传给 npm', !/Unknown command/i.test(out), out.trim().slice(0, 120))
}

console.log('\n' + (failed === 0 ? 'ALL PASSED ✓' : failed + ' FAILED ✗'))
process.exit(failed === 0 ? 0 : 1)
