# PR 473 Ontology Expand Contract

<!-- PR473-MIGRATION-GATE: release_phase=expand -->
<!-- PR473-MIGRATION-GATE: deployment_authorized=false -->
<!-- PR473-MIGRATION-GATE: command_only_claim_authorized=false -->
<!-- PR473-MIGRATION-GATE: production_authority=production_cardinality,old_runtime_drain,rollback_floor_raise -->

## Status

PR 473 is the **expand** release of a two-release ontology-write cutover. It is
not the command-only contract release, and merging it does not authorize a
deployment.

Migration `0165_ontology_object_type_key_revisions.sql` adds the
`ontology_api` command capability, a tenant/key-scoped CAS sidecar, intrinsic
command audit enforcement, and the immutable built-in catalog install path.
The PR 473 binary writes through the new command entrypoints and does not fall
back to the legacy raw-table path.

## Mixed-version and rollback requirement

The rollback floor before PR 473 is commit
`f6ff236b9770c79301a3d07da6afb56be1e27bbf`. Migration 0165 can therefore be
present while a pre-0165 replica is still serving, and an application rollback
can deliberately restore that binary against the migrated database.

During that window, 0165 preserves only the old runtime transaction shapes:

- parent `ont_object_types` insert for create/stage;
- lifecycle-only parent update for transition;
- append-only `ont_property_defs`, `ont_link_types`, `ont_action_types`, and
  `ont_analytics` child inserts; and
- exactly one matching `ontology.object_type.*` audit row from the same
  PostgreSQL transaction.

The migration denies legacy content updates, child updates/deletes/truncates,
direct sidecar writes, built-in installation, and access to the new
`ontology_api` routines. The compatibility trigger owns the one-and-only CAS
sidecar advance for legacy stage/transition transactions.

## Explicit residual security window

For the expand window, `mnt_rt` retains narrowly guarded `INSERT`/`UPDATE`
privileges on the legacy ontology tables. This is compatibility exposure, not
completed command-only enforcement. The database verifies tenant context,
active actor, exact allowed mutation shape, same-transaction row identity,
exactly one correlated audit fact, and atomic CAS-sidecar advancement.

The bridge does **not** prove which HTTP handler authorized the old write. A
pre-0165 SQL transaction carries no unforgeable command credential or endpoint
identity, so PostgreSQL cannot reconstruct that fact without breaking the
supported rollback. New commands use the dedicated `mnt_ontology_cmd` login
and writer-owned `SECURITY DEFINER` entrypoints; the legacy runtime cannot call
those entrypoints or impersonate their owner.

## Contract release gate

A later, separately numbered migration must remove the legacy `mnt_rt`
ontology DML grants, compatibility triggers, and legacy-audit bridge. That
migration may ship only after all of the following are evidenced:

1. PR 473 or a later compatible binary is deployed on every serving replica.
2. That binary is the declared and tested rollback floor; rollback to f6ff236
   or any other pre-0165 binary is no longer supported.
3. All pre-0165 replicas and jobs are drained, and a readback proves none remain.
4. Mixed-version upgrade and rollback exercises prove the expand window before
   the rollback floor is raised.
5. The contract migration has real-`mnt_rt` negative tests proving parent,
   child, and protected-audit legacy writes are closed.
6. Positive tests prove all supported create, stage, transition, and built-in
   install operations still pass through `ontology_api` with audit and CAS
   invariants intact.
7. A rollback rehearsal from the proposed contract release either succeeds to
   the new floor or documents an approved irreversible database boundary.

Until that numbered contract migration lands and its rollout gates pass, no
artifact or release note may claim ontology writes are command-only.

## Regression evidence and limits

### Pre-merge synthetic rehearsal boundary

The pre-merge synthetic rehearsal executes the exact 0165 migration against
populated pre-0165 PostgreSQL fixtures as the non-superuser migration role. It
sets and reads back bounded `lock_timeout = 5s` and `statement_timeout = 60s`
budgets in the migration transaction, then proves the expected tenant/key
sidecar cardinality. This is deterministic pre-merge evidence; it is not
production cardinality, deployment, rollout, or rollback evidence.

The following are **production-authority-only** gates: production cardinality
measurement, old-replica and job drain, and rollback-floor declaration and
verification. They require an authorized rollout window and live production
evidence. PR merge and the synthetic rehearsal satisfy none of them and do not
authorize deployment.

`backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs`
contains the populated upgrade and compatibility regressions:

- `migration_0165_upgrades_legacy_sibling_versions_without_tenant_leakage`
- `migration_0165_keeps_exact_old_binary_writes_audited_and_cas_consistent`
- `migration_0165_rehearses_populated_expand_with_bounded_lock_and_statement_timeouts`

The tests run the exact 0165 migration against PostgreSQL with the real
`mnt_rt`, `mnt_ontology_cmd`, migration-owner, and capability-owner role
topology. They execute the retained binary's SQL shapes and prove that missing
or duplicate same-transaction audit evidence rolls the write and CAS sidecar
back atomically, and exercise the populated migration under explicit timeout
budgets. They do not launch the f6ff236 executable, prove that every old replica
has drained, raise the rollback floor, or constitute deployment evidence.
