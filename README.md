# dsh-updater-npm

DSH 更新器 + 官方文档同步器 for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)。

设置页提供两个卡片：

- **DSH 更新（npm）**：自动检查 `@deepseek-ai/dsh` 的 npm 最新版本，一键 `npm install -g @deepseek-ai/dsh@latest`，带**实时进度显示**（npm 输出流）。
- **DSH 文档（官方）**：把 `deepseek-ai/deepseek-harness` 官方 `docs/` **增量同步**到本地（按 GitHub blob sha 跳过未变文件），带**进度条**（下载 i/total + 当前文件）；并提供 `dsh_docs_search` / `dsh_docs_read` 两个模型工具，开发时可直接在对话中查阅官方文档。

[English](#english) · [安装](#安装) · [使用](#使用) · [运行模式](#运行模式) · [License](#license)

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-updater-npm

# 或从 GitHub 安装
dsh plugin --profile web add github:SiriusWJ/dsh-updater-npm
```

安装后重启 dsh web，设置页出现「DSH 更新」和「DSH 文档」两个卡片。

## 使用

### DSH 更新

![DSH 更新卡片](https://raw.githubusercontent.com/SiriusWJ/dsh-updater-npm/master/docs/dsh-update-card.png)

- 自动检查每 30 分钟一次（页面每 60 秒刷新缓存结果）。
- 检测到新版本时，设置页左侧导航「DSH 更新」旁会显示一个**红色小圆点**（🔴）。
- 点击「通过 npm 更新」执行 `npm install -g @deepseek-ai/dsh@latest`，期间显示**实时进度**（npm 输出尾部），完成后提示重启 DSH 生效。
- 版本比较为 semver 风格：本地比远端新（如 rc.7 vs rc.6）时不会误报更新。

### DSH 文档

- 首次启动自动同步官方 docs/（约 217 篇：英文 + 中文 .zh.md），之后每 24 小时静默增量同步。
- 点击「同步官方文档」手动同步，显示**进度条**（已下载/总数 + 当前文件名）与阶段（获取清单 → 下载 → 重建索引）。
- 文档区支持搜索与阅读；对话中也可直接用模型工具：
  - `dsh_docs_search` —— 搜索本地官方文档索引（中文查询自动优先中文文档）
  - `dsh_docs_read` —— 读取一篇文档（支持按章节聚焦，80KB 截断，防路径穿越）

文档存储于 `$DSH_HOME/docs-sync/`，索引为 `$DSH_HOME/docs-sync/.index.json`。

## 运行模式

插件会自动识别当前 dsh 的**运行模式**并诚实处理：

| 模式 | 识别依据 | 更新方式 | 说明 |
| --- | --- | --- | --- |
| npm-global | `argv[1]` 为 `<install>/lib/bin.js` | `npm install -g @deepseek-ai/dsh@latest` 直接生效 | 正常部署场景 |
| source（源码树） | `argv[1]` 含 `bin.ts` / `tsx` / `apps/` | **拒绝 npm 更新**并提示 | 源码树运行（如 `pnpm dsh web`）时 npm -g 不影响运行实例，需 `git pull` 更新源码树；设置页会显示警告并禁用更新按钮 |

> 版本回退排查：若"更新后显示一致、重启后回到旧版"，说明运行的是源码树而 npm 更新只改了全局安装。切换为 npm-global 启动（如桌面快捷方式指向 `D:\tools\node22\dsh.cmd web`）后更新即生效。

## 路由

- `GET  /dsh-updater-npm/check` —— 更新检查（10 分钟缓存）
- `POST /dsh-updater-npm/update` —— 执行 npm 更新（同源保护）
- `GET  /dsh-updater-npm/progress` —— 更新/同步实时进度（轮询）
- `GET  /dsh-updater-npm/docs/status` —— 文档同步状态
- `POST /dsh-updater-npm/docs/sync` —— 触发文档同步（同源保护）
- `GET  /dsh-updater-npm/docs/search?q=&lang=&limit=` —— 本地索引搜索
- `GET  /dsh-updater-npm/docs/read?path=&section=` —— 读取文档

## License

[MIT](LICENSE)

---

## English

**dsh-updater-npm** is a DSH updater + official docs sync plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **DSH Update (npm)**: check the latest `@deepseek-ai/dsh` on npm, one-click
  `npm install -g @deepseek-ai/dsh@latest`, with **live progress** (npm output stream).
- **DSH Docs (official)**: incrementally sync `deepseek-ai/deepseek-harness` `docs/`
  to `$DSH_HOME/docs-sync/` (skips unchanged files by GitHub blob sha) with a **progress bar**,
  plus `dsh_docs_search` / `dsh_docs_read` model tools for in-conversation doc lookup.

The plugin detects the **run mode**: `npm-global` (normal; npm update applies directly)
or `source` (source-tree, e.g. `pnpm dsh web`; npm update is refused with a warning
because it does not affect the running instance — use `git pull` instead).

**Install:**

```bash
dsh plugin --profile web add dsh-updater-npm
# or
dsh plugin --profile web add github:SiriusWJ/dsh-updater-npm
```
