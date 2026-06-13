<!-- Source: codex gpt-5.5 adversarial security+compliance review, session 019ebdc1-1183-7c40-bc8c-c21c718b9e9f (read-only sandbox; report recovered from transcript b9xgw0opy by lead). Findings dispositioned into harden wave 1 (fix/harden-1). -->

# Security + PIPA/Location Compliance Review

## Findings

### HIGH: WebAuthn/passkey ceremonies are consumed non-atomically
File: [webauthn.rs](/Users/jasonlee/Developer/maintenance/backend/crates/platform/auth/src/webauthn.rs:334)

Evidence:
- [webauthn.rs:334](/Users/jasonlee/Developer/maintenance/backend/crates/platform/auth/src/webauthn.rs:334) loads ceremonies with `consumed_at IS NULL`, but no `FOR UPDATE`.
- [webauthn.rs:357](/Users/jasonlee/Developer/maintenance/backend/crates/platform/auth/src/webauthn.rs:357) consumes with `UPDATE auth_webauthn_ceremonies SET consumed_at = $1 WHERE id = $2`, with no `consumed_at IS NULL` predicate or row-count check.
- [webauthn.rs:235](/Users/jasonlee/Developer/maintenance/backend/crates/platform/auth/src/webauthn.rs:235) verifies auth ceremonies before the tx starts at line 267.
- [auth-rest/src/lib.rs:435](/Users/jasonlee/Developer/maintenance/backend/crates/platform/auth-rest/src/lib.rs:435) issues token pairs after `finish_authentication`.
- [provisioning/src/lib.rs:327](/Users/jasonlee/Developer/maintenance/backend/crates/platform/provisioning/src/lib.rs:327) commits passkey registration before bootstrap consume at line 347.

Impact: concurrent finish requests can both pass the pre-consume read. Login replay can mint multiple token pairs from one ceremony; bootstrap can commit passkeys before single-use bootstrap consumption is enforced.

Fix: atomically claim ceremonies with `UPDATE ... WHERE consumed_at IS NULL ... RETURNING user_id, state_json` or `SELECT ... FOR UPDATE` in one tx. Make bootstrap passkey creation and bootstrap consume one transaction. Add concurrent replay tests.

### MEDIUM: Audit exemption is not bound to the real LocationPing writer
File: [audit-coverage/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/ci/gates/audit-coverage/src/lib.rs:77)

Evidence:
- [audit-coverage/src/lib.rs:77](/Users/jasonlee/Developer/maintenance/backend/ci/gates/audit-coverage/src/lib.rs:77) defines `AuditExclusion { reason, path }`.
- [audit-coverage/src/lib.rs:217](/Users/jasonlee/Developer/maintenance/backend/ci/gates/audit-coverage/src/lib.rs:217) checks only `exclusion.reason == reason`; `path` is unused.
- [audit-coverage/src/lib.rs:363](/Users/jasonlee/Developer/maintenance/backend/ci/gates/audit-coverage/src/lib.rs:363) limits handler detection to `application|rest|worker`.
- The real ping writer is [adapter-postgres/src/lib.rs:202](/Users/jasonlee/Developer/maintenance/backend/crates/compliance/adapter-postgres/src/lib.rs:202), not a REST fixture.
- [gate_detects_violation.rs:156](/Users/jasonlee/Developer/maintenance/backend/ci/gates/audit-coverage/tests/gate_detects_violation.rs:156) tests a synthetic `crates/compliance/rest/src/lib.rs`.

Impact: CI can accept `location_ping_ingestion` on the wrong mutating handler, weakening ADR-0014’s “exactly one path” invariant.

Fix: bind the exemption to repo-relative file plus function, e.g. `backend/crates/compliance/adapter-postgres/src/lib.rs::record_location_ping`, and add negative tests for the same reason on any other handler.

## Clean Dimensions

- Route JWT/default-deny: clean. `/api/audit` requires configured JWT verification, bearer parsing, principal construction, authz, and empty branch scope maps to `FALSE` at [app/src/lib.rs:821](/Users/jasonlee/Developer/maintenance/backend/app/src/lib.rs:821), [app/src/lib.rs:897](/Users/jasonlee/Developer/maintenance/backend/app/src/lib.rs:897), [app/src/lib.rs:976](/Users/jasonlee/Developer/maintenance/backend/app/src/lib.rs:976).
- Refresh-token reuse: clean. Rotation locks token/family with `FOR UPDATE OF t, f`, detects reuse, revokes family, and tests verify replacement rejection: [refresh.rs:147](/Users/jasonlee/Developer/maintenance/backend/crates/platform/auth/src/refresh.rs:147), [refresh_tokens.rs:16](/Users/jasonlee/Developer/maintenance/backend/crates/platform/auth/tests/refresh_tokens.rs:16).
- Role matrix: clean outside the bootstrap race above. Elevated grants are SuperAdmin-only and branch scope is checked before feature permission: [authz/src/lib.rs:171](/Users/jasonlee/Developer/maintenance/backend/crates/platform/authz/src/lib.rs:171), [authz/src/lib.rs:287](/Users/jasonlee/Developer/maintenance/backend/crates/platform/authz/src/lib.rs:287).
- GPS into `audit_events`: no current runtime path confirmed. Compliance pings write to destructible tables without `with_audit`; consent audits serialize `LocationConsent`; dispatch audit snapshots exclude coordinates.
- Consent withdrawal: clean. Withdrawal deletes `location_collection_logs` and `location_pings` in the transition tx: [adapter-postgres/src/lib.rs:183](/Users/jasonlee/Developer/maintenance/backend/crates/compliance/adapter-postgres/src/lib.rs:183).
- Ping ingestion consent: clean. Requires on-duty and `location_consents.status = 'GRANTED'`: [adapter-postgres/src/lib.rs:202](/Users/jasonlee/Developer/maintenance/backend/crates/compliance/adapter-postgres/src/lib.rs:202), [adapter-postgres/src/lib.rs:224](/Users/jasonlee/Developer/maintenance/backend/crates/compliance/adapter-postgres/src/lib.rs:224).
- WS auth: clean. Principal is resolved before upgrade; Authorization and `Sec-WebSocket-Protocol: bearer, <token>` both verify JWT: [realtime/src/lib.rs:793](/Users/jasonlee/Developer/maintenance/backend/crates/platform/realtime/src/lib.rs:793), [realtime/src/lib.rs:885](/Users/jasonlee/Developer/maintenance/backend/crates/platform/realtime/src/lib.rs:885).

No fresh Cargo gate/test run is claimed because the filesystem is read-only and Cargo would need write access to `target`/temp dirs.
