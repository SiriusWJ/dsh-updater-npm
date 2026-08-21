// dsh-updater-npm —— Client 面（浏览器 bundle）
//
// 设置页一个合并页面（「DSH 更新」入口；检测到新版本时导航标签旁显示红色圆点）：
//  上半部「DSH 更新」：自动加载检查结果，提供「通过 npm 更新」按钮。
//  下半部「DSH 文档」：官方文档同步状态、手动同步、本地索引搜索与阅读。
// 中英双语：跟随浏览器/系统语言（设置 → 通用 → Language 可手动切换），
// 全部文案走 locale 字典；请求宿主端时附 ?uilang= 让进度/错误消息同步本地化。
// 通过同源 HTTP 路由与宿主端通信（/dsh-updater-npm/*）。
window.__ModuleLoader__.load({
  id: "dsh-updater-npm",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var react = require("react")

    // 更新中动效：spinner 帧 + 已运行时间格式化（客户端本地计算，不依赖服务端轮询节奏）
    var SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    var fmtElapsed = function (startedAt) {
      if (!startedAt) return ""
      var s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      if (s < 60) return s + "s"
      return Math.floor(s / 60) + "m " + (s % 60) + "s"
    }

    var name = "dsh-updater-npm"
    var inject = ["slots", "timer", "locale"]

    // ── 中英字典 ──────────────────────────────────────────────────────────────
    var NS = "dsh-updater-npm"
    var zhDict = {
      nav: "DSH 更新",
      updTitle: "DSH 更新（npm）",
      checking: "正在检查更新…",
      checkFail: "检查失败: ",
      unknownError: "未知错误",
      remoteError: "无法获取远端版本（{err}）",
      updateAvailable: "⚠️ 有新版本可用：v{from} → v{to}",
      upToDate: "✅ 已是最新版本（v{v}）",
      updating: "正在通过 npm 更新…（可能需要 1-3 分钟）",
      updated: "✅ 已更新: v{from} → v{to}",
      restartHint: "⚠️ 新版本已安装，重启 DSH 后生效",
      noUpdate: "已是最新，无需更新",
      updateFail: "更新失败: ",
      hintWrap: "（{hint}）",
      mode: "运行模式",
      updateMethod: "更新方式",
      methodNpmOwn: "npm 全局（当前实例自带 npm）",
      methodNpmPath: "npm 全局（PATH npm，完成后校验）",
      methodSource: "源码树（git pull 更新）",
      srcBranch: "分支",
      srcLocal: "本地提交",
      srcRemote: "远端提交",
      srcBehind: "落后 {n} 个提交",
      srcAhead: "领先 {n} 个提交",
      srcUpdateAvailable: "⚠️ 有新更新可用：{from} → {to}（落后 {behind} 个提交）",
      srcUpToDate: "✅ 源码树已是最新（{commit}）",
      srcDirty: "⚠️ 工作区有未提交修改，请先提交或 git stash 后再更新",
      srcGitMissing: "⚠️ 未检测到 git（未安装或不在 PATH）。请先安装 git 以使用源码树更新。",
      srcNotRepo: "⚠️ 当前目录不是 git 仓库，无法执行源码树更新。",
      srcFetchFailed: "⚠️ git fetch 失败（可能离线或远端不存在）。",
      srcUpdateBtn: "源码树更新（git pull）",
      srcUpdating: "正在更新源码树…",
      srcUpdated: "✅ 源码树已更新: {before} → {after}",
      srcNoUpdate: "源码树已是最新",
      srcFail: "源码树更新失败: ",
      pwshMissingHint: "未检测到 PowerShell 7（pwsh）。DSH 的 shell 工具依赖它，可一键安装。",
      pwshInstallBtn: "一键安装 PowerShell 7",
      pwshInstalling: "正在安装 PowerShell 7…",
      pwshInstalled: "✅ PowerShell 7 已安装，重启 DSH 后生效",
      pwshInstallFail: "PowerShell 7 安装失败: ",
      copiesWarn: "环境中检测到 {n} 个 dsh 副本，仅更新当前运行的这个，其他副本保持不变。",
      npmMismatch: "PATH 上的 npm 与当前运行实例不属于同一 Node 安装，更新将使用当前实例自带的 npm，不会误更新其他副本。",
      localVer: "本地版本",
      remoteVer: "远端版本",
      checkedAt: "最近检查",
      modeSource: "源码树",
      modeNpm: "npm 全局",
      sourceUnavailable: "源码树模式不可用",
      updatingShort: "更新中…",
      updateBtn: "通过 npm 更新",
      notesBtn: "更新说明",
      recheck: "重新检查",
      checkingShort: "检查中…",
      starting: "正在启动更新…",
      waiting: "正在下载/安装，请稍候…（npm 输出将实时显示在下）",
      updNote: "自动检查每 30 分钟一次（页面每 60 秒刷新缓存结果）；npm 全局模式更新执行 npm install -g @deepseek-ai/dsh@latest，完成后需重启 DSH 生效；源码树模式请用 git pull 更新。「更新说明」在新标签页打开 GitHub Releases。",
      docsTitle: "DSH 文档（官方）",
      docsToggleLabel: "自动同步官方文档",
      docsToggleOn: "已开启",
      docsToggleOff: "已关闭",
      docsToggleOnHint: "开启：首次启动与每 24 小时自动增量同步，并加载 dsh_docs_search / dsh_docs_read 工具。",
      docsToggleOffHint: "关闭（默认）：不自动同步，文档工具不加载。",
      docsNotEnabled: "官方文档同步未开启。打开上方开关后会自动同步并加载 dsh_docs_search / dsh_docs_read 工具。",
      docsReading: "正在读取文档状态…",
      statusFail: "状态读取失败: ",
      docsNotReady: "本地还没有官方文档，点击下方「同步官方文档」开始下载",
      docsReady: "✅ 本地文档已就绪（{n} 篇：EN {en} / 中文 {zh}）",
      docsSyncing: "正在同步官方文档…（首次约 1-2 分钟）",
      docsSynced: "✅ 同步完成：{synced} 个更新，{skipped} 个未变，{failed} 个失败（共 {total} 篇）",
      syncFail: "同步失败: ",
      searching: "正在搜索…",
      searchFail: "搜索失败: ",
      noMatch: "没有匹配「{q}」的文档",
      matchCount: "「{q}」共 {total} 条匹配，点击标题阅读：",
      close: "关闭",
      reading: "正在读取 {path} …",
      readFail: "读取失败: ",
      truncated: "已截断",
      chars: "{n} 字符",
      syncTime: "同步时间",
      docSource: "文档来源",
      docRoot: "存储位置",
      syncBtn: "同步官方文档",
      syncingShort: "同步中…",
      refresh: "刷新状态",
      searchPh: "搜索本地文档，如 register tool / 插件开发 / cordis service",
      searchBtn: "搜索",
      searchingShort: "搜索中…",
      docsNote: "文档来自 deepseek-ai/deepseek-harness 官方仓库 docs/（含中文 .zh.md）；首次启动自动同步，此后每 24 小时静默增量同步。Agent 会话中可直接使用 dsh_docs_search / dsh_docs_read 工具查阅本文档。",
      fetchingList: "正在获取官方文档清单…",
    }
    var enDict = {
      nav: "DSH Update",
      updTitle: "DSH Update (npm)",
      checking: "Checking for updates…",
      checkFail: "Check failed: ",
      unknownError: "unknown error",
      remoteError: "Cannot reach the remote registry ({err})",
      updateAvailable: "⚠️ New version available: v{from} → v{to}",
      upToDate: "✅ Already up to date (v{v})",
      updating: "Updating via npm… (may take 1-3 minutes)",
      updated: "✅ Updated: v{from} → v{to}",
      restartHint: "⚠️ New version installed — restart DSH to apply",
      noUpdate: "Already up to date, nothing to update",
      updateFail: "Update failed: ",
      hintWrap: "({hint})",
      mode: "Run mode",
      updateMethod: "Update method",
      methodNpmOwn: "npm global (running instance's own npm)",
      methodNpmPath: "npm global (PATH npm, verified after run)",
      methodSource: "source tree (update via git pull)",
      srcBranch: "Branch",
      srcLocal: "Local commit",
      srcRemote: "Remote commit",
      srcBehind: "{n} commits behind",
      srcAhead: "{n} commits ahead",
      srcUpdateAvailable: "⚠️ Updates available: {from} → {to} ({behind} commits behind)",
      srcUpToDate: "✅ Source tree up to date ({commit})",
      srcDirty: "⚠️ Working tree has uncommitted changes — commit or stash before updating",
      srcGitMissing: "⚠️ git was not detected (not installed or not on PATH). Install git to use source-tree updates.",
      srcNotRepo: "⚠️ Not a git repository — cannot run a source-tree update.",
      srcFetchFailed: "⚠️ git fetch failed (offline or missing remote).",
      srcUpdateBtn: "Update source tree (git pull)",
      srcUpdating: "Updating source tree…",
      srcUpdated: "✅ Source tree updated: {before} → {after}",
      srcNoUpdate: "Source tree already up to date",
      srcFail: "Source-tree update failed: ",
      pwshMissingHint: "PowerShell 7 (pwsh) was not detected. DSH shell tools depend on it — install it with one click.",
      pwshInstallBtn: "Install PowerShell 7",
      pwshInstalling: "Installing PowerShell 7…",
      pwshInstalled: "✅ PowerShell 7 installed — restart DSH to apply",
      pwshInstallFail: "PowerShell 7 install failed: ",
      copiesWarn: "Found {n} dsh copies in this environment — only the currently running one is updated; other copies stay untouched.",
      npmMismatch: "The npm on PATH does not belong to the same Node installation as the running instance; updates use the running instance's own npm and never touch other copies.",
      localVer: "Local version",
      remoteVer: "Remote version",
      checkedAt: "Last checked",
      modeSource: "source tree",
      modeNpm: "npm global",
      sourceUnavailable: "Not available in source-tree mode",
      updatingShort: "Updating…",
      updateBtn: "Update via npm",
      notesBtn: "Release notes",
      recheck: "Re-check",
      checkingShort: "Checking…",
      starting: "Starting update…",
      waiting: "Downloading / installing, please wait… (npm output streams below in real time)",
      updNote: "Auto-checks every 30 minutes (page refreshes the cached result every 60s); npm-global mode runs npm install -g @deepseek-ai/dsh@latest, then restart DSH to apply; source-tree mode: use git pull. \"Release notes\" opens GitHub Releases in a new tab.",
      docsTitle: "DSH Docs (official)",
      docsToggleLabel: "Auto-sync official docs",
      docsToggleOn: "On",
      docsToggleOff: "Off",
      docsToggleOnHint: "On: auto-syncs on first start and every 24h (incremental), and loads the dsh_docs_search / dsh_docs_read tools.",
      docsToggleOffHint: "Off (default): no auto sync and the doc tools are not loaded.",
      docsNotEnabled: "Official docs sync is off. Turn on the switch above to auto-sync and load the dsh_docs_search / dsh_docs_read tools.",
      docsReading: "Reading docs status…",
      statusFail: "Status read failed: ",
      docsNotReady: "No local docs yet — click \"Sync official docs\" below to download",
      docsReady: "✅ Local docs ready ({n} files: EN {en} / zh {zh})",
      docsSyncing: "Syncing official docs… (first run ~1-2 min)",
      docsSynced: "✅ Sync complete: {synced} updated, {skipped} unchanged, {failed} failed (of {total})",
      syncFail: "Sync failed: ",
      searching: "Searching…",
      searchFail: "Search failed: ",
      noMatch: "No docs match \"{q}\"",
      matchCount: "\"{q}\": {total} matches — click a title to read:",
      close: "Close",
      reading: "Reading {path} …",
      readFail: "Read failed: ",
      truncated: "truncated",
      chars: "{n} chars",
      syncTime: "Synced at",
      docSource: "Docs source",
      docRoot: "Location",
      syncBtn: "Sync official docs",
      syncingShort: "Syncing…",
      refresh: "Refresh status",
      searchPh: "Search local docs, e.g. register tool / plugin development / cordis service",
      searchBtn: "Search",
      searchingShort: "Searching…",
      docsNote: "Docs come from deepseek-ai/deepseek-harness official repo docs/ (incl. Chinese .zh.md); auto-synced on first start, then silently every 24h. Agent sessions can use the dsh_docs_search / dsh_docs_read tools.",
      fetchingList: "Fetching official docs list…",
    }

    /** 简易翻译：{key} 占位符替换。 */
    function translate(dict, key, params) {
      var s = dict[key]
      if (s === undefined) s = key
      if (params) {
        for (var k in params) {
          if (Object.prototype.hasOwnProperty.call(params, k)) {
            s = s.split("{" + k + "}").join(String(params[k]))
          }
        }
      }
      return s
    }

    var cardStyle = {
      display: "flex", flexDirection: "column", gap: 6,
      padding: "10px 12px", border: "1px solid rgba(128,128,128,.35)",
      borderRadius: 8, fontSize: 13, lineHeight: 1.5,
    }
    var rowStyle = { display: "flex", gap: 8, alignItems: "baseline" }
    var labelStyle = { opacity: 0.55, minWidth: 70, flex: "none" }
    var monoStyle = { fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", fontSize: 12, wordBreak: "break-all" }
    var okStyle = { color: "#2e7d32", fontWeight: 600 }
    var warnStyle = { color: "#b26a00", fontWeight: 600 }
    var errStyle = { color: "#c62828" }
    var btnStyle = {
      padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(128,128,128,.5)",
      background: "transparent", cursor: "pointer", fontSize: 12,
    }
    var primaryBtnStyle = {
      padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(59,130,246,.6)",
      background: "rgba(59,130,246,.15)", color: "inherit", cursor: "pointer",
      fontSize: 12, fontWeight: 600,
    }
    var noteStyle = { opacity: 0.6, fontSize: 12, marginTop: 4 }
    var inputStyle = {
      padding: "4px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,.4)",
      background: "transparent", color: "inherit", fontSize: 12, flex: 1, minWidth: 120,
    }
    var preStyle = {
      maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
      background: "rgba(128,128,128,.08)", borderRadius: 6, padding: "8px 10px",
      fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", fontSize: 12,
    }

    function apply(ctx) {
      var slots = ctx.get("slots")
      var timer = ctx.get("timer")
      var locale = ctx.get("locale")
      if (slots === undefined) return

      // ── 本地化 ──────────────────────────────────────────────────────────────
      var t = function (key, params) { return translate(zhDict, key, params) }
      if (locale !== undefined) {
        ctx.effect(function () { return locale.register(NS, { zh: zhDict, en: enDict }) }, "dsh-updater-npm: dictionaries")
        t = locale.bind(NS)
      }
      /** 当前界面语言（en / zh），随系统/浏览器语言与设置页手动切换自动更新。 */
      var uiLang = function () {
        if (locale === undefined) return "zh"
        try { return locale.getSnapshot().active === "en" ? "en" : "zh" } catch (e) { return "zh" }
      }

      var hasUpdate = false
      var bumpSeq = 0
      var bumpSalt = String(Math.random()).slice(2)
      // 壳程序缓存设置页导航行（rows 仅在 settings.section 版本号或 locale revision
      // 变化时才重算，标签是一次性读入的快照），所以 hasUpdate 翻转时必须触发重算，
      // 否则导航标签上的小红点永远不会出现。做法：注册一个一次性空字典令 locale
      // revision +1，壳程序随即重读标签 thunk，红点随之显示/消失；不重挂载卡片内容。
      var applyHasUpdate = function (data) {
        var nu = !!(data && data.ok && data.hasUpdate)
        if (nu === hasUpdate) return
        hasUpdate = nu
        if (locale === undefined) return
        bumpSeq += 1
        try {
          locale.register(NS, { ["~nav" + bumpSalt + "-" + bumpSeq]: {} })
        } catch (e) { /* 忽略（如 HMR 后字典残留导致的重复注册） */ }
      }

      // ── DSH 更新卡片 ────────────────────────────────────────────────────────
      var callCheck = function () {
        return fetch("/dsh-updater-npm/check?uilang=" + uiLang(), { cache: "no-store", signal: AbortSignal.timeout(30000) })
          .then(function (r) { return r.json() })
      }
      var callUpdate = function () {
        return fetch("/dsh-updater-npm/update?uilang=" + uiLang(), { method: "POST", cache: "no-store", signal: AbortSignal.timeout(600000) })
          .then(function (r) { return r.json() })
      }
      var callProgress = function () {
        return fetch("/dsh-updater-npm/progress", { cache: "no-store", signal: AbortSignal.timeout(10000) })
          .then(function (r) { return r.json() })
      }
      var RELEASES_URL = "https://github.com/deepseek-ai/DeepSeek-Harness/releases"

      function UpdView() {
        var el = react.createElement
        var state0 = react.useState({ phase: "running", data: null, error: null })
        var state = state0[0]
        var setState = state0[1]
        var update0 = react.useState(null)
        var update = update0[0]
        var setUpdate = update0[1]
        var prog0 = react.useState(null)
        var prog = prog0[0]
        var setProg = prog0[1]
        // PowerShell 7 一键安装状态
        var ps0 = react.useState(null)
        var pwshInstall = ps0[0]
        var setPwshInstall = ps0[1]
        // 动效节拍：更新/安装进行中每秒 +1，驱动 spinner 与进度条流动
        var tick0 = react.useState(0)
        var tick = tick0[0]
        var setTick = tick0[1]
        var busyNow = update !== null && update.phase === "running"
        react.useEffect(function () {
          if (!busyNow || timer === undefined) return
          var dispose = timer.interval(function () { setTick(function (v) { return v + 1 }) }, 1000)
          return function () { dispose() }
        }, [busyNow])

        var applyData = function (data) {
          applyHasUpdate(data)
        }

        var runCheck = function () {
          setState({ phase: "running", data: null, error: null })
          callCheck().then(function (data) {
            applyData(data)
            setState({ phase: "done", data: data, error: null })
          }).catch(function (error) {
            setState({ phase: "done", data: null, error: String((error && error.message) || error) })
          })
        }

        var pollCheck = function () {
          callCheck().then(function (data) {
            applyData(data)
            setState(function (s) { return s.phase === "done" ? { phase: "done", data: data, error: null } : s })
          }).catch(function () { /* 静默 */ })
        }

        var runUpdate = function () {
          setUpdate({ phase: "running", result: null })
          setProg({ type: "update", phase: "starting", message: t("starting"), detail: "", done: 0, total: 0, current: "", startedAt: Date.now() })
          var stopPoll = null
          if (timer !== undefined) {
            stopPoll = timer.interval(function () {
              callProgress().then(function (p) {
                if (p && p.type === "update" && p.phase !== "idle") setProg(p)
              }).catch(function () { /* 静默 */ })
            }, 1500)
          }
          callUpdate().then(function (result) {
            if (stopPoll) stopPoll()
            setUpdate({ phase: "done", result: result })
            setProg(null)
            runCheck()
          }).catch(function (error) {
            if (stopPoll) stopPoll()
            setUpdate({ phase: "done", result: { ok: false, error: String((error && error.message) || error) } })
            setProg(null)
          })
        }

        var runSourceUpdate = function () {
          setUpdate({ phase: "running", result: null })
          setProg({ type: "source-update", phase: "starting", message: t("srcUpdating"), detail: "", done: 0, total: 0, current: "", startedAt: Date.now() })
          var stopPoll = null
          if (timer !== undefined) {
            stopPoll = timer.interval(function () {
              callProgress().then(function (p) {
                if (p && p.type === "source-update" && p.phase !== "idle") setProg(p)
              }).catch(function () { /* 静默 */ })
            }, 1500)
          }
          fetch("/dsh-updater-npm/update-source?uilang=" + uiLang(), { method: "POST", cache: "no-store", signal: AbortSignal.timeout(600000) })
            .then(function (r) { return r.json() })
            .then(function (result) {
              if (stopPoll) stopPoll()
              setUpdate({ phase: "done", result: result })
              setProg(null)
              runCheck()
            }).catch(function (error) {
              if (stopPoll) stopPoll()
              setUpdate({ phase: "done", result: { ok: false, error: String((error && error.message) || error) } })
              setProg(null)
            })
        }

        var runInstallPwsh = function () {
          setPwshInstall({ phase: "running", result: null, prog: { type: "install-pwsh", phase: "starting", message: t("pwshInstalling"), detail: "", startedAt: Date.now() } })
          var stopPoll = null
          if (timer !== undefined) {
            stopPoll = timer.interval(function () {
              callProgress().then(function (p) {
                if (p && p.type === "install-pwsh" && p.phase !== "idle") setPwshInstall({ phase: "running", result: null, prog: p })
              }).catch(function () { /* 静默 */ })
            }, 1500)
          }
          fetch("/dsh-updater-npm/install-pwsh?uilang=" + uiLang(), { method: "POST", cache: "no-store", signal: AbortSignal.timeout(600000) })
            .then(function (r) { return r.json() })
            .then(function (result) {
              if (stopPoll) stopPoll()
              setPwshInstall({ phase: "done", result: result, prog: null })
              runCheck()
            }).catch(function (error) {
              if (stopPoll) stopPoll()
              setPwshInstall({ phase: "done", result: { ok: false, error: String((error && error.message) || error) }, prog: null })
            })
        }

        var runNotes = function () {
          var target = RELEASES_URL
          if (typeof window !== "undefined" && window.open) {
            window.open(target, "_blank", "noopener")
          } else {
            var a = document.createElement("a")
            a.href = target
            a.target = "_blank"
            a.rel = "noreferrer"
            a.click()
          }
        }

        react.useEffect(function () {
          runCheck()
          if (timer !== undefined) {
            var dispose = timer.interval(function () { pollCheck() }, 60000)
            return function () { dispose() }
          }
        }, [])

        function row(label, value, mono) {
          return el("div", { style: rowStyle },
            el("span", { style: labelStyle }, label),
            el("span", { style: mono ? monoStyle : undefined }, value === null || value === undefined ? "—" : String(value)))
        }

        var statusLine
        if (state.phase === "running") {
          statusLine = el("div", null, t("checking"))
        } else if (state.error) {
          statusLine = el("div", { style: errStyle }, t("checkFail") + state.error)
        } else if (!state.data || !state.data.ok) {
          statusLine = el("div", { style: errStyle }, t("checkFail") + ((state.data && state.data.error) || t("unknownError")))
        } else {
          var d = state.data
          if (d.mode === "source") {
            // 源码树模式：git 状态决定提示
            if (d.gitError === "git-missing") {
              statusLine = el("div", { style: warnStyle }, t("srcGitMissing"))
            } else if (d.gitError === "not-repo") {
              statusLine = el("div", { style: warnStyle }, t("srcNotRepo"))
            } else if (d.gitError === "git-fetch-failed") {
              statusLine = el("div", { style: warnStyle }, t("srcFetchFailed"))
            } else if (d.hasUpdate) {
              statusLine = el("div", { style: warnStyle }, t("srcUpdateAvailable", { from: d.git && d.git.localHead, to: d.git && d.git.remoteHead, behind: d.git && d.git.behind }))
            } else {
              statusLine = el("div", { style: okStyle }, t("srcUpToDate", { commit: d.git && d.git.localHead }))
            }
          } else if (d.remoteError !== null && d.remoteVersion === null) {
            statusLine = el("div", { style: warnStyle }, t("remoteError", { err: d.remoteError }))
          } else if (d.hasUpdate) {
            statusLine = el("div", { style: warnStyle }, t("updateAvailable", { from: d.localVersion, to: d.remoteVersion }))
          } else {
            statusLine = el("div", { style: okStyle }, t("upToDate", { v: d.localVersion }))
          }
        }

        var updateLine = null
        if (update !== null) {
          if (update.phase === "running") {
            // 单调递增条：随已运行时间只进不退（封顶 90%），避免"满了又退回去"的误导
            var uStart = prog && prog.startedAt ? prog.startedAt : Date.now()
            var uElapsed = Math.max(0, Math.floor((Date.now() - uStart) / 1000))
            var barW = Math.min(90, 10 + uElapsed * 1.5)
            updateLine = el("div", null,
              el("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                el("span", { style: { fontSize: 12 } }, SPINNER[tick % SPINNER.length]),
                el("span", null, prog && prog.message ? prog.message : (update.result && update.result.mode === "source" ? t("srcUpdating") : t("updating"))),
                el("span", { style: { opacity: 0.6, fontSize: 11 } }, "⏱ " + fmtElapsed(uStart))),
              el("div", { style: { marginTop: 6, height: 6, borderRadius: 3, background: "rgba(128,128,128,.2)", overflow: "hidden" } },
                el("div", { style: { height: "100%", width: barW + "%", background: "#3b82f6", borderRadius: 3, transition: "width .5s linear" } })),
              el("pre", { style: { margin: "6px 0 0", maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", fontSize: 11, opacity: 0.75, background: "rgba(128,128,128,.08)", borderRadius: 6, padding: "6px 8px" } },
                prog && prog.detail ? prog.detail : t("waiting")))
          } else if (update.result && update.result.ok) {
            if (update.result.mode === "source") {
              updateLine = update.result.updated
                ? el("div", null,
                    el("div", { style: okStyle }, t("srcUpdated", { before: update.result.before, to: update.result.after })),
                    el("div", { style: Object.assign({ marginTop: 4 }, warnStyle) }, t("restartHint")))
                : el("div", { style: okStyle }, update.result.hint || t("srcNoUpdate"))
            } else if (update.result.updated) {
              updateLine = el("div", null,
                el("div", { style: okStyle }, t("updated", { from: update.result.beforeVersion, to: update.result.version })),
                el("div", { style: Object.assign({ marginTop: 4 }, warnStyle) },
                  t("restartHint")))
            } else {
              updateLine = el("div", { style: warnStyle }, update.result.warning ? "⚠️ " + update.result.warning : t("noUpdate"))
            }
          } else {
            var ures = update.result || {}
            var failMsg = ures.mode === "source" ? t("srcFail") : t("updateFail")
            updateLine = el("div", { style: errStyle }, failMsg + (ures.error || t("unknownError")))
          }
        }

        var data = state.data
        var busy = update !== null && update.phase === "running"
        var sourceMode = !!(data && data.ok && data.mode === "source")
        var git = data && data.ok ? data.git : null

        var pwshLine = null
        if (pwshInstall !== null) {
          if (pwshInstall.phase === "running") {
            pwshLine = el("div", null,
              el("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                el("span", { style: { fontSize: 12 } }, SPINNER[tick % SPINNER.length]),
                el("span", null, pwshInstall.prog && pwshInstall.prog.message ? pwshInstall.prog.message : t("pwshInstalling")),
                el("span", { style: { opacity: 0.6, fontSize: 11 } }, "⏱ " + fmtElapsed(pwshInstall.prog && pwshInstall.prog.startedAt ? pwshInstall.prog.startedAt : Date.now()))),
              el("pre", { style: { margin: "6px 0 0", maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", fontSize: 11, opacity: 0.75, background: "rgba(128,128,128,.08)", borderRadius: 6, padding: "6px 8px" } },
                pwshInstall.prog && pwshInstall.prog.detail ? pwshInstall.prog.detail : t("waiting")))
          } else if (pwshInstall.result && pwshInstall.result.ok) {
            pwshLine = el("div", { style: okStyle }, t("pwshInstalled"))
          } else {
            pwshLine = el("div", { style: errStyle }, t("pwshInstallFail") + ((pwshInstall.result && pwshInstall.result.error) || t("unknownError")))
          }
        }

        return el("div", { style: cardStyle },
          el("div", { style: { fontWeight: 600 } }, t("updTitle")),
          statusLine,
          data && data.ok ? el("div", null,
            row(t("mode"), sourceMode ? t("modeSource") : t("modeNpm"), true),
            row(t("updateMethod"), data.updateMethod === "source-git-pull" ? t("methodSource") : data.updateMethod === "npm-global-own" ? t("methodNpmOwn") : t("methodNpmPath"), true),
            sourceMode
              ? (git
                  ? el("div", null,
                      row(t("srcBranch"), git.branch, true),
                      row(t("srcLocal"), git.localHead, true),
                      row(t("srcRemote"), git.remoteHead || "—", true),
                      el("div", { style: { marginTop: 2, fontSize: 12, opacity: 0.7 } },
                        (git.behind > 0 ? t("srcBehind", { n: git.behind }) + (git.ahead > 0 ? " · " : "") : "") + (git.ahead > 0 ? t("srcAhead", { n: git.ahead }) : "")))
                  : null)
              : el("div", null,
                  row(t("localVer"), data.localVersion, true),
                  row(t("remoteVer"), data.remoteVersion, true)),
            row(t("checkedAt"), data.checkedAt ? new Date(data.checkedAt).toLocaleTimeString() : "—")) : null,
          data && data.ok && data.sourceWarning ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } },
            "⚠️ " + data.sourceWarning) : null,
          sourceMode && data.gitError === "git-missing" ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } }, t("srcGitMissing")) : null,
          sourceMode && data.gitError === "not-repo" ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } }, t("srcNotRepo")) : null,
          sourceMode && data.gitError === "git-fetch-failed" ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } }, t("srcFetchFailed")) : null,
          sourceMode && git && git.dirty ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } }, t("srcDirty")) : null,
          data && data.ok && data.npmMismatch ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } },
            "⚠️ " + t("npmMismatch")) : null,
          data && data.ok && data.copies && data.copies.length > 0 ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } },
            "⚠️ " + t("copiesWarn", { n: data.copies.length })) : null,
          data && data.ok && data.pwshInstalled === false ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } },
            t("pwshMissingHint")) : null,
          updateLine,
          el("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" } },
            sourceMode
              ? el("button", { style: primaryBtnStyle, onClick: runSourceUpdate, disabled: busy || !git || git.dirty || !!data.gitError || !data.hasUpdate }, busy ? t("srcUpdating") : t("srcUpdateBtn"))
              : el("button", { style: primaryBtnStyle, onClick: runUpdate, disabled: busy || !(data && data.ok && data.hasUpdate) }, busy ? t("updatingShort") : t("updateBtn")),
            el("button", { style: btnStyle, onClick: runNotes }, t("notesBtn")),
            el("button", { style: btnStyle, onClick: runCheck, disabled: state.phase === "running" }, state.phase === "running" ? t("checkingShort") : t("recheck"))),
          data && data.ok && data.pwshInstalled === false ? el("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" } },
            el("button", { style: primaryBtnStyle, onClick: runInstallPwsh, disabled: pwshInstall !== null && pwshInstall.phase === "running" }, pwshInstall !== null && pwshInstall.phase === "running" ? t("pwshInstalling") : t("pwshInstallBtn")),
            pwshLine) : null,
          el("div", { style: noteStyle }, t("updNote")))
      }

      // ── DSH 文档卡片 ────────────────────────────────────────────────────────
      var callDocsStatus = function () {
        return fetch("/dsh-updater-npm/docs/status", { cache: "no-store", signal: AbortSignal.timeout(20000) })
          .then(function (r) { return r.json() })
      }
      var callDocsSync = function () {
        return fetch("/dsh-updater-npm/docs/sync?uilang=" + uiLang(), { method: "POST", cache: "no-store", signal: AbortSignal.timeout(600000) })
          .then(function (r) { return r.json() })
      }
      var callDocsSearch = function (q, lang) {
        return fetch("/dsh-updater-npm/docs/search?q=" + encodeURIComponent(q) + "&lang=" + encodeURIComponent(lang || "auto") + "&limit=10&uilang=" + uiLang(), { cache: "no-store", signal: AbortSignal.timeout(20000) })
          .then(function (r) { return r.json() })
      }
      var callDocsRead = function (path, section) {
        var u = "/dsh-updater-npm/docs/read?path=" + encodeURIComponent(path) + "&uilang=" + uiLang()
        if (section) u += "&section=" + encodeURIComponent(section)
        return fetch(u, { cache: "no-store", signal: AbortSignal.timeout(20000) })
          .then(function (r) { return r.json() })
      }

      function DocsView() {
        var el = react.createElement
        var st0 = react.useState({ phase: "running", data: null, error: null })
        var status = st0[0]
        var setStatus = st0[1]
        var sy0 = react.useState(null)
        var syncState = sy0[0]
        var setSyncState = sy0[1]
        var q0 = react.useState("")
        var query = q0[0]
        var setQuery = q0[1]
        var sr0 = react.useState({ phase: "idle", data: null, error: null })
        var search = sr0[0]
        var setSearch = sr0[1]
        var rd0 = react.useState(null)
        var reading = rd0[0]
        var setReading = rd0[1]
        var sp0 = react.useState(null)
        var syncProg = sp0[0]
        var setSyncProg = sp0[1]
        // 文档同步开关：null=加载中 / true / false（默认关闭）
        var en0 = react.useState(null)
        var enabled = en0[0]
        var setEnabled = en0[1]

        var toggleEnabled = function () {
          if (enabled === null) return
          var next = !enabled
          fetch("/dsh-updater-npm/docs/enabled?enabled=" + (next ? 1 : 0), { method: "POST", cache: "no-store", signal: AbortSignal.timeout(15000) })
            .then(function (r) { return r.json() })
            .then(function (data) {
              setEnabled(!!(data && data.enabled))
              if (data && data.enabled) loadStatus()
            })
            .catch(function () { setEnabled(enabled) }) // 失败回滚
        }

        var loadStatus = function () {
          callDocsStatus().then(function (data) {
            setStatus({ phase: "done", data: data, error: null })
          }).catch(function (error) {
            setStatus({ phase: "done", data: null, error: String((error && error.message) || error) })
          })
        }

        var runSync = function () {
          setSyncState({ phase: "running", result: null })
          setSyncProg({ type: "docs-sync", phase: "starting", message: t("fetchingList"), detail: "", done: 0, total: 0, current: "" })
          var stopPoll = null
          if (timer !== undefined) {
            stopPoll = timer.interval(function () {
              callProgress().then(function (p) {
                if (p && p.type === "docs-sync" && p.phase !== "idle") setSyncProg(p)
              }).catch(function () { /* 静默 */ })
            }, 800)
          }
          callDocsSync().then(function (result) {
            if (stopPoll) stopPoll()
            setSyncState({ phase: "done", result: result })
            setSyncProg(null)
            loadStatus()
          }).catch(function (error) {
            if (stopPoll) stopPoll()
            setSyncState({ phase: "done", result: { ok: false, error: String((error && error.message) || error) } })
            setSyncProg(null)
          })
        }

        var runSearch = function (q) {
          var term = (q === undefined ? query : q).trim()
          if (term === "") return
          setSearch({ phase: "running", data: null, error: null })
          setReading(null)
          callDocsSearch(term, "auto").then(function (data) {
            setSearch({ phase: "done", data: data, error: null })
          }).catch(function (error) {
            setSearch({ phase: "done", data: null, error: String((error && error.message) || error) })
          })
        }

        var runRead = function (path) {
          setReading({ phase: "running", path: path, data: null, error: null })
          callDocsRead(path, "").then(function (data) {
            setReading({ phase: "done", path: path, data: data, error: null })
          }).catch(function (error) {
            setReading({ phase: "done", path: path, data: null, error: String((error && error.message) || error) })
          })
        }

        react.useEffect(function () {
          loadStatus()
          fetch("/dsh-updater-npm/docs/enabled", { cache: "no-store", signal: AbortSignal.timeout(10000) })
            .then(function (r) { return r.json() })
            .then(function (data) { setEnabled(!!(data && data.enabled)) })
            .catch(function () { setEnabled(false) })
          if (timer !== undefined) {
            var dispose = timer.interval(function () { loadStatus() }, 120000)
            return function () { dispose() }
          }
        }, [])

        function row(label, value, mono) {
          return el("div", { style: rowStyle },
            el("span", { style: labelStyle }, label),
            el("span", { style: mono ? monoStyle : undefined }, value === null || value === undefined ? "—" : String(value)))
        }

        var statusLine
        if (enabled === false) {
          statusLine = el("div", { style: warnStyle }, t("docsNotEnabled"))
        } else if (status.phase === "running") {
          statusLine = el("div", null, t("docsReading"))
        } else if (status.error) {
          statusLine = el("div", { style: errStyle }, t("statusFail") + status.error)
        } else if (!status.data || !status.data.ok) {
          statusLine = el("div", { style: errStyle }, t("statusFail") + ((status.data && status.data.error) || t("unknownError")))
        } else if (!status.data.indexed) {
          statusLine = el("div", { style: warnStyle }, t("docsNotReady"))
        } else {
          statusLine = el("div", { style: okStyle }, t("docsReady", { n: status.data.count, en: status.data.en, zh: status.data.zh }))
        }

        var syncLine = null
        if (syncState !== null) {
          if (syncState.phase === "running") {
            var sp = syncProg
            var pct = null
            if (sp && sp.total > 0) pct = Math.round((sp.done / sp.total) * 100)
            syncLine = el("div", null,
              el("div", null, sp && sp.message ? sp.message : t("docsSyncing")),
              pct !== null ? el("div", { style: { marginTop: 4, height: 6, borderRadius: 3, background: "rgba(128,128,128,.2)", overflow: "hidden" } },
                el("div", { style: { height: "100%", width: pct + "%", background: "#3b82f6", borderRadius: 3, transition: "width .3s" } })) : null,
              pct !== null ? el("div", { style: { marginTop: 3, opacity: 0.6, fontSize: 11 } }, pct + "%" + (sp && sp.current ? " · " + sp.current : "")) : null)
          } else if (syncState.result && syncState.result.ok) {
            syncLine = el("div", { style: okStyle },
              t("docsSynced", { synced: syncState.result.synced, skipped: syncState.result.skipped, failed: syncState.result.failed || 0, total: syncState.result.total }))
          } else {
            syncLine = el("div", { style: errStyle }, t("syncFail") + ((syncState.result && syncState.result.error) || t("unknownError")))
          }
        }

        var searchLine = null
        if (search.phase === "running") {
          searchLine = el("div", null, t("searching"))
        } else if (search.error) {
          searchLine = el("div", { style: errStyle }, t("searchFail") + search.error)
        } else if (search.data && search.phase === "done") {
          if (!search.data.ok) {
            searchLine = el("div", { style: errStyle }, t("searchFail") + (search.data.error || t("unknownError")))
          } else if (search.data.total === 0) {
            searchLine = el("div", { style: warnStyle }, t("noMatch", { q: search.data.query }))
          } else {
            searchLine = el("div", null,
              el("div", { style: { marginBottom: 4 } }, t("matchCount", { q: search.data.query, total: search.data.total })),
              el("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                search.data.results.map(function (r) {
                  return el("div", { key: r.path, style: { display: "flex", gap: 6, alignItems: "baseline" } },
                    el("a", {
                      href: "javascript:void(0)",
                      style: { color: "inherit", textDecoration: "underline", cursor: "pointer", fontWeight: r.lang === "zh" ? 600 : 400 },
                      onClick: function () { runRead(r.path) },
                    }, r.title),
                    el("span", { style: { opacity: 0.6, fontSize: 11, fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" } }, "[" + r.lang + "] " + r.path + " · " + r.score))
                })))
          }
        }

        var readLine = null
        if (reading !== null) {
          if (reading.phase === "running") {
            readLine = el("div", null, t("reading", { path: reading.path }))
          } else if (reading.error) {
            readLine = el("div", { style: errStyle }, t("readFail") + reading.error)
          } else if (reading.data && reading.data.ok) {
            readLine = el("div", null,
              el("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "4px 0" } },
                el("span", { style: { fontWeight: 600 } }, reading.data.title),
                el("span", { style: { opacity: 0.6, fontSize: 11, fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" } }, reading.data.path + " · " + (reading.data.truncated ? t("truncated") : t("chars", { n: reading.data.size }))),
                el("button", { style: btnStyle, onClick: function () { setReading(null) } }, t("close"))),
              el("pre", { style: preStyle }, reading.data.content || ""))
          } else {
            readLine = el("div", { style: errStyle }, t("readFail") + ((reading.data && reading.data.error) || t("unknownError")))
          }
        }

        var d = status.data
        return el("div", { style: cardStyle },
          el("div", { style: { fontWeight: 600 } }, t("docsTitle")),
          el("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 2 } },
            el("span", { style: { fontWeight: 600 } }, t("docsToggleLabel")),
            el("button", {
              style: enabled ? Object.assign({}, btnStyle, { borderColor: "rgba(46,125,50,.7)", background: "rgba(46,125,50,.18)", fontWeight: 600 }) : btnStyle,
              onClick: toggleEnabled,
              disabled: enabled === null,
            }, enabled === null ? "…" : (enabled ? t("docsToggleOn") : t("docsToggleOff"))),
            el("span", { style: { opacity: 0.6, fontSize: 11, flex: 1, minWidth: 180 } }, enabled ? t("docsToggleOnHint") : t("docsToggleOffHint"))),
          statusLine,
          d && d.ok && d.indexed ? el("div", null,
            row(t("syncTime"), d.syncedAt ? new Date(d.syncedAt).toLocaleString() : "—"),
            row(t("docSource"), d.sourceRef ? "commit " + String(d.sourceRef).slice(0, 7) : "—", true),
            row(t("docRoot"), d.root, true)) : null,
          syncLine,
          el("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" } },
            el("button", { style: primaryBtnStyle, onClick: runSync, disabled: !enabled || (syncState !== null && syncState.phase === "running") }, syncState !== null && syncState.phase === "running" ? t("syncingShort") : t("syncBtn")),
            el("button", { style: btnStyle, onClick: loadStatus }, t("refresh"))),
          el("div", { style: { display: "flex", gap: 6, marginTop: 8, alignItems: "center" } },
            el("input", {
              style: inputStyle,
              placeholder: t("searchPh"),
              value: query,
              onChange: function (e) { setQuery(e.target.value) },
              onKeyDown: function (e) { if (e.key === "Enter") runSearch() },
            }),
            el("button", { style: btnStyle, onClick: function () { runSearch() }, disabled: search.phase === "running" }, search.phase === "running" ? t("searchingShort") : t("searchBtn"))),
          searchLine,
          readLine,
          el("div", { style: noteStyle }, t("docsNote")))
      }

      // ── 注入合并后的设置页面（DSH 更新 + DSH 文档同一页）─────────────────────
      var disposeUpd = slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "dsh-update-local", order: 30, locale: NS, label: function () { return hasUpdate ? t("nav") + " 🔴" : t("nav") } },
          function (props) {
            return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
              react.createElement(UpdView, null),
              react.createElement(DocsView, null))
          })
      })
      ctx.effect(function () { return function () { disposeUpd() } })

      // 页面加载时静默预检一次（宿主端 /check 有 10 分钟缓存），
      // 让导航小红点在首次打开设置页时就绪，而不必先进入「DSH 更新」卡片。
      callCheck().then(function (data) { applyHasUpdate(data) }).catch(function () { /* 静默 */ })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
