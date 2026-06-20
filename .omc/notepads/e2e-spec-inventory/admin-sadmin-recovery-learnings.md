# ADMIN / SUPER_ADMIN + recovery E2E — learnings

## App bugs fixed (all the SAME systemic pattern: time types vs OpenAPI `string`)
The OpenAPI contract (`backend/openapi/openapi.yaml`) types `Timestamp` as `string`/date-time
and `Date` as `string`/date, but several Rust DTOs used bare `time::OffsetDateTime` / `time::Date`
which serde (de)serializes as numeric arrays. Prior batch fixed RESPONSE DTOs; this batch found
more on both response AND request DTOs:

- RESPONSE (rfc3339 serde, render-side): `financial/application` RentalQuoteSummary.created_at,
  CostLedgerEntrySummary.entry_at, PurchaseRequestSummary.created_at/updated_at;
  `inspection/application` InspectionScheduleSummary.created_at/updated_at/completed_at,
  InspectionRoundSummary.completed_at; `reporting/domain` Period.start/end (KpiReport).
  Fix: `#[serde(with = "time::serde::rfc3339")]` / `::option`.
- REQUEST (deserialize-side, surfaced as 422 in-browser):
  - `inspection/rest` CreateScheduleRequest.due_date (`time::Date`) → 422
    "invalid type string, expected a Date". Fix: `time::serde::format_description!(iso_date, Date,
    "[year]-[month]-[day]")` + `#[serde(with = "iso_date")]` (same as workorder plan_date).
  - `workorder/rest` TargetChangeRequestBody.requested_target_due_at (OffsetDateTime) → 422.
    Fix: `#[serde(with = "time::serde::rfc3339")]`.
- No OpenAPI regen needed: spec already says `string`; the fix aligns runtime to the contract.
  `check:openapi-app` + clippy -D + fmt + all 6 mnt-gate-* + RLS-arming all clean.

## Seed gaps fixed (not app bugs — real prerequisite data)
- ADMIN-07 approve needs `work_order_approval_steps` (mechanic APPROVED, admin PENDING). A bare
  REPORT_SUBMITTED status row 409s "no pending non-mechanic approval step". The reject path does
  NOT need the approval line. Reset must restore the steps too (approve mutates them).
- ADMIN-10 inspection: the mechanic must be an active `team='예방'` (PREVENTION) MECHANIC in the
  branch (adapter `ensure_prevention_mechanic_tx`). Seeded a dedicated 예방 mechanic …d0007.
- ADMIN-13 rental quote: registry_equipment needs `vehicle_value`/`residual_value` (not the
  `_won` quote columns) or create 422s "equipment vehicle value is required".
- ADMIN-13 purchase: statement_evidence must be a VERIFIED **REQUEST-stage** evidence_media row
  (stage='REQUEST', worm_replica_status='VERIFIED'), not REPORT.
- ADMIN-09 force-assign: only legal when the p1_dispatch is `MANAGER_FORCE_PENDING` (escalated),
  NOT `BROADCASTING` (409 "illegal transition Broadcasting → AutoAssigned").
- ADMIN-14 substitution: candidate must be a 예비 spare with the SAME specification, same
  equipment_no char[2] power code, and matching/nearest-above tonnage in the same branch.
- Adding the compatible spare (…ee0006) changed MECH-13's world: it asserted the empty-state
  "no candidates"; updated it to assert the now-present 예비 candidate + admin-only assign hidden.

## Permission matrix (verified, not weakened)
- ADMIN and SUPER_ADMIN see IDENTICAL nav (all 17 items). The SUPER_ADMIN-only delta is the
  `ElevatedRoleGrant` feature `[D,D,D,D,A]`: granting EXECUTIVE/SUPER_ADMIN on user create is
  SUPER_ADMIN-only. The frontend shows the elevated-role checkboxes to every admin; the gate is
  server-side (403 → createFailed). So the ADMIN-negative asserts the create-failed error, NOT a
  disabled control (the control is genuinely not disabled client-side).

## Deferred (no infra / no surface — not faked)
- ADMIN-06 master-list Excel import: backend `/api/v1/equipment/import` exists but has NO web
  upload UI (the only `type="file"` in web/src is the messenger attachment). No surface to drive.
- ADMIN-17 dispatch MAP view: out of scope for this batch.

## Harness notes
- roles.ts `loginAs(page, role)` drives the real OTP→onboard→enroll ceremony with a per-call
  virtual authenticator; reusable across mid-spec re-logins (each seeds a fresh OTP + device id).
- Recovery spec uses two browser CONTEXTS (admin + user). The recovered user owns an old
  authenticator (enrolls, proves login works) then a fresh one (re-enrolls after reset). After the
  admin credential-reset the OLD passkey login fails with "패스키 로그인에 실패했습니다." because the
  server credential is gone.
- PageHeader renders the single page `<h1>`; feature-card headings are `<h2>`/`<h3>`.
- `#[sqlx::test]` integration tests (mnt-app audit_api) need DATABASE_URL set; they fail with
  "DATABASE_URL must be set" under a bare `cargo test --all`. Pass isolated with
  `DATABASE_URL=postgres://$USER@localhost:5432/postgres cargo test -p mnt-app --test audit_api`.
  Whole-suite clean run: `DATABASE_URL=postgres://$USER@localhost:5432/postgres SQLX_OFFLINE=true
  cargo test --all --no-fail-fast` (the env-var lets the sqlx test harness provision its templates).

## ROOT CAUSE of the "44/4" flake (the 4 that intermittently failed) — RATE-LIMIT GLOBAL BUCKET
- Signature of all 4: redeem_otp rejected ("코드가 올바르지 않거나 만료되었습니다", stays on /login) OR
  token/refresh returns no access_token (auth-06 `token` undefined) OR a passkey login briefly hits
  /dispatch then bounces (auth-07b). NOT a selector/seed/app bug — every one of these 4 passes ALONE
  and passed in a clean full run; the failures were timing/ordering flakes.
- Mechanism: `backend/crates/platform/auth-rest/src/lib.rs` rate-limits each unauth auth endpoint
  (LoginStart, OtpRedeem, Refresh) in a FIXED 1-minute window across 3 buckets: per-IP=10, per-device=10,
  GLOBAL=100. In e2e there is NO `X-Forwarded-For`, so `client_ip()` returns None → the per-IP bucket is
  SKIPPED and every request (all devices) collapses onto the single `global` bucket. Over a ~1.5-min
  suite the `refresh`/`otp_redeem` global counters cross 100 inside one wall-clock minute → 429s. The
  frontend renders a 429 redeem as the generic invalid-OTP alert and a 429 refresh as a missing token.
  Confirmed empirically: post-run `auth_rate_limit` showed `refresh|global=61` and `otp_redeem|global=33`
  in a single window after one full suite — right at the edge of the cap.
- FIX (pure test isolation, ZERO production code): per-test `DELETE FROM auth_rate_limit`.
  - Added to `e2e/harness/reset-coldstart.sql` (already runs per-test for auth.ts specs).
  - Added `resetRateLimits()` to `e2e/fixtures/roles.ts`, called in the `loginAs` fixture (admin/mech
    specs reset nothing per-test otherwise) and at the top of the heavy `admin-16` recovery spec.
  - `auth_rate_limit` is a global, RLS-free table (no org_id) → safe to TRUNCATE/DELETE without arming a GUC.
  - Production is unaffected: real clients have distinct IPs so the per-IP cap (10) governs, never the global one.
- Verified: `bash e2e/run.sh` = 48/48 green, run TWICE back-to-back, order-independent. The previously
  flaky admin-07/admin-16/auth-06/auth-07 are green in both runs.
