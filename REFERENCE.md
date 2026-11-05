# dsh-record-and-replay

[![CI](https://github.com/kakaCat/dsh-record-and-replay/actions/workflows/ci.yml/badge.svg)](https://github.com/kakaCat/dsh-record-and-replay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DSH host plugin for Cua Driver-only browser recording and replay (plugin id: `dsh-record-replay`).

> npm package: `dsh-record-and-replay` (the plugin id and CLI stay `dsh-record-replay`; the CLI also answers to `dsh-record-and-replay`).

## Install

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-record-replay
```

The package declares `dsh.bundle.patch`; the profile loader inserts the host plugin automatically. Recording, replay and the skill library are enabled by default; add a profile override only to disable a feature or change paths/limits.

## Config

```yaml
- id: record-replay
  name: dsh-record-and-replay
  config:
    transport: mcp           # default mcp (0.38 CLI daemon); native is opt-in
    transportFallback: true  # native failure falls back to MCP and reports why
    recording:
      enabled: true        # default true
      maxDurationSeconds: 1800  # auto-stop with endReason max_duration; 0 disables
      consent: implicit    # off | implicit | explicit (explicit requires cua_record_start consent: true)
      privacy:
        deniedUrlPatterns: []      # case-insensitive substrings; matched steps go to suppressed.jsonl
        blockPrivateBrowsing: true # refuse existing windows whose title is an incognito/private window
    replay:
      enabled: true        # default true
    skill:
      enabled: true        # default true; set false to unregister the write tools (generate/install/feedback) entirely — reads stay
      rootDir: .dsh/skill-library
      autoFeedback: true   # replay terminal states automatically feed skill counters (idempotent by runId)
    tools:
      allow: []            # default []; non-empty = expose only these host tools
```

Feature switches also trim the model tool surface: when a switch is off, tools that could only answer `FEATURE_DISABLED` are not registered at all. `recording: false` drops `cua_record_start` / `cua_record_bind_browser` / `cua_record_observe` / `cua_record_action`; `replay: false` drops `cua_replay_start`; `skill: false` drops `cua_skill_generate` / `cua_skill_install` / `cua_skill_feedback`. Finishing (`stop` / `discard` / `export`), cancel/release and read tools stay available, and `cua_record_replay_status` reports the skipped names under `disabledTools`.

## Docker backend

The optional Docker backend is an **independent Cordis plugin row**, `record-replay-docker` (package subpath `dsh-record-and-replay/docker`). It is **disabled by default**; enable it on the DSH plugin page, or enable the row explicitly:

```yaml
- id: record-replay-docker
  name: dsh-record-and-replay/docker
  disabled: false
  config:
    dockerBin: docker
    # image: your-custom-tag  # omit for the content-addressed bundled tag
    autoBuild: true
    display: ':99'
    width: 1280
    height: 720
    startupTimeoutMs: 30000
    buildTimeoutMs: 600000
    persistProfiles: true
```

`image` may select a custom tag. `autoBuild: false` disables image building; otherwise the first use builds the content-and-architecture-addressed bundled image when it is missing. A Docker daemon is required.

The backend keeps the existing tools, store, panel and semantic replay, but runs them against a plugin-managed native Linux container (`linux/amd64` or `linux/arm64`). The bundled `docker/Dockerfile` and `entrypoint.sh` supply Xvfb, Openbox, Google Chrome on AMD64 or Debian Chromium on ARM64, Cua Driver 0.38.0 and ffmpeg; Rosetta emulation is not required.

- Containers start lazily per workspace and are removed on runtime disposal or when the Docker row is toggled off.
- Only `launch: "isolated"` is supported. Host `existing` and `desktop` targets are rejected, and native-to-local fallback does not apply.
- Replay video uses ffmpeg `x11grab` inside the container; a bind mount writes it to the existing `runs/<runId>/video/` directory.
- With the default `persistProfiles: true`, named Cua profiles use a per-workspace home volume and are not deleted with the container.
- The container runs as a non-root user with a read-only root filesystem. Chrome's namespace sandbox requires `SYS_ADMIN` and `SYS_CHROOT` after `cap-drop ALL`; the plugin does not use `--privileged` or mount the Docker socket.
- DSH sandbox policy does not confine container internals.

## Transports

| Transport | Runtime | Existing-profile attach | Notes |
|---|---|---|---|
| `native` (opt-in) | `@trycua/cua-driver` 0.28 in an isolated child process (`native-host.mjs`) | granted per bind by our `DriverAuthorizationHost` inside the child (exact pid + window only) | Requires a host whose bundle identity is `com.trycua.driver`; inside DSH (`com.deepseek.dsh`) it preflights as unavailable and falls back to MCP |
| `mcp` (default) | `cua-driver mcp` child process, 0.38 CLI | the daemon's own existing-profile grant | Process isolation, verified M0 path |

The plugin connects on the first browser action, probes `health_report`, then enforces the per-transport version floor (native 0.28.0, MCP 0.38.0). If the preferred transport fails, the driver falls back to the other one once and records the reason; `cua_record_replay_status` reports `transportActive` and `transportFallbackReason`.

The native SDK never loads in the DSH process: `src/cua/native-host.ts` is built to `dist/native-host.mjs`, spawned with `ELECTRON_RUN_AS_NODE=1`, and speaks MCP over stdio. The parent side is the same `CuaTransport` contract as the CLI path, so recording and replay do not care which one is active.

Native is pre-flighted: when `health_report` reports a failing `bundle_identity` check, the child cannot pass macOS TCC checks for inspecting browser processes, so the plugin falls back to MCP before the first bind instead of failing it.

## Slash commands

When DSH's `commands` service is mounted (interactive UI), the plugin registers six human commands that never go through the model:

| Command | Effect |
|---|---|
| `/record-status` | workspace, feature switches, transport and the active recording |
| `/record-start <title>` | start a recording in this workspace (records an explicit consent grant) |
| `/record-stop` | stop the active recording owned by this session |
| `/record-discard` | discard the active recording: kept for audit, marked `cancelled`, never replayed or turned into a Skill |
| `/record-launch [profileName]` | launch a driver-owned browser and bind it; a profile name keeps logins across runs |
| `/record-bind <pid> <windowId>` | bind this session to a local browser window |

Command registration is isolated in its own `commands` injection, so a composition without the commands service still gets the agent tools.

## Recording lifecycle

A recording has one writer per workspace and ends in one of four terminal
states: `completed`, `failed`, `interrupted` or `cancelled`. Every close writes
an `endReason` to the manifest:

| `endReason` | Status | When |
|---|---|---|
| `tool_stopped` | `completed` | `cua_record_stop` or `/record-stop` |
| `max_duration` | `completed` | reached `recording.maxDurationSeconds` (default 1800 s) |
| `cancelled` | `cancelled` | `cua_record_discard` or `/record-discard` |
| `failed` | `failed` | the writer closed after a failure |
| `interrupted` | `interrupted` | startup recovery or store shutdown found a half-written recording |

- **Auto-stop.** The service schedules one timer per active recording; expiry
  calls the same stop path with `max_duration`. `recording.maxDurationSeconds: 0`
  disables the timer.
- **Consent.** `recording.consent` is `implicit` by default: the manifest stores
  `{mode, scope, grantedAt, grantedBy}` and the scope text is visible to the
  caller. Set `explicit` to require `cua_record_start` to pass
  `consent: true`; `/record-start` records an explicit grant because a human ran
  the command (unless `recording.consent` is `off`). Passing `consent: false` is refused in every mode.
- **Discard.** `cua_record_discard` closes the active recording as `cancelled`
  and leaves the directory in place for audit. It is not replayable and cannot
  produce a Skill; use the panel's 移到回收站 to delete the files.
- **Startup recovery.** Opening a workspace store runs `recoverStore`: stale
  locks are reclaimed, a half-written `steps.jsonl` is backed up and truncated,
  and any recording still marked `recording` becomes `interrupted`. This runs
  once per workspace runtime, so a crashed previous session no longer leaves an
  unrecoverable "recording" entry.

## Privacy

Recording has a suppression path that is separate from redaction:

- **URL policy.** `recording.privacy.deniedUrlPatterns` holds case-insensitive
  substrings. A `navigate` URL, a semantic target's `origin`/`path`, a
  `wait`/`assert` URL, or a drag endpoint that matches is suppressed: the step
  (and every following step, until a `navigate` to a non-denied URL) is written
  to `suppressed.jsonl` instead of `steps.jsonl`. A suppressed step keeps only
  `stepId`/`callId`/`actionKind`/`reason`/`at` — never the URL, page text, or
  typed value.
- **Private windows.** `recording.privacy.blockPrivateBrowsing` (default on)
  refuses `launch: "existing"` when the bound window title is an
  incognito/private window (`Incognito`, `InPrivate`, `Private Browsing`, `无痕`,
  …). Turn it off if a flow intentionally uses a private window; `isolated`
  launches are never treated as private.
- **Counts.** `suppressedCount` is updated in the manifest, returned by
  `cua_record_query`/Host DTO, shown in the panel detail as **已抑制 N 步**, and
  added to a Skill draft's ambiguities when non-zero.
- **Redaction.** Typed `setValue` values are always masked; result/error strings
  additionally redact credit-card numbers, AWS access keys, `sk-`/`api-` keys,
  auth headers and secret assignments.

Limitations: the policy only sees URLs that appear in the action (a target-less
click carries no URL), and once blocked it stays blocked until a navigate to a
non-denied URL; `allowedUrlPatterns` is not implemented yet.

## Session export

`cua_record_export` writes one **terminal** recording into a small portable
directory (read-only over the Store; the destination must not exist):

```
session.json      metadata, status, endReason, suppressed count, relative file names
events.jsonl      session.started / agent.action / session.ended
suppressed.jsonl  copied verbatim when the URL policy suppressed steps
```

- Default destination: `<store>/exports/<recordingId>/session`; a `destination`
  argument must stay workspace-relative. The write stages in a sibling
  directory and renames, so a failed export leaves no half-written session.
- `events.jsonl` records `agent.action` entries (id, seq, timestamp, origin,
  action, status, duration, result summary, error, evidence). It deliberately
  does **not** map `navigate` to `window.changed` or synthesize `mouse.click`:
  this is an agent action log, not the reference human event stream.
- `session.json` carries `format: "dsh-record-replay-session"` / `formatVersion: 1`,
  `eventsPath`, optional `suppressedEventsPath`/`suppressedCount`, `endReason`,
  `stepsSha256` and the consent record when one was stored.
- Only recordings owned by the calling session and already terminal
  (`completed` / `failed` / `interrupted` / `cancelled`) are exportable; an
  active recording returns `INVALID_ARGUMENT`.
- Suppressed steps never enter `events.jsonl`; `suppressed.jsonl` keeps only
  stepId/callId/actionKind/reason/at.

## Recording intent

`cua_record_start` takes an optional `intent` string — the user requirement or
use case the recording demonstrates. It is stored in the recording manifest and
returned by `cua_record_query`:

```json
{"title":"B站搜索：明日方舟周年庆","intent":"输入关键词并确认结果页出现活动入口。"}
```

- Recordings started without it stay valid; the panel then shows the title plus
  a **未填写用例** mark.
- Existing recordings can be annotated without touching recording files by
  adding an `intent` to `.dsh/record-replay/index.json` `assignments`
  (`{"rec_…":{"intent":"…"}}`). The index value wins over the manifest and is
  labelled **index 补注** in the panel.
- The panel shows the intent in the Runs list and above the replay video; long
  text collapses to three lines with an expand control.

## Bind modes

`cua_record_bind_browser` supports three modes:

| `launch` | Needs | Browser | Use it for |
|---|---|---|---|
| `existing` (default) | `pid` + `windowId` | the user's running Chrome/Edge window (their profile, their logins) | flows that depend on an authenticated session |
| `isolated` | nothing | a disposable, driver-owned Chromium launched by Cua | demos, CI, public pages, and whenever Cua refuses to attach to the existing window |
| `isolated` + `profileName` | nothing | a **named**, persistent driver-owned Chromium profile | flows that need a login: sign in once inside that window, later runs reuse the same profile |
| `desktop` | `pid` + `windowId` | a macOS AX window (Electron/native app) | desktop flows: `click`/`setValue`/`key`/`assert` map to AX actions; `navigate` and URL assertions are unsupported |

`profileName` must be 1-64 path-safe ASCII characters (`[A-Za-z0-9._-]`). The named profile lives under Cua's driver-owned storage, not your Chrome profile: credentials persist there, so use a dedicated account and clear it when it is no longer needed.

Before each named-profile launch the plugin patches the profile's `Preferences`:

- `profile.exit_type = "Normal"` / `exited_cleanly = true` — Chrome stops offering "restore pages?" after Cua terminates the browser;
- `session.restore_on_startup = 1` — Chrome persists session cookies, so a login survives Cua's process teardown and even a daemon restart.

Give Chrome ~30 seconds after a fresh login before releasing the binding; newly written cookies still follow Chrome's own flush timer.

`isolated` returns the launched `pid`/`windowId`; `cua_replay_start` accepts `launch: "isolated"` to replay into a fresh driver-owned browser. An isolated browser ends with its Cua session, so release or end the session when you are done.

Cua 0.38 may refuse `existing` attachment with `background_unavailable` (the browser is on the same Space and attaching would steal focus) or `browser_wrong_target_refused` (it could not prove the window with an exact English "New Tab" button). Neither is a DSH configuration problem; use `launch: "isolated"` or move the browser window to another Space.

## Replay semantics

- Only steps that finished with `status: "success"` are replayed; failed steps stay in the recording as audit evidence and are skipped instead of replaying the same error.
- A target that is not rendered yet is retried for up to 5 seconds (`TARGET_NOT_FOUND` only), so replay at machine pace survives SPA render delays.
- Ambiguous locators can be disambiguated with `target.index` (0-based, counted over visible matches). Elements Cua reports as `offscreen` are skipped while at least one `in_viewport` match exists; hidden elements never appear in the refs. Without an index the driver fails with `TARGET_AMBIGUOUS` and names the visible match count.
- `click` honours `button`/`count` on browser bindings: left single click keeps `browser_click`; `button: "right"` maps to `browser_pointer` `right_click`; `count: 2` maps to `double_click`. `count: 3` and right + `count > 1` are rejected with `ACTION_UNSUPPORTED`.
- A left single click is **verified, not assumed**. Cua's `browser_click` reports `effect: "unverifiable"`: it proves the CDP mouse event was dispatched, not that the control activated. The driver compares the semantic snapshot the click was resolved against with the page afterwards (URL, element role/name/value, focus/checked states) for up to 1.5 s. If nothing changed it re-resolves the target on a fresh snapshot and re-dispatches **once** as a synthetic DOM click (`input_route: "dom_event"`), which runs inside the page and bypasses native input routing. If that also changes nothing the step fails with `ACTION_UNCONFIRMED` instead of reporting a click that never happened. Right/double clicks are never retried.
- `ACTION_UNCONFIRMED` is distinct from `ACTION_UNSUPPORTED` (no route exists) and `ASSERTION_FAILED` (the action may have happened; the expectation did not hold).
- A click that opens a new tab **in the same browser window** moves the binding onto the tab that becomes active (for example `<a target="_blank">` or Bilibili's 热门). The driver re-reads the active tab for up to ~2 s after the click and replaces Cua's target id and tab id together, because Cua mints new session-scoped handles on every window query. A background tab, a different browser target/window, or a failed refresh leaves the binding on the original tab; the click keeps its success and the step summary says why it did not follow. If the followed tab is still on a provisional frame, the next observe re-mints the active pair and retries instead of surfacing `browser_route_unavailable`.
- `scroll` maps to Cua's `browser_pointer` `scroll` with `delta_x`/`delta_y` in CSS pixels. With a `target` the driver resolves the ref and scrolls at it (Cua brings the ref into view, then applies the delta); without a target it scrolls at the viewport centre, measured once per binding from Cua's screenshot metadata and cached (the wheel needs a point: Cua rejects a scroll with neither `ref` nor `x`/`y`). A zero delta is rejected with `INVALID_ARGUMENT`.
- `key` is **not supported on browser bindings** and stays `ACTION_UNSUPPORTED`. Cua 0.38 has no browser-scoped key tool: `browser_pointer` only does pointer gestures, `browser_type` `mode: "keystrokes"` types text (the letters of "Enter" are typed, not the key), and `press_key`/`hotkey` are native-window tools that do not reach a background tab. The action is therefore excluded from the **browser** capability table; use a `desktop` binding with `cua_desktop_press_key`, or replace the step with `click`/`assert` (the browser `wait` action is also unsupported). Desktop bindings still advertise `key` (and replay plans pass their launch mode, so desktop key steps stay executable).
- Cua's opaque `target_id` is **not** stable across window queries. Never mix a `target_id` from one `get_browser_state` response with a `tab_id` from another; that pair is refused with `browser_tab_not_found`.

## Assertions

`cua_record_action` accepts a read-only `assert` action, so a replay can prove an outcome instead of only delivering inputs:

```json
{"kind":"assert","check":{"kind":"url","contains":"/settings"}}
{"kind":"assert","check":{"kind":"text","contains":"Saved"}}
{"kind":"assert","check":{"kind":"element","target":{"role":"button","name":"Pay"},"exists":true}}
{"kind":"assert","check":{"kind":"value","target":{"role":"textbox","name":"Email"},"equals":"a@b.c"}}
```

- Assertions are evaluated on the live semantic snapshot with the same visible-match rule as `target.index`; hidden/offscreen duplicates do not satisfy them. `text` checks element names/values in that snapshot, not arbitrary rendered page text (e.g. an `<h1>` that Cua does not expose as a ref cannot be asserted this way).
- `css` targets are rejected for assertions (semantic locators only).
- A failed assertion ends the Run with `ASSERTION_FAILED`, writes `step-<seq>/error.json`, and skips the remaining steps.

## Desktop (macOS AX)

Cua can drive whole windows, not only browsers. The desktop tool set ships as a **separate bundle line** — `record-replay-desktop` (`dsh-record-and-replay/desktop`), inserted by the same `cordis.patch.yml` and **disabled by default**, because these names are a second action vocabulary next to `cua_record_action`. Enable it on the DSH plugin page (one toggle per line, like `dsh-window`); while the line is off, its `apply` never runs and the 8 tools below are completely absent from the model surface. The desktop line shares the main line's workspace runtimes and Cua transport; it carries no config of its own.

- `cua_desktop_state` — snapshot one window: AX role/label/value/enabled (read-only);
- `cua_desktop_click` — click one element, re-snapshotting first and targeting by role/label;
- `cua_desktop_set_value` — write a value (use this instead of `type_text` in Electron);
- `cua_desktop_press_key` — press one key;
- `cua_desktop_scroll` — scroll the window (or one element); Electron content needs foreground delivery;
- `cua_desktop_drag` — drag from one AX element to another;
- `cua_desktop_assert` — assert AX element existence/enabled state;
- `cua_desktop_screenshot` — capture the window to an absolute PNG path.

`drag` is replayable on both binding kinds:

- **browser bindings** resolve `from`/`to` to page refs and send Cua's `browser_pointer` drag; this works for pointer-event pages and HTML5 drag-and-drop;
- **desktop bindings** move between AX element centres in **window-local screenshot pixels** (`screenshot_frame`), never raw AX `frame` — AX frames are screen coordinates, and using them shifted every drag by the window origin/title bar (the earlier "delivered but no drop" failure);
- HTML5 drag-and-drop follows the hardware pointer. When Cua refuses background delivery (`background_unavailable` / `drag_and_drop_session`) the desktop driver retries once with `delivery_mode: "foreground"`, which briefly fronts the window and moves the pointer.

Record/replay works on desktop bindings too: bind with `launch: "desktop"`, then use the normal `cua_record_*` tools; `cua_replay_start` accepts `launch: "desktop"` with the same `pid`/`windowId`. `navigate` and URL assertions are refused on a desktop binding.

Constraints learned from live testing on the DSH desktop app:

- `element_token` is snapshot-scoped; every action re-snapshots and resolves by role/label.
- `type_text` is refused for Electron web content (`background_unavailable`); `set_value` works.
- `verify_state` reports `unknown / untrusted_source` for Electron web content, so assertions use the AX observation instead.
- Click effects are reported as `unverifiable`; assert afterwards to prove the outcome.
- AX `frame` is screen coordinates; `screenshot_frame` (returned with a window capture) is window-local screenshot pixels and is what pixel actions expect.

## Replay video

Every replay records the screen to WebM (VP9, 1280 wide, 10 fps, CRF 36, no audio) and returns `videoPath`:

```
runs/<runId>/video/replay.webm
```

- enabled by default; set `{ "replay": { "video": false } }` to turn it off;
- host capture input can be overridden with `DSH_REPLAY_VIDEO_INPUT` (macOS `avfoundation` default `0:none` = first screen, no audio; Windows `gdigrab` default `desktop`);
- host capture is whole-screen, so other windows may appear; macOS host capture needs Screen Recording permission;
- Docker replay uses container `x11grab`; a bind mount preserves the Run video path above;
- stopping writes ffmpeg's `q` command to stdin so the container finalizes without relying on POSIX signals;
- if ffmpeg cannot start, the replay still succeeds and simply has no video.

## Video usage

```bash
node scripts/video-usage.mjs            # 每个 recording 的视频数量/体积 + 合计
node scripts/video-usage.mjs --root DIR # 指定 recordings 根目录
```

清理由 `replay.videoMaxRuns`（默认 50，每个 recording 保留最近 N 个成功 Run 的视频）在每次回放后自动执行；失败/取消的 Run 视频不会被删。

## Global record/replay panel (M1.6 browse + M2 search/stats + M3 replay/trash/keyboard)

The panel lives in the **DSH right sidebar**. A **录制回放 / Record & Replay**
row at the foot of the left sidebar opens it as a right-column tab
(`sidebarRight.openTab("recordReplay")`); it never replaces the conversation's
main panel. Why the footer row instead of the old `sidebar.panellist` icon: a
panellist row is hard-wired by the sidebar shell to select a matching main
panel, while the right column is session-scoped. The footer action owns its own
button, which is what lets it expand the right sidebar instead.

The panel lists DSH workspaces, scans each project's `.dsh/record-replay`, and
never changes the recording data or registers another host tool. Data travels
over DSH's authenticated same-origin connection at `/api/record-replay/*`; the
panel does not start a second port. The right-column variant keeps the
category/scenario tree on top and opens the selected recording, its Runs, its
intent and the video in a collapsible pane **below** it (50% by default,
draggable, own scroll), so the list stays visible while browsing. Narrow
viewports of the standalone page use the same stacked layout.

M2 adds a **全部项目** entry to the project selector. In that mode the header
shows system-wide cards (projects, recordings, runs, failure rate, video
footprint) and the left column lists every project with its own recording/run/
failure/video numbers. Typing in the search box switches the left column to a
**cross-project, project-grouped result list**; clicking a result switches to
that project and selects the recording in one step. Cross-project search scans
projects with a bounded concurrency of 4 and returns at most 100 matches by
default (`limit` up to 500), reporting `total`/`returned`/`truncated` so the UI
can tell the user when to narrow the term. Project and recording lists are
paginated with `limit`/`offset` (default 50, max 200); the client uses TanStack
Query infinite queries with explicit **加载更多** controls while keeping the
virtualized tree/result rendering for long lists. Stats are derived from the
same scanner output as the lists — no extra file walks.

M3 adds the two actions that used to require the CLI, plus keyboard navigation:

- **重跑 (replay)** — the recording detail has a **重跑** button. It asks for
  confirmation (an isolated Chromium window is launched and write actions in
  the recording really execute), then `POST /replay` starts a background Run and
  returns `{ runId }` immediately. The detail polls `GET /recording` every
  1.2 s while the Run is `preparing`/`running`, adopts the new Run, and shows
  its status; after `completed` the generated WebM is playable in the panel.
  Runs are written by the same workspace `ReplayPort` the CLI and
  `cua_replay_start` use, so they land in the original recording's
  `runs/<runId>/` (`run.json`, `steps.jsonl`, `video/replay.webm`) exactly like
  a CLI replay. `launch` is fixed to `isolated`: the panel never takes over the
  browser window a session has bound.
- **移到回收站 (safe delete)** — moves the whole recording directory to
  `<project>/.dsh/record-replay/trash/<recordingId>-<compact UTC stamp>/` with
  one atomic `rename`. Nothing is deleted, the manifest/steps/runs/assets stay
  byte-identical, and the recording's `index.json` assignment is removed in the
  same request. Collisions get a numeric suffix; a symlinked recording
  directory (or a trash directory that resolves outside the store) is refused.
  If the index cleanup fails, the move is rolled back so a failed request
  leaves no half-applied state. The panel hides the recording from the tree
  after the move; the trash directory is intentionally not browseable yet.
- **Keyboard navigation** — in the tree (and the cross-project result list):
  `↑`/`↓` (plus `Home`/`End`) move focus, `Enter` expands/selects, `F2` renames
  the focused category/scenario/recording (on 未分组 it opens the create-scenario
  dialog), `Esc` cancels the editor or leaves the row. Events from the rename
  input are ignored, so typing never moves focus. Rows have a visible
  `focus-visible` ring and the tree header shows a short shortcut hint.

`GET /capabilities` tells the client whether the process can replay, trash or
control a recording. The standalone `panel` command has no driver connection,
so it reports `replay: false`; its detail shows a disabled 重跑 button with the
explanation "独立 panel 进程没有回放服务…". A late `PANEL_REPLAY_UNAVAILABLE`
(e.g. replay disabled by config) also disables the button for the rest of the
session. The standalone server keeps its read-only rule: it serves
`/capabilities` and `/active`, answers `/replay` with 503
`PANEL_REPLAY_UNAVAILABLE`, and answers `/stop`/`/discard` with 503
`PANEL_CONTROL_UNAVAILABLE`; trash/replay/control exist only on the DSH mount.

### Live recording HUD (P1-1)

The left-sidebar **录制回放** footer entry doubles as a live recording HUD:

- while a recording is active it shows **录制中 mm:ss** with a pulsing red dot;
  the tooltip carries the title and step count;
- in the wide footer it also shows two icon buttons: **停止** and **丢弃**.
  Discard requires a second click within 4 s (it keeps the directory as
  `cancelled`; it is not a delete);
- the HUD polls `GET /api/record-replay/active?root=<session workspace>` every
  second, so it only scans the mounted session's workspace. Without a session
  root it falls back to all whitelisted projects;
- stop/discard call `POST /api/record-replay/stop` / `/discard`; the host
  derives the principal from the recording manifest's `ownerSessionId`, so the
  panel never invents ownership. A recording owned by another DSH process is
  reported as `RECORDING_LOCKED` instead of being force-closed.

The standalone entry remains for headless/debug use:

```bash
pnpm build
node dist/cli.mjs panel --root /path/to/workspace --port 4174
# open http://127.0.0.1:4174/panel/
```

`panel` options:

| Flag | Meaning |
|---|---|
| `--root <dir>` | Extra whitelisted project root (repeatable) |
| `--port <n>` | HTTP port (default `4174`) |
| `--host <addr>` | Bind address (default `127.0.0.1`) |
| `--public-dir <dir>` | Built client assets (default `<package>/dist/panel`) |
| `--cors` | Allow cross-origin reads (for a DSH web UI on another loopback port) |

The project selector combines explicit `--root` directories, DSH workspaces
read from `~/.dsh/storages/workspace.json` (`DSH_HOME` is honored) and folders
the user opened through the picker (persisted in
`~/.dsh/record-replay-panel.json`). The standalone command also offers its
current directory; the DSH mount disables that candidate, because the host
process runs from the application/profile directory (`~/.dsh/profiles/desktop`)
or wherever the app was launched, not from a user project. Only these roots are
accepted by the API; every root is symlink-resolved and the request id must
match the Core `rec_`/`run_` grammar before a path is built.

The selector's default rule (first match wins): the root selected last time
(localStorage), the current DSH session's workspace when it has recordings, the
standalone current directory, the first project with recordings, then the first
project. A remembered root is only used when it still exists in the project
list, is not a DSH/user/system directory (`~/.dsh/**`, the user's home or `/`)
and has at least one recording directory; otherwise it is ignored for this
startup but kept in localStorage. `GET /projects` reports a cheap
`recordingCount` per project so the client never opens on an empty folder just
because it happens to be first.

The **folder-plus** button next to the selector calls DSH's composed directory
picker (`ctx.uiWorkspace.pickDirectory()`), registers the chosen folder through
`POST /root` and remembers it. Empty states distinguish **项目不存在**
(`PANEL_ROOT_NOT_FOUND`) from **这个项目还没有录制**; the latter also offers
**切换到有录制的项目**, which expands the projects whose `recordingCount > 0`
and switches to the selected one without hiding the folder picker.

| Standalone endpoint | DSH endpoint | Response |
|---|---|---|
| `GET /panel/projects[?limit=&offset=]` | `GET /api/record-replay/projects[?limit=&offset=]` | `{ projects: [{ root, name, lastOpenedAt?, isCurrent?, recordingCount? }], page: { total, limit, offset, hasMore } }` (default 50, max 200) |
| `POST /panel/root` | `POST /api/record-replay/root` | `{ root }` → widen the whitelist, remember the folder and return its project summary |
| `GET /panel/project?root=…[&limit=&offset=]` | `GET /api/record-replay/project?root=…` | categories, scenarios, whole-project stats and one page of recordings (`recordingsTotal`, `recordingsPage`) |
| `GET /panel/recording?root=…&id=…` | `GET /api/record-replay/recording?root=…&id=…` | recording summary (including `intent`) + runs (status, duration, errorCode, videoPath) |
| `GET /panel/video?runId=…[&root=…][&download=1]` | `GET /api/record-replay/video?…` | video bytes; `Range`/`HEAD` supported |
| `GET /panel/search?q=…[&root=…][&limit=]` | `GET /api/record-replay/search?…` | with `root`: recordings/runs in one project; without `root` (or `root=*`): `{ groups: [{ projectRoot, projectName, matches }], total, returned, limit, truncated }` across all projects (default 100, max 500) |
| `GET /panel/stats` | `GET /api/record-replay/stats` | `{ system: { projects, recordings, runs, failedRuns, cancelledRuns, failureRate, videoFiles, videoBytes, steps }, projects: [{ root, name, stats }] }` |
| `GET /panel/active[?root=…]` | `GET /api/record-replay/active[?root=…]` | active recordings (`recording` status); with `root` only that project is scanned |
| `GET /panel/capabilities` | `GET /api/record-replay/capabilities` | `{ replay: boolean, trash: boolean, control?: boolean }` for the current process |
| `POST /panel/stop` | `POST /api/record-replay/stop` | `{ root, recordingId }` → `{ recordingId, status, endReason? }`; 503 `PANEL_CONTROL_UNAVAILABLE` without a control port |
| `POST /panel/discard` | `POST /api/record-replay/discard` | `{ root, recordingId }` → `{ recordingId, status: "cancelled", endReason: "cancelled" }`; 503 without a control port |
| `POST /panel/replay` | `POST /api/record-replay/replay` | `{ root, recordingId, values? }` → `{ runId }`; the Run continues in the background. 503 `PANEL_REPLAY_UNAVAILABLE` without a replay service; 409 `PANEL_REPLAY_FAILED` keeps the upstream code in the message |
| — (read-only) | `POST /api/record-replay/trash` | `{ root, recordingId }` → `{ recordingId, trashPath, movedAt, indexCleaned }`; moves the directory to `trash/<id>-<stamp>` and removes its index assignment |
| — (read-only) | `PATCH /api/record-replay/category?root=…` | `{ id, name }` → rename a category |
| — (read-only) | `PATCH /api/record-replay/scenario?root=…` | `{ id, name }` → rename a scenario |
| — (read-only) | `POST /api/record-replay/scenario?root=…` | `{ categoryId, name, includeUngrouped? }` → create a scenario; with `includeUngrouped`, collect that category's 未分组 recordings |
| — (read-only) | `PATCH /api/record-replay/recording?root=…` | `{ id, title?, scenarioId? }` → index-only title override and/or scenario move (`scenarioId: null` = 未分组) |

`.dsh/record-replay/index.json` (version 1: categories/scenarios/assignments)
is read when valid. When it is missing, corrupt or lacks a site's category, the
read path rebuilds categories in memory from each recording's first navigate
URL. An assignment may carry `intent` or `title` alone (no `scenarioId`), which
is how existing recordings get a use-case description or a display rename
without rewriting their manifests. A corrupt recording/run is skipped with a
warning, not allowed to break the rest of the project.

Writes exist only on the DSH mount (same-origin authenticated routes); the
standalone `panel` command deliberately stays read-only. Only `index.json` is
written — never a manifest or run file. Each write is a read-modify-write
serialized by a process-local queue and persisted through a same-directory temp
file + fsync + rename, so concurrent readers always see a complete JSON
document. Missing indexes are rebuilt from recording sites before writing;
partially corrupt v1 indexes keep every readable assignment; unparseable JSON
returns `PANEL_INDEX_CORRUPT` and writes nothing. Names are trimmed and limited
to 1–80 characters, ids must match the slug grammar, and unknown ids return
`PANEL_*_NOT_FOUND`.

The React client uses React 19, Tailwind CSS v4 + shadcn-style Radix primitives,
TanStack Query (server state), TanStack Virtual (long trees), Zustand (UI state)
and lucide-react icons. Panel tests:

```bash
pnpm exec vitest run tests/unit/panel
```

The DSH client half is a second Vite build (`pnpm build:ds-client`) that wraps
CJS output in `window.__ModuleLoader__.load` and inlines Tailwind CSS into the
factory; React is taken from DSH's frozen module table. It registers a
`sidebarRightTabs` page type plus its `sidebar.right.pane.tab` body and the
`sidebar.footer.action` entry. Adding or changing client code requires
refreshing the DSH window; **host-side changes (scanner/intent DTO, panel
search/stats/pagination routes, panel write routes, the M3 replay/trash routes
and the plugin's replay bridge) require restarting DSH**,
because the plugin module graph is cached. See
[`docs/design/record-replay-panel.md`](docs/design/record-replay-panel.md) §10,
§11 and §14 for the API research and verification record.

M1.6 covers project selection, the category → scenario (未分组) → recording
tree, Run list, intent display, lazy video playback with range requests, error
details, search and stats, mounted in the DSH right sidebar. The project
selector's default rule and folder picker are covered in
[`docs/design/record-replay-panel.md`](docs/design/record-replay-panel.md) §13
and the AX e2e record in
[`docs/spikes/2026-11-01-panel-ax-e2e/README.md`](docs/spikes/2026-11-01-panel-ax-e2e/README.md).
M2 adds the “全部项目” mode: cross-project search grouped by project, system
and per-project statistic cards, and `limit`/`offset` pagination for the
project and recording lists (infinite queries plus 加载更多; virtual scrolling
still handles long trees/result lists). See
[`docs/design/record-replay-panel.md`](docs/design/record-replay-panel.md) §14
for the scan limits, response shapes and test coverage.
M3-lite adds
double-click inline rename for categories/scenarios/recording titles (Enter
saves, Escape cancels, blur saves), the 未分组 “新建场景并收纳当前 N 条录制”
dialog, `invalidateQueries` refresh and an error-code toast. M3 adds replay,
move-to-trash and keyboard navigation (see the paragraph above); the replay
path was verified end-to-end against a real recording (new `run.json`,
`steps.jsonl`, 149 KB `video/replay.webm`). Still not covered: drag-and-drop
categorization, browsing the trash directory, and deep links — the DSH
right-sidebar mount has no address bar, so a `#root=…&recording=…` hash cannot
be restored there; the project/recording last-used state already survives via
localStorage.

## Test suites

`dsh-record-replay test <suite.json>` runs a JSON suite of recordings sequentially and reports a pass/fail line per case. Suite regression is a CLI/CI path only — there is no model-facing tool for it (see [CLI](#cli)):

```json
{
  "name": "desktop-smoke",
  "target": { "launch": "desktop", "pid": 42, "windowId": 7 },
  "baseUrl": "http://127.0.0.1:5000",
  "values": { "step_shared": "x" },
  "cases": [
    { "name": "open", "recordingId": "rec_xxx", "values": { "p": "y" } },
    { "name": "search", "recordingId": "rec_yyy", "baseUrl": "http://127.0.0.1:5001" }
  ]
}
```

- `target` / `baseUrl` / `values` can be set per suite, and overridden per case; case values win over suite values (same key);
- 明文凭据不要写进 suite：value 支持 `${ENV_VAR}`，从进程环境解析，缺变量直接报错；
- `target` / `baseUrl` can be overridden per run with `--launch` / `--pid` / `--window-id` / `--base-url` (needed for pids and ports that change between runs);
- each case is an independent replay run; one failure does not stop the rest;
- `timeoutMs` (positive integer) can be set per suite or per case; a case that exceeds
  it is cancelled and reported as `RUN_TIMEOUT` (the rest still run), so a hung page
  cannot block the whole suite;
- the report lists `status` / `runId` / `errorCode` per case.

## CLI

The package ships a standalone `dsh-record-replay` command for scheduled and CI runs. It does **not** load DSH or the plugin: it connects to the Cua daemon over MCP, uses the same recording store and replay port, and writes the same run/video layout under `.dsh/record-replay`.

```bash
pnpm build
node dist/cli.mjs test tests/suites/web-login.json \
  --launch isolated \
  --values step_3404b5e3658b4dd68763fd42923dc267=standard_user \
  --values step_4c6caa140dfd40a3bc97e2bc2af69a49=secret_sauce \
  --junit /tmp/web-login.xml
```

After `pnpm link --global` (or `npm install -g dsh-record-and-replay`) the same command is available as `dsh-record-replay` or `dsh-record-and-replay`:

```bash
dsh-record-replay test tests/suites/web-login.json --launch isolated --junit out/web-login.xml
```

Options:

| Flag | Meaning |
|---|---|
| `--junit <path>` | JUnit XML output path; defaults to `<suite>.junit.xml` next to the suite |
| `--base-url <url>` | override the suite `baseUrl` (case-level `baseUrl` still wins) |
| `--launch <mode>` | `isolated`, `existing` or `desktop`; required unless the suite/case already sets a target |
| `--pid <n>` / `--window-id <n>` | target for `existing` / `desktop`; required when that launch mode is used |
| `--values <id=value>` | replay input value keyed by `stepId` or `secretRef`; repeatable, wins over suite/case values |
| `--timeout <ms>` | per-case timeout budget; a timed-out case is cancelled and reported as `RUN_TIMEOUT` (default `120000`; `0` and negative values are rejected) |
| `-h`, `--help` | usage |

Behaviour:

- suite JSON is parsed with strict shape checks (`suite`/case `target`, `baseUrl`, `values`);
- target precedence: case → CLI override → suite; baseUrl precedence: case → CLI override → suite;
- cases run sequentially; a failure records `FAIL` and the next case still runs;
- timeout resolves as case `timeoutMs` → this `--timeout` → suite `timeoutMs` → `120000` ms; on expiry the CLI calls `cancelRun(runId)` and records `TIMEOUT` with `errorCode: RUN_TIMEOUT` (a budget failure, distinct from `ASSERTION_FAILED`), then continues with the next case and exits `1`;
- each line reports `PASS`/`FAIL`/`TIMEOUT`, `runId`, `errorCode`, duration and the error message;
- video is on by default (WebM) and lands in `runs/<runId>/video/replay.webm` under the recording's run directory;
- workspace = current directory; recordings and runs stay in `.dsh/record-replay`;
- the CLI uses the MCP transport only (`cua-driver >= 0.38.0` on `PATH`).

Exit codes:

| Code | Meaning |
|---|---|
| `0` | every case reached `completed` |
| `1` | at least one case failed (assertion, target, unsupported step, timeout, …) |
| `2` | usage, suite JSON, Cua connection or workspace assembly error |

Examples in the repo:

```bash
# passing: SauceDemo login recording, credentials supplied as replay values
node dist/cli.mjs test tests/suites/web-login.json --launch isolated

# intentional failure: the recording asserts example.com, but we replay it on saucedemo.com
node dist/cli.mjs test tests/suites/web-assert-fail.json --launch isolated --junit /tmp/fail.xml
```

For a nightly launchd job (including a failure-notification wrapper and Keychain-based credentials), see [`docs/guides/launchd.md`](docs/guides/launchd.md).

## Skill library

Completed recordings plus one successful replay run can be distilled into a reusable Skill (`SKILL.md`). Six host tools cover the lifecycle; write tools require `skill.enabled: true`, read tools stay available either way.

| Tool | Purpose | Key arguments |
|---|---|---|
| `cua_skill_generate` | Recording + successful Run → draft in `_drafts/` (never installs) | `recordingId`, optional `site`/`flow`/`mode` (`template` or `model`) |
| `cua_skill_review` | Read a draft: summary, ambiguities, provenance, pre-install validation | `draftId` |
| `cua_skill_install` | Install after human confirmation (`decision: "confirmed"`); anything else is zero-write | `draftId`, `decision`, optional `name` |
| `cua_skill_search` | Search the installed index by site/flow/triggers/free text | `site`, `flow`, `triggers`, `query` |
| `cua_skill_load` | Load full `SKILL.md` (active or explicit `version`) | `name`, optional `version` |
| `cua_skill_feedback` | Report one run outcome; `runId` is the idempotency key, failed runs mark `needs_review` | `runId`, `recordingId`, `skillName`, `result` |

Typical flow: `cua_skill_generate` → `cua_skill_review` → human confirms → `cua_skill_install` → later `cua_skill_search`/`cua_skill_load`, and `cua_skill_feedback` after each replay run.

`mode: "model"` asks the host model to enrich **Summary / Preconditions / Ambiguities** only:
the steps, semantic targets, inputs, verification and provenance stay deterministic.
The call uses the calling session's current provider/model through DSH's mounted `llm`
service (it never invents a route or reads credentials), asks for strict JSON, and
drops the enrichment when the reply is malformed, contains a plaintext secret, or
fails the pointer/coordinate check; the draft then falls back to the template and
records why in `ambiguities`. Without a model service or a resolved route the same
fallback applies. The five reference prompt ids are available in
`src/skill/drafting.ts` (`describe-activity`, `suggest-next-actions`, `draft-memory`,
`draft-replay-plan`, `create-replay-skill`). When the model returns a `memory` field, the
draft directory also gets `memory.md`; `cua_skill_review` returns it as `memory`.

Skill storage:

- Drafts: `.dsh/skill-library/_drafts/<draftId>/`
  - `SKILL.md` and `draft.json`
  - `memory.md` when `mode: "model"` produced a compact memory
- Installed: `.dsh/skill-library/skills/<site>/<flow>/SKILL.md` with immutable copies under `versions/v<N>/`
- Published for DSH: after install, the same body is copied to `<workspace>/.dsh/skills/<name>/SKILL.md` with a `description` and a "How to run" section, so DSH's own skill catalog can load it (`.dsh/skill-library` stays authoritative)

Secrets never enter a Skill: redacted `setValue` values are kept as parameter names/placeholders, and plaintext secrets, redaction masks, or coordinate-only steps are rejected at generation/install time. Replay input `values` stay process-only — they are never written to the Run, the draft, or the installed Skill.

## Replay input values

Redacted `setValue` steps can be replayed by passing process-only values keyed by `stepId` or `secretRef`:

```json
{
  "recordingId": "rec_...",
  "pid": 12345,
  "windowId": 678,
  "values": { "step_...": "Alice" }
}
```

Values are used in memory only and are never written to the Run.

## Storage

- Recordings: `.dsh/record-replay/recordings/<recordingId>/`
  - `manifest.json`, `steps.jsonl`
  - `suppressed.jsonl` (only when the URL policy suppressed steps)
  - `assets/`, `runs/`
- Replay runs: `.dsh/record-replay/recordings/<recordingId>/runs/<runId>/`
  - `run.json`
  - `steps.jsonl`
  - `evidence/`

## Requirements

- DSH `>=0.2.1-rc.5 <0.3.0`
- Node.js `>=22`
- Web recording/replay: macOS or Windows
- Desktop automation: macOS only (`launch: "desktop"` and `record-replay-desktop` remain disabled on other platforms)
- `native` transport: `@trycua/cua-driver` `0.28.0` (installed as a dependency; per-platform binaries come from its optional dependencies)
- `mcp` transport: `cua-driver` `>=0.38.0` on `PATH`, with the daemon already authorized for existing-profile access
- Optional Docker backend: a Docker daemon with native `linux/amd64` or `linux/arm64` container support
- The macOS DSH app needs Accessibility and Screen Recording grants; Windows replay video additionally needs ffmpeg, and degrades to no-video when ffmpeg is unavailable

## Current limitations

- The panel is a read-only browser over the same store; host-side writes only touch index.json.
- Secrets are redacted before persistence; plaintext remains in process memory only.
- The native runtime lives in a child process, so a Cua crash cannot terminate DSH; the affected binding is invalidated and the next bind can fall back to MCP.
- Native existing-profile approval is scoped to the in-flight bind: exactly the requested `pid` + `window_id` (60s TTL), every other authorization boundary is denied.
- MCP daemon start/authorization is an operator prerequisite; the plugin does not auto-start it.
- A native browser bubble — for example Chrome's password-manager "change your password" warning after a breached credential — floats over the page and swallows trusted CDP mouse input. Cua still answers `clicked (x, y)` while the page receives no pointer events at all. The click verification above recovers by re-dispatching as a synthetic DOM click; a control that rejects untrusted events (some file pickers and security prompts) cannot be driven while such a bubble is open. Options are to dismiss the bubble or to use a profile where the password manager is silent.
- Click verification compares the semantic snapshot, so a click whose only effect is outside it (canvas, audio, an invisible network request) can be retried once as a synthetic DOM click. Recordings that must not repeat such a click should assert the outcome right after it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, test
commands and PR checklist. Public-boundary checks run in CI:

```bash
pnpm check:boundary
```

For a public release, also run `pnpm check:history` and follow
[`docs/guides/public-release.md`](docs/guides/public-release.md); the working
tree is sanitized but old commits still need a history rewrite.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md)
for private reporting, the Cua permission model and recording-data guidance.

## License

MIT — see [LICENSE](LICENSE).
