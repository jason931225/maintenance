# Console Buck2 scale playbook

**Status:** implementation policy for the console train. It reconciles the
historical Buck2 CI charter in `console-program-ledger.md` with the current
roadmap: Rust completion evidence is Buck2-only; Cargo remains manifest and
dependency metadata, not a product verification substitute.

## Pin and upgrade discipline

- The repository tool is `./tools/buck2`, an official dotslash manifest pinned
  to the [Buck2 2026-07-15 release](https://github.com/facebook/buck2/releases/tag/2026-07-15).
  Scripts must use it by default, never a developer-global binary.
- Every platform entry retains its exact BLAKE3 digest. Build containers, test
  fixtures, and remote execution images likewise use immutable digests.
- A version upgrade is a small, separate change: update the official manifest,
  run the cheap preflight, then run a canary build/test matrix before changing
  the CI pin. The previous pin remains the rollback point until the canary is
  green.

## Boundaries and graph shape

Cells are trust, toolchain, and configuration boundaries—not ordinary module
directories. The current root, toolchain, bundled-prelude, and empty alias
cells are deliberate. **No per-module cells:** console modules are Buck
packages and targets inside the root cell, with cell splits only when a
separate trust domain, toolchain, or configuration boundary is proven.

- Use cell-relative labels and `buck2 audit cell` to make every boundary
  visible.
- Keep first-party Rust targets generated from the current manifest and retain
  a no-write generator-drift check. Reindeer owns third-party graph generation.
- Keep source/resource ownership explicit in target inputs; do not hide native
  web, Android, or iOS failures behind generic Buck wrappers.

## Test taxonomy and concurrency

Targets carry intent labels: `unit` for deterministic in-process behavior,
`integration` for application seams, `needs-postgres` for disposable database
stories, and later `e2e` plus resource-class labels for browser/mobile suites.
Pure unit targets remain separate from HTTP, RLS/PBAC, migration, audit, and
concurrency integration stories. The batched hermetic runner excludes
`needs-postgres`; the PostgreSQL runner provisions an isolated database and
uses a stable worktree-specific Buck isolation directory.

Cheap gates run before compilation: pinned-manifest integrity, `audit cell`,
target enumeration, and generator drift. Isolated target groups may run in
parallel only when their mutable services and artifacts are independent.

## Scale roadmap

1. Use configurations and modifiers for debug/release/sanitizer selection;
   use transitions only where a dependency must always build in a different
   configuration.
2. Define local macOS and Linux execution platforms with hermetic exact-SHA
   tools/images. Add remote action cache/execution through a compatible RE API
   only after a measured canary proves parity and cache correctness.
3. Add BXL for affected-target calculation, ownership/graph audits, and test
   planning. Combine it with Buck2’s change detector so CI schedules the
   smallest safe target set, while release candidates retain the full matrix.
4. Export build reports and cache metrics; promote a remote-execution rollout
   only after reproducibility, authorization, artifact provenance, and
   rollback evidence are independently verified.

Primary references: [cells and key concepts](https://buck2.build/docs/concepts/key_concepts/),
[configurations](https://buck2.build/docs/concepts/configurations/),
[modifiers](https://buck2.build/docs/concepts/modifiers/),
[BXL](https://buck2.build/docs/users/commands/bxl/),
[remote execution](https://buck2.build/docs/users/remote_execution/), and
[test labels](https://buck2.build/docs/users/commands/test/).
