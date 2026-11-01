## Summary

Describe the change and the user-visible effect.

## Verification

- [ ] `pnpm exec tsc --noEmit`
- [ ] `pnpm exec vitest run`
- [ ] `pnpm build`
- [ ] `node scripts/check-public-boundary.mjs`
- [ ] Opt-in live/E2E check (if applicable): command and result

## Checklist

- [ ] Tests cover the new behavior or the fixed regression.
- [ ] No raw recordings, `.dsh/` data, cookies, credentials, or personal paths.
- [ ] README / docs updated for user-facing behavior or known gaps.
- [ ] Panel/Host DTOs still contain no absolute paths or runtime handles.
