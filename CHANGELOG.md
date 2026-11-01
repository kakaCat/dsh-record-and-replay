# Changelog

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
  with strict JSON parsing and template fallback.
- Open-source readiness: MIT LICENSE, contribution/security/conduct docs,
  issue/PR templates, public-boundary check, package metadata.

### Fixed

- Startup recovery now repairs a crashed `recording` entry instead of leaving it
  unrecoverable.
- Panel/meta documentation no longer claims the UI is a static fixture.

## 0.0.1 — 2026-10-30

- Initial Cua-only browser record/replay baseline: recording store, semantic
  replay, panel, skill library, suite runner, and CLI.
