# Mistakes Ledger

Every mistake gets a row with the mechanical prevention that stops it recurring. (Pattern: oyatie.)

| ID | Date | Mistake | System gap | Mechanical prevention | Shipped |
|----|------|---------|-----------|----------------------|---------|
| MFL-0001 | 2026-06-12 | Merge commit fd0291c contained unresolved conflict markers in backend/Cargo.toml (chained shell `git add`+`commit` raced an Edit-tool fix; a second conflict hunk went unnoticed) | No conflict-marker check before commit; multi-step git ops chained with code edits in one shell pipeline | Amended clean (908dac2). Follow-up: add conflict-marker scan (`<<<<<<<|>>>>>>>` in tracked files) to mnt-gate-layer-boundary manifest-hygiene pass; rule: never chain `git commit` after file edits in the same pipeline — verify `grep -c "<<<<<<<"` = 0 first | 2026-06-12 (CONFLICT_MARKER check in mnt-gate-layer-boundary, 3 tests incl. real-repo scan) |
| MFL-0002 | 2026-06-12 | Passkey ceremony HTTP endpoints owned by no task: T0.5 shipped crate-level ceremonies, T1.3 scoped to workorder routes — web slice (T1.5) found no auth routes in the contract | Plan decomposition seam: cross-cutting REST surface lacked an owning task | T1.5 brief's contract guard (stop-don't-invent) caught it pre-code; T1.3b dispatched; rule: every platform crate consumed by clients must have an explicit REST-exposure task in the milestone | 2026-06-12 |
