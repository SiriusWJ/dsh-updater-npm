// dsh-updater-npm —— Client 面（浏览器 bundle）
//
// 设置页一个合并页面（「DSH 更新」入口，图标为更新图标）：
//  上半部「DSH 更新」：自动加载检查结果，提供「通过 npm 更新」按钮。
//  下半部「DSH 文档」：官方文档同步状态、手动同步、本地索引搜索与阅读。
// 通过同源 HTTP 路由与宿主端通信（/dsh-updater-npm/*）。
window.__ModuleLoader__.load({
  id: "dsh-updater-npm",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var react = require("react")

    var name = "dsh-updater-npm"
    var inject = ["slots", "timer"]

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
      if (slots === undefined) return
      var hasUpdate = false

      // ── DSH 更新卡片 ────────────────────────────────────────────────────────
      var callCheck = function () {
        return fetch("/dsh-updater-npm/check", { cache: "no-store", signal: AbortSignal.timeout(30000) })
          .then(function (r) { return r.json() })
      }
      var callUpdate = function () {
        return fetch("/dsh-updater-npm/update", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(200000) })
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

        var applyData = function (data) {
          hasUpdate = !!(data && data.ok && data.hasUpdate)
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
          setProg({ type: "update", phase: "starting", message: "正在启动更新…", detail: "", done: 0, total: 0, current: "" })
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
          statusLine = el("div", null, "正在检查更新…")
        } else if (state.error) {
          statusLine = el("div", { style: errStyle }, "检查失败: " + state.error)
        } else if (!state.data || !state.data.ok) {
          statusLine = el("div", { style: errStyle }, "检查失败: " + ((state.data && state.data.error) || "未知错误"))
        } else {
          var d = state.data
          if (d.remoteError !== null && d.remoteVersion === null) {
            statusLine = el("div", { style: warnStyle }, "无法获取远端版本（" + d.remoteError + "）")
          } else if (d.hasUpdate) {
            statusLine = el("div", { style: warnStyle }, "⚠️ 有新版本可用：v" + d.localVersion + " → v" + d.remoteVersion)
          } else {
            statusLine = el("div", { style: okStyle }, "✅ 已是最新版本（v" + d.localVersion + "）")
          }
        }

        var updateLine = null
        if (update !== null) {
          if (update.phase === "running") {
            updateLine = el("div", null,
              el("div", null, prog && prog.message ? prog.message : "正在通过 npm 更新…（可能需要 1-3 分钟）"),
              prog && prog.detail ? el("pre", { style: { margin: "4px 0 0", maxHeight: 90, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", fontSize: 11, opacity: 0.75, background: "rgba(128,128,128,.08)", borderRadius: 6, padding: "6px 8px" } }, prog.detail) : null)
          } else if (update.result && update.result.ok) {
            updateLine = update.result.updated
              ? el("div", null,
                  el("div", { style: okStyle }, "✅ 已更新: v" + update.result.beforeVersion + " → v" + update.result.version),
                  el("div", { style: Object.assign({ marginTop: 4 }, warnStyle) },
                    "⚠️ 新版本已安装，重启 DSH 后生效"))
              : el("div", { style: okStyle }, "已是最新，无需更新")
          } else {
            updateLine = el("div", { style: errStyle }, "更新失败: " + ((update.result && update.result.error) || "未知错误") + ((update.result && update.result.hint) ? "（" + update.result.hint + "）" : ""))
          }
        }

        var data = state.data
        var busy = update !== null && update.phase === "running"
        var sourceMode = !!(data && data.ok && data.mode === "source")
        return el("div", { style: cardStyle },
          el("div", { style: { fontWeight: 600 } }, "DSH 更新（npm）"),
          statusLine,
          data && data.ok ? el("div", null,
            row("运行模式", data.mode === "source" ? "源码树" : "npm 全局", true),
            row("本地版本", data.localVersion, true),
            row("远端版本", data.remoteVersion, true),
            row("最近检查", data.checkedAt ? new Date(data.checkedAt).toLocaleTimeString() : "—")) : null,
          data && data.ok && data.sourceWarning ? el("div", { style: { marginTop: 4, fontSize: 12, color: "#b26a00" } },
            "⚠️ " + data.sourceWarning) : null,
          updateLine,
          el("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" } },
            el("button", { style: primaryBtnStyle, onClick: runUpdate, disabled: busy || sourceMode || !(data && data.ok && data.hasUpdate) }, sourceMode ? "源码树模式不可用" : (busy ? "更新中…" : "通过 npm 更新")),
            el("button", { style: btnStyle, onClick: runNotes }, "更新说明"),
            el("button", { style: btnStyle, onClick: runCheck, disabled: state.phase === "running" }, state.phase === "running" ? "检查中…" : "重新检查")),
          el("div", { style: noteStyle }, "自动检查每 30 分钟一次（页面每 60 秒刷新缓存结果）；npm 全局模式更新执行 npm install -g @deepseek-ai/dsh@latest，完成后需重启 DSH 生效；源码树模式请用 git pull 更新。「更新说明」在新标签页打开 GitHub Releases。"))
      }

      // ── DSH 文档卡片 ────────────────────────────────────────────────────────
      var callDocsStatus = function () {
        return fetch("/dsh-updater-npm/docs/status", { cache: "no-store", signal: AbortSignal.timeout(20000) })
          .then(function (r) { return r.json() })
      }
      var callDocsSync = function () {
        return fetch("/dsh-updater-npm/docs/sync", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(120000) })
          .then(function (r) { return r.json() })
      }
      var callDocsSearch = function (q, lang) {
        return fetch("/dsh-updater-npm/docs/search?q=" + encodeURIComponent(q) + "&lang=" + encodeURIComponent(lang || "auto") + "&limit=10", { cache: "no-store", signal: AbortSignal.timeout(20000) })
          .then(function (r) { return r.json() })
      }
      var callDocsRead = function (path, section) {
        var u = "/dsh-updater-npm/docs/read?path=" + encodeURIComponent(path)
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

        var loadStatus = function () {
          callDocsStatus().then(function (data) {
            setStatus({ phase: "done", data: data, error: null })
          }).catch(function (error) {
            setStatus({ phase: "done", data: null, error: String((error && error.message) || error) })
          })
        }

        var runSync = function () {
          setSyncState({ phase: "running", result: null })
          setSyncProg({ type: "docs-sync", phase: "starting", message: "正在获取官方文档清单…", detail: "", done: 0, total: 0, current: "" })
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
        if (status.phase === "running") {
          statusLine = el("div", null, "正在读取文档状态…")
        } else if (status.error) {
          statusLine = el("div", { style: errStyle }, "状态读取失败: " + status.error)
        } else if (!status.data || !status.data.ok) {
          statusLine = el("div", { style: errStyle }, "状态读取失败: " + ((status.data && status.data.error) || "未知错误"))
        } else if (!status.data.indexed) {
          statusLine = el("div", { style: warnStyle }, "本地还没有官方文档，点击下方「同步官方文档」开始下载")
        } else {
          statusLine = el("div", { style: okStyle }, "✅ 本地文档已就绪（" + status.data.count + " 篇：EN " + status.data.en + " / 中文 " + status.data.zh + "）")
        }

        var syncLine = null
        if (syncState !== null) {
          if (syncState.phase === "running") {
            var sp = syncProg
            var pct = null
            if (sp && sp.total > 0) pct = Math.round((sp.done / sp.total) * 100)
            syncLine = el("div", null,
              el("div", null, sp && sp.message ? sp.message : "正在同步官方文档…（首次约 1-2 分钟）"),
              pct !== null ? el("div", { style: { marginTop: 4, height: 6, borderRadius: 3, background: "rgba(128,128,128,.2)", overflow: "hidden" } },
                el("div", { style: { height: "100%", width: pct + "%", background: "#3b82f6", borderRadius: 3, transition: "width .3s" } })) : null,
              pct !== null ? el("div", { style: { marginTop: 3, opacity: 0.6, fontSize: 11 } }, pct + "%" + (sp && sp.current ? " · " + sp.current : "")) : null)
          } else if (syncState.result && syncState.result.ok) {
            syncLine = el("div", { style: okStyle },
              "✅ 同步完成：" + syncState.result.synced + " 个更新，" + syncState.result.skipped + " 个未变，" + (syncState.result.failed || 0) + " 个失败（共 " + syncState.result.total + " 篇）")
          } else {
            syncLine = el("div", { style: errStyle }, "同步失败: " + ((syncState.result && syncState.result.error) || "未知错误"))
          }
        }

        var searchLine = null
        if (search.phase === "running") {
          searchLine = el("div", null, "正在搜索…")
        } else if (search.error) {
          searchLine = el("div", { style: errStyle }, "搜索失败: " + search.error)
        } else if (search.data && search.phase === "done") {
          if (!search.data.ok) {
            searchLine = el("div", { style: errStyle }, "搜索失败: " + (search.data.error || "未知错误"))
          } else if (search.data.total === 0) {
            searchLine = el("div", { style: warnStyle }, "没有匹配「" + search.data.query + "」的文档")
          } else {
            searchLine = el("div", null,
              el("div", { style: { marginBottom: 4 } }, "「" + search.data.query + "」共 " + search.data.total + " 条匹配，点击标题阅读："),
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
            readLine = el("div", null, "正在读取 " + reading.path + " …")
          } else if (reading.error) {
            readLine = el("div", { style: errStyle }, "读取失败: " + reading.error)
          } else if (reading.data && reading.data.ok) {
            readLine = el("div", null,
              el("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "4px 0" } },
                el("span", { style: { fontWeight: 600 } }, reading.data.title),
                el("span", { style: { opacity: 0.6, fontSize: 11, fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" } }, reading.data.path + " · " + (reading.data.truncated ? "已截断" : reading.data.size + " 字符")),
                el("button", { style: btnStyle, onClick: function () { setReading(null) } }, "关闭")),
              el("pre", { style: preStyle }, reading.data.content || ""))
          } else {
            readLine = el("div", { style: errStyle }, "读取失败: " + ((reading.data && reading.data.error) || "未知错误"))
          }
        }

        var d = status.data
        return el("div", { style: cardStyle },
          el("div", { style: { fontWeight: 600 } }, "DSH 文档（官方）"),
          statusLine,
          d && d.ok && d.indexed ? el("div", null,
            row("同步时间", d.syncedAt ? new Date(d.syncedAt).toLocaleString() : "—"),
            row("文档来源", d.sourceRef ? "commit " + String(d.sourceRef).slice(0, 7) : "—", true),
            row("存储位置", d.root, true)) : null,
          syncLine,
          el("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" } },
            el("button", { style: primaryBtnStyle, onClick: runSync, disabled: syncState !== null && syncState.phase === "running" }, syncState !== null && syncState.phase === "running" ? "同步中…" : "同步官方文档"),
            el("button", { style: btnStyle, onClick: loadStatus }, "刷新状态")),
          el("div", { style: { display: "flex", gap: 6, marginTop: 8, alignItems: "center" } },
            el("input", {
              style: inputStyle,
              placeholder: "搜索本地文档，如 register tool / 插件开发 / cordis service",
              value: query,
              onChange: function (e) { setQuery(e.target.value) },
              onKeyDown: function (e) { if (e.key === "Enter") runSearch() },
            }),
            el("button", { style: btnStyle, onClick: function () { runSearch() }, disabled: search.phase === "running" }, search.phase === "running" ? "搜索中…" : "搜索")),
          searchLine,
          readLine,
          el("div", { style: noteStyle }, "文档来自 deepseek-ai/deepseek-harness 官方仓库 docs/（含中文 .zh.md）；首次启动自动同步，此后每 24 小时静默增量同步。Agent 会话中可直接使用 dsh_docs_search / dsh_docs_read 工具查阅本文档。"))
      }

      // ── 注入合并后的设置页面（DSH 更新 + DSH 文档同一页）─────────────────────
      var disposeUpd = slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "dsh-update-local", order: 30, label: function () { return hasUpdate ? "DSH 更新 ●" : "DSH 更新" } },
          function (props) {
            return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
              react.createElement(UpdView, null),
              react.createElement(DocsView, null))
          })
      })
      ctx.effect(function () { return function () { disposeUpd() } })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
