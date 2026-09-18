# dsh-updater-npm

[English](README.md) | **中文**

<!-- 文件名故意是下划线 README_zh.md，不要改回 README.zh.md：
     npm 用 glob('{README,README.*}') 挑包 readme，README.zh.md 会命中且排在 README.md 之前，
     导致 npm 页面显示中文；下划线命名不匹配该模式，npm 才会取英文的 README.md。 -->

DSH 更新器 + 官方文档同步器，用于 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)。

设置页提供两个卡片：

- **DSH 更新（npm）**：自动检查 `@deepseek-ai/dsh` 的 npm 最新版本，一键更新，带实时进度与完成交换的「重启 DSH」按钮。
- **DSH 文档（官方）**：把 `deepseek-ai/deepseek-harness` 官方 `docs/` **增量同步**到 `$DSH_HOME/docs-sync/`（按 GitHub blob sha 跳过未变文件），带进度条，并提供 `dsh_docs_search` / `dsh_docs_read` 两个模型工具。

![设置页的「DSH 更新」与「DSH 文档」卡片](https://raw.githubusercontent.com/SiriusWJ/dsh-updater-npm/master/docs/dsh-update-card-1.13.png)

[安装](#安装) · [使用](#使用) · [运行模式](#运行模式) · [升级安全网](#升级安全网) · [路由](#路由) · [License](#license)

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-updater-npm

# 或从 GitHub 安装
dsh plugin --profile web add github:SiriusWJ/dsh-updater-npm
```

安装后重启 dsh web，设置页出现「DSH 更新」和「DSH 文档」两个卡片。

> **多语言**：界面与宿主端消息支持**中文 / English**，自动跟随系统语言切换
> （也可在 设置 → 通用 → Language 手动选择）；`dsh_docs_search` /
> `dsh_docs_read` 工具描述与输出同样跟随系统语言。

## 使用

### DSH 更新

- 自动检查每 30 分钟一次（页面每 60 秒刷新缓存结果）。
- 检测到新版本时，设置页左侧导航「DSH 更新」旁会显示一个**红色小圆点**（🔴）。
- 点击「通过 npm 更新」执行 `npm install -g @deepseek-ai/dsh@latest`，期间显示**实时进度**
  （进度条 + 最近几行 npm 输出尾部）。**没有滚动日志面板**——npm 的完整输出在操作结束时
  写入 `$DSH_HOME/plugin-data/dsh-updater-npm/last-run.log`，需要排查时看文件即可，界面保持清爽。
- 更新完成后出现**「重启 DSH」按钮**——点击后按原启动命令自动退出并重新拉起（**跨平台**：Windows 用 PowerShell，macOS/Linux 用 `/bin/sh`；源码树更新与部署修复完成后同样提供该按钮）。
  **重启后不需要手动打开新的激活地址**：浏览器会自行重新鉴权，不会弹出新窗口。
- 交换成功后（即新版已经跑起来）卡片会显示**回滚点占用**与**「清理回滚点」**按钮：交换时旧部署会被改名保留成
  `<安装目录同级>/dsh.old-<时间戳>` 作为回滚点（实测 222 MB），确认新版稳定后一键释放。
  安全约束：只列/只删**版本与当前运行版本不同**的回滚点，现役部署永远不动。
- 版本比较为 semver 风格：本地比远端新（如 rc.7 vs rc.6）时不会误报更新。

### 超时策略与运行日志（v1.12 起）

旧版对 npm 安装用「10 分钟一刀切」硬超时。慢速网络下 staged 安装实测会在 9 分 25 秒
只完成 247 个 tarball（222 MB 依赖树的 231/239 个 `@deepseek-ai` 子包）后被杀掉，
报错还只是一句 `暂存安装失败: npm`——**既不是卡死，也不是网络不通，就是撞了硬超时**。

现在改为双阈值看门狗，并可通过 `$DSH_HOME/plugin-data/dsh-updater-npm/config.json` 调整：

```json
{
  "docsEnabled": false,
  "npmIdleMinutes": 10,
  "npmTimeoutMinutes": 60
}
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `npmIdleMinutes` | `10` | 连续多少分钟**毫无活动**才判定卡死并终止（慢但一直在动 → 不会被杀） |
| `npmTimeoutMinutes` | `60` | 总时长硬上限，兜底防止无限挂起 |

**「有活动」的判定（v1.12.1 修正）**：只看子进程 stdout 是不够的——npm 在非 TTY 下
默认几乎不输出，实测一次 5 分钟的安装 stdout **一行都没有**，而同期 npm 自己的 debug
日志写了 525 行请求，结果被自己的看门狗误杀。现在三路取最大值：

1. `--loglevel=http`：让 npm 把每个请求/阶段打到 stdout（实测加完后 stdout 立刻有
   `npm http fetch GET 200 …` 行，从 0 行变成 1111 行）；
2. `--logs-dir`：npm 的完整 debug 日志写进 `plugin-data/dsh-updater-npm/npm-logs/`；
3. **文件系统信号**：npm 的 debug 日志在 Windows 上**可能整场只在退出时才落盘**
   （实测 14 秒的安装里它 12 秒都是 0 字节），所以同时盯暂存目录与暂存
   `node_modules/` 的写入——解包阶段会不停往里落文件，这才是真正的兜底心跳。

只有**三路全都不动**才会判卡死；静默期每分钟往日志里追加一条 `[heartbeat] …`（落在 `last-run.log`）。

- 超时被杀时，日志里会留 `[watchdog] …` 与 `[exit] …` 两行，错误信息直接说明是
  **空闲超时**还是**总时长超限**，并带上已运行时长，不再是含义不明的 `: npm`。
- 同一套策略覆盖：staged 安装、非 Windows 原地 `npm install -g`、源码树 `pnpm/npm install`；
  `msiexec /qn` 静默安装因为没有输出，单独放宽到 10 分钟空闲判定。
- `/dsh-updater-npm/progress` 只回传进度本身（不再携带日志）。

### 插件自身版本与自更新闸门

- 「DSH 更新」卡片会显示**本插件自己的版本号**，并对照 npm 上的 `dsh-updater-npm`
  最新版检查（`GET https://registry.npmjs.org/dsh-updater-npm/latest`，10 分钟缓存）。
- 若插件自身有新版本，卡片会显示提示，并给出可直接复制的命令
  （`dsh plugin --profile <你的 profile> add dsh-updater-npm@<最新版>`）。
  此时**「通过 npm 更新」按钮被禁用**；即使绕过界面直接调 `/update`，宿主端也会拒绝并返回
  同一条提示。
- 原因：升级 DSH 的动作是由**当前运行的插件代码**执行的，旧版插件的升级流程本身就可能有问题
  （例如 1.9.0 在 Windows 上 staged 安装缺 `-g`，交换后会丢掉新版本的依赖）。
- **离线性放行**：registry 不可达或版本未知时不会拦截，只在「确定存在更新版插件」时才拦，
  避免内网/离线环境被误锁。
- 源码树模式（`git pull` 更新）不受此闸门影响，只显示提示。

### DSH 文档

- **同步开关（默认关闭）**：设置页「DSH 文档」卡片顶部有「自动同步官方文档」开关。
  关闭（默认）时**不自动同步、不加载 `dsh_docs_search` / `dsh_docs_read` 工具**；
  开启后才自动同步（首次启动约 217 篇：英文 + 中文 .zh.md，之后每 24 小时静默增量），
  并注册文档工具。开关状态保存在 `$DSH_HOME/plugin-data/dsh-updater-npm/config.json`。
- 点击「同步官方文档」手动同步（需先开启开关），显示**进度条**（已下载/总数 + 当前文件名）与阶段（获取清单 → 下载 → 重建索引）。
- 文档区支持搜索与阅读；对话中也可直接用模型工具：
  - `dsh_docs_search` —— 搜索本地官方文档索引（中文查询自动优先中文文档）
  - `dsh_docs_read` —— 读取一篇文档（支持按章节聚焦，80KB 截断，防路径穿越）

文档存储于 `$DSH_HOME/docs-sync/`，索引为 `$DSH_HOME/docs-sync/.index.json`。

## 运行模式

> **Windows + 缺 PowerShell 7**：DSH 的 shell 工具依赖 `pwsh`（PowerShell 7）。
> 若检测到 Windows 上未安装 pwsh，「DSH 更新」卡片会显示提示和**「一键安装 PowerShell 7」**按钮
> （优先 `winget install Microsoft.PowerShell`，不可用时自动改走官方 win-x64 MSI 静默安装，
> 带实时进度；完成后重启 DSH 生效）。

插件会自动识别当前 dsh 的**运行模式**并诚实处理：

| 模式 | 识别依据 | 更新方式 | 说明 |
| --- | --- | --- | --- |
| npm-global | `argv[1]` 为 `<install>/lib/bin.js` | **Windows：staged 更新**（新版本装入独立暂存目录 → 点击「重启 DSH」时无锁原子替换并重启，失败自动回滚旧版）；非 Windows：原地 `npm install -g`，完成后点「重启 DSH」 | 正常部署场景；**Windows 上更新目标即运行实例自身（含 native 依赖），原地 npm install 会撞 EBUSY 导致半拆半装**——staged 流程全程不触碰运行中的部署目录，替换时旧目录先改名备份（`.old-*`），新包校验失败自动恢复当前版本；重启脚本会先校验暂存新包（不通过则放弃整个操作、进程不退出）；每次启动检测部署目录完整性，损坏时提示「修复部署」一键重装当前版本（同样手动重启） |
| source（源码树） | `argv[1]` 含 `bin.ts` / `tsx` / `apps/` | **源码树更新**：`git fetch` → `git pull --ff-only` → 安装依赖（pnpm/npm） | 源码树运行（如 `pnpm dsh web`）时 npm -g 不影响运行实例；设置页显示分支/本地与远端提交/落后数，一键更新；工作区有未提交修改或未安装 git 时会明确提示并禁用按钮 |

> **多副本保护**：环境里可能有多个 dsh 副本（多个 Node 安装的全局目录、DSH profiles 等）。
> 插件只更新**当前运行的这个**：优先用当前实例所属 Node 安装自带的 npm 执行（避免 PATH
> 上的 npm 属于别的 Node 而把更新写到别处）；`/check` 会列出检测到的其他副本并显示警告；
> 若 npm 执行成功但当前副本版本没变（更新落空），会明确报错而不是假成功。
> 副本检测按 **realpath 去重**：指向运行实例的 junction/符号链接（如
> `$DSH_HOME/profiles/node_modules` 里的依赖镜像）不会误报为独立副本。

> 版本回退排查：若"更新后显示一致、重启后回到旧版"，说明运行的是源码树而 npm 更新只改了全局安装。切换为 npm-global 启动（如桌面快捷方式指向 `D:\tools\node22\dsh.cmd web`）后更新即生效。

## 升级安全网

> 以下是 0.1.2-rc.1 → 0.1.5-rc.1 一次真实跨版本升级踩坑后逐条补上的防护，v1.10.0 起生效。

1. **暂存安装必须带 `-g`（结构一致性）**：`npm install --prefix <staging>`（不带 `-g`）
   产出的是**提升（hoisted）**布局，而现网 npm 全局部署是**嵌套**布局
   （`@deepseek-ai/dsh/node_modules/...`，包目录自包含）。交换脚本只搬包目录，
   不带 `-g` 就等于**把新部署的依赖全部丢掉**。现在命令固定带 `-g`，并在写「待交换」
   标记前校验：现网嵌套则暂存必须是嵌套，且用运行实例自带的 node 执行
   `lib/bin.js --version` 确认新包真能跑起来——任一环节不过就中止（不改部署、不重启）。
2. **交换校验先于杀进程**：重启脚本在结束当前进程**之前**校验暂存包（存在性 + 结构一致性），
   不通过则 `exit 1` —— 旧进程继续运行，不会出现「杀完了却换不了」的半死状态。
3. **旧部署保留为回滚点**：交换后旧目录改名为 `dsh.old-<时间戳>` **保留**（不再立即删除），
   并写回重启结果；确认新版稳定后，用卡片上的**「清理回滚点」**按钮释放空间。
4. **改名重试**：刚被结束的进程/子进程可能短暂持有目录句柄，改名最多重试 5 次（每次 3 秒）。
5. **升级前自动备份**：真正会变版本时，先把 `settings.yaml`、`.credentials.yaml`、
   `.agent-presets/`、各 profile 的 `package.json`/`cordis*.yml`/`pnpm-lock.yaml` 等快照到
   `$DSH_HOME/upgrade-backups/dsh-<from>-to-<to>-<时间戳>/`；会话日志在上限 256 MB 以内时一并复制
   （升级后会话会迁移到新格式且**不可降级读取**，备份价值最高）。自动保留最近 5 份。
6. **重启后不需要新的激活地址**：DSH 0.1.5 起 Web 鉴权 cookie 由「本次激活」的密钥签名，
   重启即失效，但**浏览器会自行重新鉴权**。（v1.12.2 及以前，重启脚本会抓取新的
   `?token=` 地址写入 `activation-url.txt` 并自动打开浏览器；v1.12.3 起整套移除，因为没有必要。）
7. **遗留文件检测与一键清理**：`/check` 会报告未被引用的 `staging-*`/`repair-*` 遗留目录
   （实测有一次未完成的更新留下 **222 MB**）和 npm 中断安装残留的 `.<name>-<hash>` 目录
   （实测 **65 MB** 级）；卡片出现「清理遗留文件」按钮，粘滞超过 6 小时的暂存目录也会在启动时自动回收。
8. **跨版本破坏性变更提示**：目标版本跨已知的破坏性区间（当前登记 `0.1.5`：
   会话格式 V3 不可降级、persona `text` → `prefix`/`suffix`、插件 API 与槽位变更）时，
   卡片会显示提示并提供 release notes 链接。
9. **重启启动器真的会启动（v1.12.2）**：Windows 上 `spawn('powershell.exe', …, { detached: true })`
   等于 `DETACHED_PROCESS`——脚本一行都不执行，spawn 却返回 `exit=0`，是典型静默假成功。
   现在改为 detached 启动 **node 引导**，由引导以普通子进程方式运行平台脚本，并把
   `node bootstrap started <token>` 写进 `restart.log`；宿主端只有在等到该 token（≤ 5 秒）
   之后才交出暂存包，否则保留 `pending-swap.json` 与暂存目录并报明确错误。

## 路由

- `GET  /dsh-updater-npm/check` —— 更新检查（10 分钟缓存；附带跨版本提示、上次重启结果、待交换暂存包、遗留文件与回滚点汇总）
- `POST /dsh-updater-npm/update` —— 执行 npm 更新（同源保护；先自动备份再暂存）
- `POST /dsh-updater-npm/restart` —— 重启当前 DSH 实例（同源保护；若有待交换暂存包则先原子替换部署再重启，支持 Windows/macOS/Linux）
- `POST /dsh-updater-npm/cleanup` —— 清理遗留暂存目录与 npm 安装残留（同源保护）
- `POST /dsh-updater-npm/cleanup-rollback` —— 清理版本与当前运行版本不同的回滚点（同源保护）
- `GET  /dsh-updater-npm/progress` —— 更新/同步实时进度（轮询；只回传进度本身）
- `GET  /dsh-updater-npm/docs/status` —— 文档同步状态
- `POST /dsh-updater-npm/docs/sync` —— 触发文档同步（同源保护）
- `GET  /dsh-updater-npm/docs/search?q=&lang=&limit=` —— 本地索引搜索
- `GET  /dsh-updater-npm/docs/read?path=&section=` —— 读取文档

## 更新日志

### v1.13.3

- **仅文档改动，无代码变更。**
- README 加入设置页两张卡片的截图（取自正在运行的 1.13.2 构建）：可见当前卡片形态
  （没有运行日志面板、没有激活地址行）以及「插件版本」一行。v1.13.1 删掉的旧截图
  （图中还是已移除的日志面板）由 `docs/dsh-update-card-1.13.png` 接替；文件名里带版本号是故意的，
  否则 GitHub raw CDN 会在一段时间内继续返回旧图。

### v1.13.2

- **仅文档改动，无代码变更。**
- 修掉 npm 页面显示**中文** README 的问题：npm 用 `glob('{README,README.*}')` 挑包 readme，
  取第一个「像 markdown」的命中项，而 `README.zh.md` 既匹配该模式、又排在 `README.md` 之前
  （判定正则是**非锚定**的，结尾的 `.zh.md` 也算 markdown），于是中文那份被选中。
  因此中文文件改名为 **`README_zh.md`**（下划线），不再匹配该模式，npm 现在取英文的 `README.md`。
  两个 README 里都留了注释说明下划线不能改回点号。

### v1.13.1

- **仅文档改动，无代码变更，运行时行为与 v1.13.0 完全一致。**
- README 改为**英文默认**（`README.md`）+ 中文（`README_zh.md`）双语，顶部互相链接；
  中文那份已加入 npm 包白名单。
- 同时修复与代码脱节的段落：删除过时的卡片截图（图中还是 v1.12.3 已移除的运行日志面板）、
  超时段不再提日志面板与 `/progress?since=`、安全网不再描述抓取激活地址
  （浏览器自行重新鉴权）、路由表补上 `cleanup-rollback`、回滚点改为卡片按钮说明，
  并新增安全网第 9 条（node 引导启动器）。

### v1.13.0

- **新增**：交换成功、新版已经跑起来后，卡片显示回滚点占用与**「清理回滚点」**按钮
  （`POST /dsh-updater-npm/cleanup-rollback`）。安全约束写死在宿主端：
  只把版本与当前运行版本不同的 `<leaf>.old-<时间戳>` 当回滚点列出并删除，
  现役部署不会被牵连（冒烟测试对这一点有硬断言）。
- **优化**：卡片提示去掉解释性长句——整段移除 `updNote` / `docsNote` / `pluginOutdatedBody`，
  其余文案压缩成一句（`srcDirty`、`pwshMissingHint`、`deployBrokenWarn`、`npmMismatch`、
  `stagingWasteFound`、`repairRunning`、`docs*Hint` 等），只留状态与操作。
- 测试：58 项（新增回滚点扫描、只删非当前版本、现役部署不被牵连、清理路由同源保护）。

### v1.12.3

按使用反馈做减法：

- **移除**：重启脚本里「抓取新激活地址 + 自动打开浏览器」的整套逻辑（Windows 与 POSIX
  两个分支），重启后不再需要用户去打开新地址；顺带去掉脚本尾部那段最长 2 分钟的空转轮询。
- **移除**：**运行日志滚动面板**——npm 的完整输出改为留痕到
  `plugin-data/dsh-updater-npm/last-run.log`（操作结束即落盘，含 `[watchdog]`/`[exit]` 等
  关键行），界面只保留进度条与几行输出尾部。`/progress` 载荷不再携带 `log` / `limits`，
  轮询开销回到最小。
- 保留：`--loglevel=http`（这是看门狗的真实心跳，不是装饰）、三路活动探针、空闲/硬双阈值超时。
- 测试：改为断言「脚本里不含 token 抓取 / 不弹浏览器」，并新增 `last-run.log` 落盘断言（共 56 项）。

### v1.12.2

修掉「自带的重启无效，外部重启后仍是老版本」这条断链：staged 安装其实**成功**了
（`verbose exit 0` / `info ok`），但重启这一步静默失败，交换永远没发生。

- **根因（实测复现）**：`launchRestartScript` 用
  `spawn('powershell.exe', […], { detached: true })` 启动脚本。Windows 上这等于
  DETACHED_PROCESS——控制台程序会立刻以 `exit=0` 退出且**脚本一行都不执行**，
  而 spawn 不抛错 → 静默假成功。A/B 实测：同一脚本换成 detached **node 引导**后正常执行。
- **修复（严重）**：改为 detached 启动 `node` 引导进程，由引导以「普通子进程」方式
  运行平台脚本；引导会把 `node bootstrap started <token>` 写进 `restart.log`。
- **修复（严重）**：`restartNow` 现在**先确认脚本真的启动**（等到该 token 出现在
  日志里，最多 5 秒）才交出暂存包。没启动就返回明确的失败文案，并**保留
  `pending-swap.json` 与暂存目录**——旧版在这里直接删标记，导致 222 MB 的暂存包
  随后被当成「遗留垃圾」清理，用户在外部重启后既没升级成功也再找不回暂存包。
- **新增**：`/check` 返回 `pendingSwap`（已暂存待交换的版本），卡片会显示
  「已暂存待交换」并**保留「重启 DSH」按钮**——外部重启后仍能一键补上交换；
  若标记还在但暂存目录已丢，则自愈清掉僵尸标记。
- 测试：新增 3 项（共 54 项）——**真跑** `launchRestartScript` 验证脚本确实被执行、
  `waitForBootstrap` 不误报，以及「启动器 + 交换脚本」的端到端交换（假部署上真换目录）。
  旧代码在这一项上必然失败，这正是它此前能骗过 36 项测试的原因。

### v1.12.1

修掉 1.12.0 引入的**新误杀**（18:59:45 那次实测：staged 安装跑了整 5 分钟被自己的看门狗
杀掉，而 npm 其实一直在工作）：

- **根因**：npm 在非 TTY 下默认几乎不往 stdout 输出，1.12.0 的空闲看门狗只看 stdout，
  于是「正在重新校验 525 个 packument」被当成了「卡死」。
- **修复**：staged 安装与原地安装的 npm 参数加 `--loglevel=http --progress=false`，
  让进度与看门狗都有真实的 stdout 心跳。
- **修复**：新增 `--logs-dir` + 活动探针 `activityProbe`——看门狗同时盯 npm 的
  debug 日志目录、暂存目录与暂存 `node_modules/` 的最新 mtime（实测 npm 的 debug
  日志在 Windows 上可能整场只在退出时落盘，光看它不够，文件系统信号才是兜底）；
  **只有三路全都不动**才判卡死；静默期每分钟写一条 `[heartbeat] …`。
- **调整**：默认 `npmIdleMinutes` 5 → **10**（探针已能识别静默期，留更大余量）。
- 测试：新增 4 项（共 51 项）——真跑子进程验证「静默但日志文件在长 → 不杀」
  「静默且日志也不动 → 仍按 idle 终止」，staged argv 必含三件套，以及
  「暂存目录落盘即算活动」的探针行为。
- **端到端实测**（本机 rc.1→rc.2，缓存已热）：真实执行修复后的 argv，
  `added 520 packages in 1m`，暂存树 222.6 MB / 25474 个文件，npm 退出码 0；
  同样一条命令在第一次（冷缓存 + 慢链路）是 9 分 25 秒都没跑完。

### v1.12.0

修掉「慢速网络下更新必然失败」的真实故障（0.1.5-rc.1 → rc.2 实测：18:25:31 起
npm，9 分 25 秒下载了 247 个 tarball 后在 10 分钟整被杀，暂存目录随即清理，
界面只显示 `暂存安装失败: npm`）：

- **修复（严重）**：npm 安装的 10 分钟硬超时改为**空闲超时 +
  总时长硬上限（默认 60 分钟）**。只要有输出就不会被杀，真卡死仍会被终止。
- **修复**：超时/卡死的错误信息不再退化成 `: npm`，而是明确写出原因、已运行时长
  与应调整的配置键。
- **新增**：运行日志留痕（上限 800 行 / 128 KB，剥 ANSI、合并 `\r` 覆盖行）与
  配套的 `/progress` 增量字段（日志面板本身在 v1.12.3 移除，留痕改落到 `last-run.log`）。
- **新增**：配置项 `npmIdleMinutes` / `npmTimeoutMinutes`（`config.json`，
  与 `docsEnabled` 同文件；写开关时**合并写入**，不会抹掉超时配置）。
- **重构**：源码树的依赖安装不再自带第三份 10 分钟硬超时，统一复用同一套看门狗。
- 测试：`test/smoke.mjs` 增加第 9、10 节——真跑子进程验证
  「慢速但持续输出不会被杀」「无输出 → idle 终止」「超上限 → hard 终止」、
  日志留痕与增量语义、`/progress` 载荷字段、客户端 bundle 可装载可挂载。

### v1.11.0

- **新增**：卡片显示插件自身版本号，并对照 npm 最新版检查；
  有新版本时给出「先更新插件再升级 DSH」的提示与可复制的确切命令。
- **新增**：插件自身过旧时**禁用「通过 npm 更新」按钮**，宿主端 `/update` 也会拒绝
  （回退放行：registry 不可达时不拦，避免离线环境被误锁）。
  理由：升级 DSH 由当前插件代码执行，旧插件的升级流程本身可能有问题。
- **新增**：`test/smoke.mjs` 增加第 7、8 节——`apply()` mock 挂载 + **真调 `/check`
  handler** 校验载荷字段（插件版本、破坏性变更、上次重启、遗留文件），共 36 项。
- 其它：测试框架改为顺序 await，async 断言不再被漏计。

### v1.10.0

基于 0.1.2-rc.1 → 0.1.5-rc.1 跨版本升级实战的加固：

- **修复（严重）**：Windows staged 更新的暂存安装缺 `-g`，产出提升布局而现网是嵌套布局，
  交换后会丢掉新部署的全部依赖。现在固定 `-g`，并在交换前校验结构一致性与可执行性。
- **修复**：重启脚本的暂存校验现在发生在结束进程之前，校验不过就整体放弃（旧进程不受影响）。
- **修复**：交换后不再立即删除旧部署，保留为 `dsh.old-<时间戳>` 回滚点。
- **修复**：目录改名增加重试，避免刚结束的子进程短暂持锁导致交换失败。
- **新增**：升级前自动备份（配置 + 预设 + 体积允许时的会话日志），保留最近 5 份。
- **新增**：重启后重定向输出（抓取并自动打开新激活地址的逻辑已在 v1.12.3 移除）。
- **新增**：遗留暂存目录/过期脚本的启动自动回收 + `/cleanup` 路由与「清理遗留文件」按钮；
  `/check` 汇报遗留目录与 npm 安装残留的体积。
- **新增**：跨版本破坏性变更提示与 release notes 链接。
- **新增**：`test/smoke.mjs`（26 项：含在临时目录里真跑生成的 PowerShell 交换脚本）。
- 其它：`readJson` 容忍 UTF-8 BOM（PowerShell `Set-Content` 默认写 BOM）。

## License

[MIT](LICENSE)
