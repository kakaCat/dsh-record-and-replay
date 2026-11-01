# Contributing

Thanks for helping with `dsh-record-replay`. This plugin records and replays
Cua-driven browser/desktop actions inside DeepSeek Harness (DSH), so most
changes need to stay testable without a live browser.

## Development setup

Requirements:

- macOS (the Cua driver and AX capture are macOS-only)
- Node.js >= 22
- pnpm 10
- For live recording: `cua-driver` >= 0.38 on `PATH`, plus macOS Accessibility
  and Screen Recording grants for DSH

```bash
pnpm install
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm build
node scripts/check-public-boundary.mjs
```

The opt-in browser E2E runs a local fixture server and Chromium:

```bash
pnpm exec playwright install chromium
pnpm test:activity
```

Live Cua tests are opt-in (`CUA_E2E=1`); they need a real driver and are not
part of the default suite.

## What to send in a PR

- A focused change with tests; update the README or `docs/analysis/` when
  behaviour or known gaps change.
- No real recordings, `.dsh/` data, cookies, credentials, or personal absolute
  paths. `scripts/check-public-boundary.mjs` must pass.
- A short note on verification commands and any manual macOS permission steps.
- Keep the public boundary: panels and routes must not add absolute paths,
  Cua handles, or secrets to DTOs/logs.

## Commit messages

Use a short imperative subject with an optional scope, for example
`fix(panel): keep the selected run when refreshing`. Squash work-in-progress
commits before opening a PR.

## Publishing a release

Before making the repository public, follow
[`docs/guides/public-release.md`](docs/guides/public-release.md): the working
tree is sanitized, but old commits still contain pre-sanitization paths,
usernames, and screenshots. `pnpm check:history` lists them.

## Reporting a security issue

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
