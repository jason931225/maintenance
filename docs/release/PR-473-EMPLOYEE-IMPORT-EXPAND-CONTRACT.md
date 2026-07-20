# PR 473 Employee-Import Expand Contract

<!-- PR473-MIGRATION-GATE: release_phase=expand -->
<!-- PR473-MIGRATION-GATE: deployment_authorized=false -->
<!-- PR473-MIGRATION-GATE: command_only_claim_authorized=false -->
<!-- PR473-MIGRATION-GATE: production_authority=production_cardinality,old_runtime_drain,rollback_floor_raise -->

## Status

PR 473 is the **expand** release of a two-release employee-import cutover. It is
not the command-only contract release, and merging it does not authorize a
deployment.

Migration `0166_leave_exact_charge_and_home_branch.sql` adds the
`leave_api` command capability, replay receipts, intrinsic command audit, exact
leave-charge evidence, and home-branch routing. The PR 473 binary uses that new
command path and does not fall back to legacy raw-table writes.

## Mixed-version and rollback requirement

The rollback floor before PR 473 is commit
`f6ff236b9770c79301a3d07da6afb56be1e27bbf`. Migration 0166 can therefore be
present while an f6ff236 replica is still serving, and an application rollback
can deliberately restore that binary against the migrated database.

During that window, 0166 preserves the exact legacy employee-import surfaces:

- immediate employee import `INSERT ... ON CONFLICT DO UPDATE`, including
  `leave_accrued`, `leave_used`, and `leave_remaining`;
- staged employee-import `DRY_RUN -> APPLIED` metadata publication; and
- the same-transaction `data_import.apply` audit event written by `with_audit`.

The additive `home_branch_id` authority, `leave_api` command functions,
`leave_balance_import_receipts`, and exact-charge state remain unavailable to
the legacy runtime path.

## Explicit residual security window

The f6ff236 employee upsert carries no command token, run identifier, or other
trustworthy database marker. Its immediate endpoint also has no staged import
run or audit envelope. PostgreSQL therefore cannot distinguish an authentic
f6ff236 balance upsert from another `mnt_rt` balance upsert without either
breaking rollback or trusting caller-controlled data.

For the expand window, `mnt_rt` consequently retains its pre-0166 ability to
write the three employee leave-balance columns. This is known compatibility
exposure, not completed command-only enforcement. The migration keeps new
home-branch authority command-only and narrows the legacy APPLIED/audit bridge
to the f6ff236 transaction shape where the old SQL provides a reliable anchor.

That bridge does **not** prove that the legacy HTTP endpoint authorized the
operation. The f6ff236 SQL carries no unforgeable endpoint-authorization fact,
so PostgreSQL cannot reconstruct one. What the bridge does prove is narrower:

- the actor is active and belongs to the run tenant;
- the audit has the exact f6ff236 null context/classification fields and exact
  passing self-checklist `after_snap` envelope;
- the run and audit agree on tenant, actor, action, target type, and target ID;
- the run transition and audit row were created by the same PostgreSQL
  transaction; and
- exactly one matching audit exists when the transaction commits.

The real-PostgreSQL regressions reject and roll back a staged apply when its
audit is missing or duplicated, when the snapshot is missing, has extra fields,
forges the gate result, or omits a gate, when legacy-null classification context
is populated, when the actor is inactive or belongs to another tenant, and when
a previously committed audit is replayed in a later transaction. Employee
balances and APPLIED metadata remain atomic with those checks: an invalid proof
leaves both unchanged.

## Contract release gate

A later, separately numbered migration must remove the legacy `mnt_rt`
employee-balance, APPLIED-transition, and `data_import.apply` bridges. That
migration may ship only after all of the following are evidenced:

1. PR 473 or a later compatible binary is deployed everywhere.
2. PR 473 is the declared and tested rollback floor; f6ff236 rollback is no
   longer supported.
3. Staged imports created by old binaries are drained or explicitly superseded.
4. Upgrade and rollback exercises prove no supported binary uses the raw-table
   employee-import path.
5. The contract migration has real `mnt_rt` negative tests proving the legacy
   balance, APPLIED, and audit paths are closed while `leave_api` imports pass.

Until that numbered contract migration lands and its rollout gates pass, no
artifact or release note may claim that employee leave-balance writes are
command-only.

## Regression evidence

### Pre-merge synthetic rehearsal boundary

The pre-merge synthetic rehearsal executes the exact 0166 migration against
populated pre-0166 PostgreSQL fixtures as the non-superuser migration role. It
sets and reads back bounded `lock_timeout = 5s` and `statement_timeout = 60s`
budgets in the migration transaction, then proves the populated legacy rows and
new command surfaces remain coherent. This is deterministic pre-merge evidence;
it is not production cardinality, deployment, rollout, or rollback evidence.

The following are **production-authority-only** gates: production cardinality
measurement, old-replica and staged-work drain, and rollback-floor declaration
and verification. They require an authorized rollout window and live production
evidence. PR merge and the synthetic rehearsal satisfy none of them and do not
authorize deployment.

`backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs`
contains populated upgrade regressions for both supported f6ff236 modes:

- `immediate_f6ff_employee_import_remains_usable_after_0166`
- `staged_f6ff_employee_import_apply_remains_atomic_after_0166`
- `staged_f6ff_apply_rejects_missing_duplicate_or_forged_current_tx_audit`
- `legacy_leave_mutations_require_exactly_one_same_transaction_audit`
- `staged_employee_import_rejects_payload_not_equal_to_immutable_ledger`
- `migration_0166_rehearses_populated_expand_with_bounded_lock_and_statement_timeouts`
- `exact_charge_create_accepts_resolved_and_review_required_shapes`
- `exact_charge_create_atomically_rejects_mismatched_reason_and_evidence_shapes`

The tests run against PostgreSQL with the real `mnt_rt` role and the exact 0166
migration text. They prove compatibility, exactly-one same-transaction audit
correlation, immutable-ledger payload binding, the two valid exact-charge create
shapes, atomic rejection of mixed reason/evidence shapes, and bounded synthetic
migration execution. They prove neither legacy endpoint authorization nor that
the later contract phase has occurred.
