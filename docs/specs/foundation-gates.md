# Foundation Gates — W1A0/W1I/W1UX

FOUNDATION-GATE-READY: true

Generated: 2026-06-29T09:14Z

This document is the durable G002 gate contract. W1A-W1H must not start until this gate passes locally and in CI. The gate exists to prevent the next implementation lanes from widening scope, bypassing policy/audit/passkey constraints, or treating UI/security/release requirements as optional.

## Entry evidence

- Canonical backlog ledger: `docs/specs/backlog-clearance-ledger.md`
- Automated gate: `npm run check:foundation-gates`
- CI enforcement: `.github/workflows/ci.yml` runs `npm run check:foundation-gates` and watches `docs/specs/**`.
- Team launch path: `omx team 6:executor "<task>"` is supported by the installed `omx team [N:agent-type]` syntax and `~/.codex/agents/executor.toml` metadata. The G002 gate verifies syntax/metadata only; a durable tmux team should be launched only when a later implementation lane is ready to own worktrees and PRs.

## Gate A — policy/audit/passkey contract baseline

Required before W1A-W1H:

1. Backend mutation boundaries keep the existing CI gates green:
   - `mnt-gate-layer-boundary`
   - `mnt-gate-audit-coverage`
   - `mnt-gate-migration-safety`
   - `mnt-gate-tenant-isolation`
   - `mnt-gate-pii-no-logs`
   - `mnt-gate-rls-arming`
2. Sensitive object actions, policy assignment, custom-role changes, account lifecycle transitions, and any signing-equivalent approval must require fresh passkey step-up and produce append-only audit evidence.
3. OTP/cold-start setup is only a bootstrap path. It must not grant mature account status until passkey setup and required Korean privacy/service agreements are complete.
4. Approval feeds and Work Hub feeds must be server-owned, authorization-checked, tenant/RLS-scoped, and branch/group/org aware; browser composition cannot be the security boundary.
5. PII, payroll, location, HR, and legal-ownership data must be masked/minimized by default and never copied into routine audit text or GitHub-facing docs.

## Gate B — CI/CD/security/release baseline

Required before W1A-W1H:

1. CI must keep Rust fmt, clippy `-D warnings`, tests, OpenAPI contract, generated client drift, TypeScript, Kotlin, web lint/test/build, browser e2e, Android, and iOS gates intact.
2. Security workflow must keep Trivy filesystem/secret/IaC scans, cargo audit, cargo deny, and npm audit high/critical gates intact.
3. Image release must wait for CI, build immutable digests, run blocking Trivy image scan, sign with cosign, attest provenance/SBOM, and auto-bump GitOps overlays.
4. Release Please must use `RELEASE_PLEASE_TOKEN` when recursive release PR/tag automation is required; default `GITHUB_TOKEN` is not sufficient when repository settings disallow PR creation or recursive workflow triggering.
5. Rust is pinned to 1.96.0 for CI/local parity.
6. OCI/free-tier, backup/restore, KMS/secrets, Argo, and observability hardening remain W1I implementation work; this G002 gate only proves the baseline and the follow-on evidence columns.

## Gate C — UI shell/design/i18n/a11y baseline

Required before W1A-W1H:

1. User-facing work must use the existing authenticated shell, role-aware navigation, and page-header conventions.
2. Browser e2e for critical user stories must include console-error guards, zero critical/serious axe violations, and no raw i18n key leakage.
3. Web lint must keep the UI string gate. Cross-surface i18n checks must remain available through `scripts/check-i18n.mjs`.
4. Enterprise UX work must cite the parity matrix and benchmark gaps. It must replace text walls with actionable state, scope, priority, evidence, and next-action affordances.
5. Loading, empty, error, disabled, and permission-denied states are required UI states, not optional polish.

## Downstream lane contract

Every later lane must cite both the backlog ledger row and this foundation gate, then provide its own RED/GREEN evidence and PR/review/fix/merge/rollout proof. If `npm run check:foundation-gates` fails, domain work stops until this gate is restored.
