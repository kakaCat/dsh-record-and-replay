# Changelog

## Unreleased

### Added

- Windows Web platform adaptation: replay video uses ffmpeg `gdigrab` with a
  `desktop` input, daemon recovery understands Windows executable names, and CI
  runs the focused Web-platform test set plus build on `windows-latest`.

### Changed

- Replay video finalization no longer depends on POSIX signals: ffmpeg receives
  the standard `q` command through stdin on all supported platforms.
- Desktop automation remains macOS-only. Desktop bindings fail fast before any
  Cua call on other platforms, and the `record-replay-desktop` plugin line does
  not register its tools there.

- The eight `cua_desktop_*` tools moved out of the main plugin into their own
  bundle line `record-replay-desktop` (`dsh-record-replay/desktop`), inserted by
  the same `cordis.patch.yml` and **disabled by default** — one bundle, two lines,
  one toggle per line on the DSH plugin page (same pattern as `dsh-window`). While
  the line is off, its `apply` never runs and the tools are absent from the model
  surface entirely; both lines share the same workspace runtimes and Cua transport
  through `plugin/shared.ts`. The default model-facing surface drops from 28 to 19
  tools; enable the line to reach 27.
- Tools that could only answer `FEATURE_DISABLED` are no longer registered when their
  switch is off: `recording.enabled: false` drops `cua_record_start` /
  `cua_record_bind_browser` / `cua_record_observe` / `cua_record_action` (finishing and
  read tools stay), `replay.enabled: false` drops `cua_replay_start` (cancel stays), and
  `skill.enabled: false` drops the write tools `cua_skill_generate` /
  `cua_skill_install` / `cua_skill_feedback` (review/search/load stay). Handlers inside
  the host tool factory still answer `FEATURE_DISABLED` for direct embedders, and
  `cua_record_replay_status` lists the skipped names under `disabledTools`.

### Removed

- `cua_test_run` is gone from the model tool surface. Suite regression is a CLI/CI
  path (`dsh-record-replay test`, same parser, runner, JUnit output and flags), and
  the tool only cost context the model rarely used. Calls that used `cua_test_run`
  should run the CLI instead.

## 0.0.3 — 2026-11-01

### Changed

- npm package renamed to `dsh-record-and-replay` because `dsh-record-replay` is owned by
  another project. The DSH plugin id and the `dsh-record-replay` CLI name are unchanged;
  the CLI now also answers to `dsh-record-and-replay`.

## 0.0.2 — 2026-11-01

### Added

- Portable session export: `cua_record_export` writes `session.json`,
  `events.jsonl` (`session.started` / `agent.action` / `session.ended`) and
  `suppressed.jsonl` into a workspace-relative directory.
- Live recording HUD in the left-sidebar footer: elapsed time, step tooltip,
  Stop and two-step Discard; host `GET /active`, `POST /stop`, `POST /discard`.
- Recording lifecycle controls: `recording.maxDurationSeconds` auto-stop with
  `endReason`, `cancelled` terminal status, `cua_record_discard`, and startup
  `recoverStore`.
- Recording consent metadata (`recording.consent`) with an optional explicit
  gate.
- Privacy suppression: URL deny patterns, private-window binding refusal,
  `suppressed.jsonl` / `suppressedCount`, and extra secret redaction patterns.
- Optional model-assisted Skill drafting (`cua_skill_generate mode: "model"`)
  with strict JSON parsing, `memory.md` companion output, and template fallback.
- Open-source readiness: MIT LICENSE, contribution/security/conduct docs,
  issue/PR templates, public-boundary check, package metadata.
- CI now runs the activity-view Playwright suite on every push/PR.

### Fixed

- Startup recovery now repairs a crashed `recording` entry instead of leaving it
  unrecoverable.
- Panel/meta documentation no longer claims the UI is a static fixture.

## 0.0.1 — 2026-10-30

- Initial Cua-only browser record/replay baseline: recording store, semantic
  replay, panel, skill library, suite runner, and CLI.
