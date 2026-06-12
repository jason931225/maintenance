# Harden wave 1 — security review fixes (confirmed findings)

Same Hard Rules as m0-wave1.md. Strict clippy (-D warnings) required.

### FIX 1 [HIGH] — WebAuthn/passkey ceremony consumed non-atomically (auth replay/race)
backend/crates/platform/auth/src/webauthn.rs: `load_ceremony` (line ~334) reads `consumed_at IS NULL` on the POOL (no lock); `consume_ceremony_tx` (line ~357) does `UPDATE ... SET consumed_at WHERE id=$1` with NO `consumed_at IS NULL` predicate and NO rowcount check. Two concurrent finish requests both pass the read → both verify → both mint token pairs from one ceremony. Bootstrap (provisioning/src/lib.rs ~327/347) commits passkey registration BEFORE bootstrap-credential consume — same class.
- Fix register + authenticate finish flows: claim the ceremony ATOMICALLY inside the same tx that consumes it — `UPDATE auth_webauthn_ceremonies SET consumed_at=$now WHERE id=$1 AND ceremony_kind=$2 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id, state_json`; if 0 rows → reject (already consumed/expired). Verify the WebAuthn assertion AFTER the atomic claim, using the RETURNING state; on verification failure return Err so the tx rolls back (claim undone — legitimate retry still possible, but a committed success permanently consumes → replay blocked).
- Bootstrap: make passkey-registration-commit and bootstrap-credential-consume ONE transaction (provisioning), so a passkey can't be created without atomically consuming the single-use bootstrap credential.
- Tests: concurrent-finish replay test (spawn two finish calls for one ceremony → exactly one succeeds, one gets rejected; assert only one token pair / one passkey row); bootstrap concurrent-use test (two registrations with one bootstrap cred → one wins).

### FIX 2 [MEDIUM] — audit-coverage gate exemption not bound to the real writer
backend/ci/gates/audit-coverage/src/lib.rs: AuditExclusion has {reason, path} but line ~217 checks ONLY reason (path unused); handler detection (line ~363) only scans application|rest|worker, so the REAL ping writer (crates/compliance/adapter-postgres/src/lib.rs::record_location_ping) isn't even covered. This weakens ADR-0014's "exactly one path" invariant — the exemption could silently apply to the wrong handler.
- Bind the exemption to repo-relative file + function (e.g. `crates/compliance/adapter-postgres/src/lib.rs` + `record_location_ping`); extend handler detection to include adapter-postgres crates for the location-ping path specifically.
- Add a negative fixture test: the same `location_ping_ingestion` reason on ANY other handler is REJECTED (proves the exemption is path-bound, not reason-only).
- Keep the existing "only one exclusion" test green.

After both: full verification suite (fmt, strict clippy -D warnings, sqlx prepare --all-targets, cargo test, 4 gates incl. the modified audit-coverage gate run against the real workspace). Commit with evidence.
