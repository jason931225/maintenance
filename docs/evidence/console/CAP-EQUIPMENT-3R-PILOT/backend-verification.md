# CAP-EQUIPMENT-3R-PILOT — Stage-3 adversarial backend verification

Fresh-eyes verification of the stage-2 build (commits `e8a636a7..336d9ca5`), performed
without trusting the build report. One real defect was found, proven red-green, and
fixed (`cb978564`). Everything below was re-run on the fixed tree.

## Verdict

GO for consolidation, with the pre-existing integrator open items unchanged
(route registration, 0185 renumbering, authz-manifest reconciliation).

## 1. RLS

- Migration `0185_create_equipment_3r.sql` applies `ENABLE` + `FORCE ROW LEVEL SECURITY`
  and an `org_isolation` USING/WITH CHECK policy (`app.current_org`, `NULLIF` fail-closed)
  to all six tables via one loop; `mnt_rt` gets SELECT/INSERT/UPDATE only (no DELETE);
  `enforce_org_id_immutable()` is attached to every table.
- The integration suite drives the assembled `build_router` over a pool whose
  `after_connect` runs `SET ROLE mnt_rt`; the router never sees the admin pool.
  RLS applies to the current role's attributes, so this is the runtime posture.
- Cross-tenant isolation proven as `mnt_rt`: a fully-granted second-org principal gets
  404 on first-org unit detail and case approval, and — added this stage — an
  org-wide second-org observer receives **empty** unit and case lists
  (count-leak-free), which doubles as the BYPASSRLS canary: a bypassing role would
  have returned first-org rows and failed the assertion.

## 2. Authorization (deny-by-default)

- Every route resolves the principal and checks a distinct `equipment_3r_*` feature;
  transition routes authorize inside the transaction against the branch read from the
  locked row (no client-supplied branch on transitions).
- Proven denials: ungranted user 403; grant cannot widen JWT branch scope 403;
  four-eyes self-approval 403; branch-scoped principal denied the org-wide list 403;
  denied approval does not transition the case (DB readback).
- Concealment: cross-org objects are 404 via RLS. Within-org 403-for-existing vs
  404-for-missing is the explicit design-contract decision (contract §"Codes/status").
- **Defect found and fixed**: `POST /units` with an org-wide (BranchScope::All)
  principal skipped the JWT branch-scope check for any `branchId`, so a cross-org or
  nonexistent branch hit the `(branch_id, org_id)` FK and returned
  `500 {"error":{"code":"internal"}}`. Red run captured the 500; the store now
  validates branch existence under the armed org in-transaction → concealed 404
  (`cb978564`).

## 3. Audit + history

- All mutations run through `with_audits` (audit rows commit atomically with the
  FSM write); `with_org_conn`/`with_audits` arm the transaction-local
  `app.current_org` GUC (crates/platform/db/src/audit_tx.rs).
- Readback asserted in-suite: 8 audit events on the case (quote, approval, dispatch,
  handover, 2 inspections, return, assess), 1 on the unit, 1 on the disposition;
  14 history rows across unit/case/disposition; history table is trigger-enforced
  append-only.

## 4. Rejected-sibling correctness classes

- Repeated-query parsing: N/A — no `Query` extractor exists in the crate (grep-clean).
- Error envelope: every error path emits the canonical
  `{"error":{"code","message"}}` shape used by the logistics/production siblings;
  DB-side errors are mapped to generic messages (no SQL or constraint leakage).
- N+1: `list_units`/`list_cases` are single bounded queries (LIMIT 200);
  `case_detail` is 2 queries (case+joins, inspections); `unit_detail` is 1.
- Terminal-state races: every transition locks its row `FOR UPDATE` and applies a
  status-guarded CAS UPDATE with `rows_affected != 1 → 409`; concurrent approval race
  proven single-winner (one 200, one 409, unit reserved exactly once); completed
  disposition and SOLD unit re-mutation proven 409; DB triggers back-stop terminal
  immutability.

## 5. Idempotency

- Replay of the same `Idempotency-Key` + fingerprint returns the stored case
  (`200`, `replayed: true`, same id — no duplicate mutation); same key with a changed
  body returns 409. Proven in-suite. Keys are org-scoped
  (`UNIQUE (org_id, idempotency_key)`); a concurrent first-use race resolves via the
  unique index to one 201 and one 409, and the 409 client's retry replays — convergent.

## 6. Placeholder sweep

`TODO|FIXME|unimplemented!|todo!()|.skip|#[ignore]|dbg!` over
`backend/crates/equipment/**` and the test: zero hits.

## Commands (final tree)

| Command | Result |
| --- | --- |
| `cargo fmt --check -p mnt-equipment-{domain,application,adapter-postgres,rest}` + `rustfmt --check` on the test | clean |
| `cargo clippy -p` (same 4 crates) `-- -D warnings` | clean |
| `cargo test -p mnt-equipment-domain` | 7 passed, 0 failed |
| `DATABASE_URL=…55432/mnt_dev cargo test -p mnt-app --test equipment_3r_api` | 4 passed, 0 failed (as `mnt_rt`, sqlx per-test scratch DBs) |

Red-green evidence for the fix: pre-fix run failed
`cross-org branch must be concealed on register` with
`left: 500, right: 404` and body `{"error":{"code":"internal","message":"internal server error"}}`.

## Residual observations (not blockers)

- Concurrent same-key quote creation yields 201/409 rather than 201/200-replay;
  retry converges to the stored outcome. Acceptable for the pilot contract.
- Unit history entries within one transaction share `occurred_at`; ordering among
  them is by random UUID tiebreak. Counts, not intra-transaction order, are asserted.
- Integrator open items from stage 2 stand: CONFIGURED_ROUTE_SURFACES/openapi
  registration from `manifests/`, 0185 provisional slot renumbering, and the
  authz Feature variants applied on-spine by `e8a636a7`.
