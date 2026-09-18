# dsh-updater-npm

**English** | [中文](README.zh.md)

DSH updater + official docs sync plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).

Two cards in Settings:

- **DSH Update (npm)** — checks the latest `@deepseek-ai/dsh` on npm and updates it in one click, with live progress and a "Restart DSH" button that performs the staged swap.
- **DSH Docs (official)** — incrementally syncs `deepseek-ai/deepseek-harness` `docs/` to `$DSH_HOME/docs-sync/` (skips unchanged files by GitHub blob sha) with a progress bar, and registers the `dsh_docs_search` / `dsh_docs_read` model tools.

[Install](#install) · [Usage](#usage) · [Run modes](#run-modes) · [Upgrade safety net](#upgrade-safety-net) · [Routes](#routes) · [License](#license)

## Install

```bash
# from npm (recommended)
dsh plugin --profile web add dsh-updater-npm

# or from GitHub
dsh plugin --profile web add github:SiriusWJ/dsh-updater-npm
```

Restart dsh web afterwards; the "DSH Update" and "DSH Docs" cards appear in Settings.

> **i18n:** the UI and every host message support **English / Chinese** and follow the system
> language automatically (or the manual choice in Settings → General → Language). The
> `dsh_docs_search` / `dsh_docs_read` tool descriptions and outputs follow it too.

## Usage

### DSH Update

- Checks every 30 minutes (the page refreshes the cached result every 60 s).
- A **red dot** (🔴) appears next to "DSH Update" in the Settings sidebar when a new version exists.
- "Update via npm" runs `npm install -g @deepseek-ai/dsh@latest` with live progress (bar + the last
  few lines of npm output). There is deliberately **no scrolling log panel** — the full npm output
  is written to `$DSH_HOME/plugin-data/dsh-updater-npm/last-run.log` when the operation ends, so
  the card stays quiet and the log is still there when you need it.
- When the update finishes, a **"Restart DSH"** button appears: it exits the current process with
  the original command line and relaunches it (PowerShell on Windows, `/bin/sh` on macOS/Linux).
  The same button appears after source-tree updates and deployment repairs.
  **No new activation URL is needed** — the browser re-authenticates by itself and no new window pops up.
- Once a swap succeeded (i.e. the new version is actually running) the card shows the **rollback
  point's disk usage** and a **"Remove rollback point"** button. The previous deployment is kept as
  `<sibling of install dir>/dsh.old-<timestamp>` (222 MB in a real case). Safety rule, enforced on
  the host: only rollback points whose **version differs from the running version** are listed and
  deleted — the live deployment is never touched.
- Version comparison is semver-style: a local version newer than the remote one (e.g. rc.7 vs rc.6)
  is not reported as an update.

### Timeout policy and run log (since v1.12)

Older versions used a blunt 10-minute hard timeout for npm installs. On a slow link a staged install
was measured downloading 247 tarballs (231 of the 239 `@deepseek-ai` sub-packages of a 222 MB tree)
in 9 min 25 s and was then killed, reporting just `staging install failed: npm` — **not a hang, not a
broken network, simply a hard timeout**.

The watchdog is now two-threshold, and configurable through
`$DSH_HOME/plugin-data/dsh-updater-npm/config.json`:

```json
{
  "docsEnabled": false,
  "npmIdleMinutes": 10,
  "npmTimeoutMinutes": 60
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `npmIdleMinutes` | `10` | minutes of **zero activity** before it is declared stuck and terminated (slow but moving ⇒ never killed) |
| `npmTimeoutMinutes` | `60` | absolute wall-clock ceiling, to stop a truly unbounded hang |

**What counts as activity (corrected in v1.12.1):** watching the child's stdout alone is not enough —
npm prints almost nothing when it is not attached to a TTY (one measured 5-minute install produced
**not a single stdout line** while npm's own debug log recorded 525 requests, and the watchdog killed
it). Three signals are now combined, and the maximum wins:

1. `--loglevel=http` — npm logs every request/stage to stdout (measured: 1111 lines instead of 0);
2. `--logs-dir` — npm's full debug log is written to `plugin-data/dsh-updater-npm/npm-logs/`;
3. **filesystem activity** — npm's debug log may only be flushed at exit on Windows (in a measured
   14-second install it sat at 0 bytes for 12 of them), so the staging directory and its
   `node_modules/` are watched as well: extraction keeps writing files there.

Only when **all three** are idle is the install treated as stuck; during a silent phase a
`[heartbeat] …` line is appended every minute (into `last-run.log`).

- On a watchdog kill the log carries `[watchdog] …` and `[exit] …` lines, and the error states
  whether it was an **idle timeout** or the **total limit**, with the elapsed time — no more opaque `: npm`.
- The same policy covers staged installs, non-Windows in-place `npm install -g`, and source-tree
  `pnpm/npm install`; `msiexec /qn` is silent by nature and gets a 10-minute idle window.
- `/dsh-updater-npm/progress` returns progress only (no log payload).

### Plugin self-version and self-update gate

- The card shows **this plugin's own version** and compares it with the latest `dsh-updater-npm` on
  npm (`GET https://registry.npmjs.org/dsh-updater-npm/latest`, cached for 10 minutes).
- If the plugin itself is outdated, the card says so and shows a copyable command
  (`dsh plugin --profile <your profile> add dsh-updater-npm@<latest>`). The "Update via npm" button is
  disabled, and `/update` is refused server-side with the same message.
- Reason: updating DSH is performed by the **currently running plugin code**, and an outdated
  plugin's upgrade path may itself be unsafe (1.9.0, for example, staged without `-g` on Windows and
  lost every dependency after the swap).
- **Offline pass-through:** nothing is blocked unless a newer plugin version is positively known, so
  air-gapped or offline setups are not locked out.
- Source-tree mode (`git pull`) is not gated, only hinted.

### DSH Docs

- **Sync switch (off by default):** the "DSH Docs" card has an "Auto-sync official docs" toggle.
  While it is off, nothing is synced and the `dsh_docs_search` / `dsh_docs_read` tools are **not**
  loaded. When on, the plugin syncs on first start (~217 files: English + Chinese `.zh.md`) and then
  every 24 hours, and registers the tools. The switch state lives in
  `$DSH_HOME/plugin-data/dsh-updater-npm/config.json`.
- "Sync official docs" triggers a manual sync (the switch must be on) with a progress bar
  (downloaded / total plus the current file) and phases (list → download → rebuild index).
- Search and read from the docs section, or straight from a conversation with the model tools:
  - `dsh_docs_search` — search the local official docs index (Chinese queries prefer Chinese docs)
  - `dsh_docs_read` — read one document (section focus, 80 KB truncation, path-traversal guarded)

Docs live in `$DSH_HOME/docs-sync/`, the index in `$DSH_HOME/docs-sync/.index.json`.

## Run modes

> **Windows without PowerShell 7:** DSH's shell tools need `pwsh`. When pwsh is missing the card
> shows a hint and an **"Install PowerShell 7"** button (tries `winget install Microsoft.PowerShell`,
> falls back to the official win-x64 MSI with live progress; restart DSH to apply).

The plugin detects the **run mode** and behaves honestly:

| Mode | Detected by | How it updates | Notes |
| --- | --- | --- | --- |
| npm-global | `argv[1]` is `<install>/lib/bin.js` | **Windows: staged update** (new version into a separate staging dir → "Restart DSH" atomically swaps it in, rolls back on failure). Non-Windows: in-place `npm install -g`, then "Restart DSH" | The Windows update target is the running instance itself (native deps included), where an in-place install hits EBUSY and leaves a half-installed tree. The staged flow never touches the live deployment; the old directory is renamed to `dsh.old-*` as a rollback point; the restart script validates the staged package before doing anything; a broken deployment is reported and can be repaired with one click |
| source (source tree) | `argv[1]` contains `bin.ts` / `tsx` / `apps/` | **Source-tree update:** `git fetch` → `git pull --ff-only` → dependency install (pnpm/npm) | Running from a source tree (`pnpm dsh web`) means `npm -g` does not affect the running instance. The card shows branch / local and remote commit / commits behind, with a one-click update; uncommitted changes or a missing git disable the button with a clear message |

> **Multi-copy protection:** an environment may contain several dsh copies (global dirs of several
> Node installations, DSH profiles, …). The plugin only ever updates **the currently running one**,
> preferring the npm that belongs to the running instance's own Node install; `/check` lists the other
> copies it detected, and an npm run that succeeds while the running copy's version does not change is
> reported as a failure instead of a false success. Copies are de-duplicated by **realpath**, so
> junctions/symlinks pointing at the running instance (e.g. dependency mirrors under
> `$DSH_HOME/profiles/node_modules`) are not mistaken for separate copies.

> Version-drift troubleshooting: if an update reports success but a restart brings back the old
> version, you are running from a source tree while npm updated the global install only. Start dsh in
> npm-global mode (e.g. a shortcut pointing at `D:\tools\node22\dsh.cmd web`) and the update applies.

## Upgrade safety net

> Each item below was added after a real 0.1.2-rc.1 → 0.1.5-rc.1 cross-version upgrade went wrong,
> and has been effective since v1.10.0.

1. **Staged installs must pass `-g` (layout consistency).** `npm install --prefix <staging>` without
   `-g` produces a **hoisted** tree, while an npm-global deployment is **nested**
   (`@deepseek-ai/dsh/node_modules/…`, self-contained). The swap only moves the package directory, so
   a hoisted staging tree means **losing every dependency of the new deployment**. The command now
   always passes `-g`, and before writing the pending-swap marker the plugin verifies that a nested
   live tree has a nested staging tree and that the staged `lib/bin.js` actually runs under the
   instance's own node — any failure aborts without touching the deployment.
2. **Validation precedes the kill.** The restart script validates the staged package (existence +
   layout) **before** stopping the current process; on failure it `exit 1`s, leaving the old process
   running rather than half-killed.
3. **The old deployment is kept as a rollback point.** After a swap the previous directory is renamed
   to `dsh.old-<timestamp>` (never deleted immediately) and the result is recorded. Once the new
   version looks stable, the card's **"Remove rollback point"** button frees the space.
4. **Rename retries.** A just-terminated process may briefly hold directory handles, so the rename is
   retried up to 5 times, 3 seconds apart.
5. **Automatic pre-upgrade backup.** When a version will actually change, `settings.yaml`,
   `.credentials.yaml`, `.agent-presets/` and every profile's `package.json` / `cordis*.yml` /
   `pnpm-lock.yaml` are snapshotted to `$DSH_HOME/upgrade-backups/dsh-<from>-to-<to>-<timestamp>/`;
   session logs (up to 256 MB) are copied too, because sessions migrate to a format that **cannot be
   read back** by older versions. The newest 5 snapshots are kept.
6. **No activation URL is required after a restart.** Since DSH 0.1.5 the web auth cookie is signed
   for one activation, so a restart invalidates it — but the browser re-authenticates on its own.
   (Up to v1.12.2 the restart script scraped the new `?token=` URL, wrote
   `activation-url.txt` and opened a browser window; that whole path was removed in v1.12.3 as it was
   not needed.)
7. **Leftover detection and one-click cleanup.** `/check` reports unreferenced `staging-*` / `repair-*`
   directories (one unfinished update left **222 MB** behind) and npm's interrupted-install
   `.<name>-<hash>` leftovers (65 MB in a real case); the card offers "Clean leftovers", and staging
   directories older than 6 hours are reclaimed automatically at startup.
8. **Cross-version breaking-change notice.** Jumping across a known breaking range (currently `0.1.5`:
   V3 session format, persona `text` → `prefix`/`suffix`, plugin API and slot changes) shows a notice
   with a release-notes link.
9. **The restart launcher really launches (v1.12.2).** `spawn('powershell.exe', …, { detached: true })`
   on Windows equals `DETACHED_PROCESS`: the script does not run a single line while spawn still
   reports `exit=0` — a silent false success that left the swap undone. The launcher now starts a
   detached **node bootstrap** which runs the platform script as an ordinary child and writes
   `node bootstrap started <token>` into `restart.log`; the plugin only hands over the staged package
   after that token shows up (≤ 5 s), and otherwise keeps `pending-swap.json` and the staged tree and
   reports a clear error.

## Routes

- `GET  /dsh-updater-npm/check` — update check (10-minute cache; includes the cross-version notice, last restart result, pending swap, leftovers and rollback points)
- `POST /dsh-updater-npm/update` — run the npm update (same-origin only; backs up first, then stages)
- `POST /dsh-updater-npm/restart` — restart this DSH instance (same-origin only; atomically swaps a pending staged package into place, Windows/macOS/Linux)
- `POST /dsh-updater-npm/cleanup` — remove leftover staging dirs and npm install leftovers (same-origin only)
- `POST /dsh-updater-npm/cleanup-rollback` — remove rollback points whose version differs from the running one (same-origin only)
- `GET  /dsh-updater-npm/progress` — live update/sync progress (polled)
- `GET  /dsh-updater-npm/docs/status` — docs sync status
- `POST /dsh-updater-npm/docs/sync` — trigger a docs sync (same-origin only)
- `GET  /dsh-updater-npm/docs/search?q=&lang=&limit=` — search the local docs index
- `GET  /dsh-updater-npm/docs/read?path=&section=` — read one document

## Changelog

### v1.13.0

- **Added:** after a successful swap (new version running) the card shows the rollback point's disk
  usage and a **"Remove rollback point"** button (`POST /dsh-updater-npm/cleanup-rollback`). The safety
  rule is enforced on the host: only `<leaf>.old-<timestamp>` directories whose version differs from
  the running version are listed and removed, so the live deployment is never affected (hard assertions
  in the smoke tests).
- **Polished:** the card's explanatory prose is gone — `updNote` / `docsNote` / `pluginOutdatedBody`
  were removed entirely and the remaining strings were compressed to a single line (`srcDirty`,
  `pwshMissingHint`, `deployBrokenWarn`, `npmMismatch`, `stagingWasteFound`, `repairRunning`,
  `docs*Hint`, …), leaving state and actions only.
- Tests: 58 (new: rollback scanning, only non-current versions removed, live deployment untouched,
  same-origin guard on the cleanup route).

### v1.12.3

Subtracting, on user feedback:

- **Removed:** the restart script's whole "scrape the new activation URL + open the browser" logic
  (both the Windows and the POSIX branch), plus the up-to-2-minute polling tail it needed.
- **Removed:** the **scrolling run-log panel** — the full npm output now goes to
  `plugin-data/dsh-updater-npm/last-run.log` when an operation ends (`[watchdog]` / `[exit]` lines
  included) and the card keeps only the progress bar and the last few lines. `/progress` no longer
  carries `log` / `limits`.
- Kept: `--loglevel=http` (it is the watchdog's real heartbeat, not decoration), the three-signal
  activity probe, and the idle/hard timeout pair.
- Tests: the script assertions now check that no token is scraped and no browser is opened, plus a
  `last-run.log` assertion (56 total).

### v1.12.2

Fixes the broken chain "the built-in restart does nothing, and after an external restart you are still
on the old version": the staged install had actually **succeeded** (`verbose exit 0` / `info ok`), but
the restart step failed silently, so the swap never happened.

- **Root cause (reproduced):** `launchRestartScript` used
  `spawn('powershell.exe', […], { detached: true })`. On Windows that is `DETACHED_PROCESS`: the console
  program exits immediately with `exit=0` **without executing a single line** of the script, while spawn
  reports no error. A/B test: the same script run through a detached **node bootstrap** executes fine.
- **Fix (critical):** launch a detached `node` bootstrap that runs the platform script as an ordinary
  child; the bootstrap writes `node bootstrap started <token>` into `restart.log`.
- **Fix (critical):** `restartNow` now **waits for that token** (up to 5 s) before handing over the
  staged package. If it never appears, it returns a clear error and **keeps `pending-swap.json` and the
  staging directory** — the old code deleted the marker here, so the 222 MB staged tree was later swept
  as "leftover garbage" and the user could neither upgrade nor recover it.
- **Added:** `/check` returns `pendingSwap`, and the card shows "staged, waiting to be swapped" while
  keeping the "Restart DSH" button, so an external restart can still be completed with one click; a
  marker whose staging directory is gone is cleaned up automatically.
- Tests: 3 new (54 total) — the launcher is **really executed**, `waitForBootstrap` does not report
  false positives, and launcher + swap script perform a real directory swap on a fake deployment. The
  old code necessarily fails these, which is exactly why it slipped past the previous 36 tests.

### Earlier releases

- **v1.12.1** — fixed the false kill introduced by 1.12.0: npm is silent on stdout without a TTY, so
  the stdout-only idle watchdog killed a working install at exactly 5m00s. Added `--loglevel=http
  --progress=false`, `--logs-dir` and a three-signal activity probe; default `npmIdleMinutes` 5 → 10.
  Measured end-to-end: 520 packages in 1m, 222.6 MB / 25474 files, exit code 0 (the cold-cache run of
  the same command never finished in 9m25s).
- **v1.12.0** — the blunt 10-minute hard timeout became idle timeout + wall-clock ceiling, configurable
  via `npmIdleMinutes` / `npmTimeoutMinutes`; the watchdog and the run log were introduced (log panel
  removed again in 1.12.3); the source-tree dependency install reuses the same watchdog.
- **v1.11.0** — the card shows the plugin's own version and gates "Update via npm" while the plugin
  itself is outdated (`/update` refuses too; offline pass-through).
- **v1.10.0** — the upgrade safety net above, after the real 0.1.2-rc.1 → 0.1.5-rc.1 upgrade:
  `-g` + layout/executability validation, validate-before-kill, rollback point, rename retries,
  pre-upgrade backups, output redirection, leftover cleanup, breaking-change notices.

Full Chinese changelog with every measurement: [README.zh.md](README.zh.md#更新日志).

## License

[MIT](LICENSE)
