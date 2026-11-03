# Security policy

## Supported versions

Security fixes are applied to the latest published `0.x` release. This project
is pre-1.0; breaking changes may ship in a minor release.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Advisories)
for the repository. Do not attach raw recordings, browser profiles, cookies,
credentials, or logs containing personal data. If private reporting is not
available, contact the maintainers through the repository owner's public
profile before disclosing details.

## Security model and operational notes

- Recordings and runs are local files under the workspace `.dsh/` directory.
  They can contain URLs, page-derived names, and timestamps even after the
  redaction pipeline; treat the workspace as sensitive.
- `setValue` values are masked before persistence; replay input values are
  process-only. Do not put credentials in suite files — use `${ENV_VAR}`.
- The panel is same-origin authenticated. Its stop/discard routes derive the
  recording owner from the manifest and never accept a caller-supplied owner.
- Cua/MCP daemon access and macOS Accessibility/Screen Recording grants are
  operator prerequisites for live recording. Review what the driver can see before enabling
  `launch: "existing"` on a personal browser profile.
- `recording.privacy.deniedUrlPatterns` and `blockPrivateBrowsing` are
  best-effort guards, not a full data-loss-prevention system. The URL policy
  only sees URLs that appear in recorded actions.
