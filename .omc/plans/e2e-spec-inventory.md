# Browser-E2E spec inventory (GOAL B) — per-story pass tracker

Status legend: ☐ not written · ◐ written, not green · ☑ green in Chromium

Harness: `e2e/` (Playwright + CDP WebAuthn virtual authenticator; vite :5173 proxy /api→:8080; RP_ID=localhost; COOKIE_SECURE=false). Each gated page also gets a NEGATIVE spec (nav hidden + direct-URL 403/redirect) asserted against `web/src/components/shell/nav.test.ts` EXPECTED_VISIBLE.

Test isolation (flake fix): every request shares one origin with NO `X-Forwarded-For`, so the backend per-IP rate-limit bucket is skipped and ALL auth traffic collapses onto the single `global` bucket (cap 100/min/endpoint). Across a ~1.5-min suite the `refresh`/`otp_redeem` global counters can cross 100 inside one wall-clock window → 429s surfacing in-browser as spurious "invalid/expired OTP" or an undefined refreshed token (was: admin-07/admin-16/auth-06/auth-07 flaking ~1-in-N). Fix = per-test `DELETE FROM auth_rate_limit`: added to `reset-coldstart.sql` (auth.ts specs) + `resetRateLimits()` in `fixtures/roles.ts` (run in the `loginAs` fixture and at the top of the heavy admin-16 recovery spec). Pure harness isolation — NO production code touched; prod is unaffected (real clients have distinct IPs so the per-IP cap governs). Suite is now order-independent: full `bash e2e/run.sh` 48/48 green run-twice.

## Cross-cutting auth (every role)
- ☑ AUTH-01 Passkey login (usernameless/discoverable)  — green (auth-01)
- ☑ AUTH-02 OTP redeem → forced onboarding (requires_passkey_setup)  — covered by auth-01 ceremony
- ☑ AUTH-03 Passkey enrollment (resident key)  — covered by auth-01 ceremony
- ☑ AUTH-04 Boot silent refresh restores session on hard reload  — green (auth-04)
- ☑ AUTH-05 Logout revokes refresh family → guard bounces to /login  — green (auth-05)
- ☑ AUTH-06 Passkey list / add / revoke + last-passkey 409 guard  — green (auth-06)
- ☑ AUTH-07 Route guards (unauth→/login; tenant↔platform bounce)  — green (auth-07)
- ☑ AUTH-08 RECOVERY: admin credential-reset → old passkey rejected → new OTP redeem → re-enroll  — green (admin-16-auth-08-recovery; two real sessions in Chromium)

## MECHANIC
- ☑ MECH-00 login → /dispatch (mech-00) · ☑ MECH-01 see dispatch board (mech-01-02) · ☑ MECH-02 self-assign RECEIVED WO → claim-and-start → 진행 (mech-01-02; app fix: board self-assign now calls start_work + backend self-claim) · ☑ MECH-03 accept P1 offer (mech-03-04) · ☑ MECH-04 decline P1 offer (mech-03-04) · ☑ MECH-05 start WO (mech-05-06) · ☑ MECH-06 submit work report (mech-05-06; app fix: report-done message hoisted to panel level) · ☐ MECH-07 attach evidence photo (needs S3) · ☑ MECH-08 intake create WO + 호기 autopull (mech-08) · ☑ MECH-09 daily plan create/request/admin-confirm (mech-09; app fix: GET /daily-work-plans/{id} + page deep-link load + mechanic self-roster) · ☐ MECH-10 inspection round complete · ☑ MECH-11 messenger send/thread (mech-11) · ☑ MECH-12 support ticket view/comment (mech-12; claim/transition are admin-only AssigneeManage — triage controls now hidden from mechanics) · ☑ MECH-13 equipment lookup + 대차 candidates read (mech-13; app fix: SubstitutionPanel candidate-read now visible to mechanics; updated to assert the now-seeded compatible 예비 spare appears + assign control stays admin-only) · ☑ MECH-14 Excel export (mech-14) · ☐ MECH-15 purchase request · ☑ MECH-16 profile + location consent (mech-16)
- ☑ MECH-NEG nav hidden + /approvals & /settings/users redirect (mech-neg-nav; app fix: /approvals now under RequireAdminRoute)

## RECEPTIONIST
- ☑ RECP core: equipment lookup + intake(접수증) + reporting export + profile (recp-01-core) · ☑ RECP messenger + support read/comment, triage hidden (recp-02-messenger-support; seed-recp.sql: receptionist-owned thread …c00002; support ticket …b00001 is branch-scoped so already visible)
- ☑ RECP-neg nav hidden (incl. daily-plan + kpi) + /daily-plan & /kpi bounce to /dispatch (recp-neg-nav; app fix: /daily-plan now under RequireDailyPlanRoute, /kpi under RequireKpiRoute — were unguarded app-shell routes a receptionist could open by URL)

## ADMIN / SUPER_ADMIN
- ☑ ADMIN-01 create user (roles/branches) (admin-01-03-users) · ☑ ADMIN-02 issue OTP (admin-01-03-users) · ☑ ADMIN-03 edit/deactivate user (admin-01-03-users) · ☑ ADMIN-04 region+branch CRUD (admin-04-org) · ☑ ADMIN-05 equipment CRUD (admin-05-equipment) · ☐ ADMIN-06 master-list import (**DEFERRED: no web upload surface — endpoint /api/v1/equipment/import has no UI; only file input in app is the messenger attachment**) · ☑ ADMIN-07 approvals approve/reject (admin-07-approvals; seed gap fixed: approval-line steps) · ☑ ADMIN-08 daily-plan review approve+reject (admin-08-daily-plan) · ☑ ADMIN-09 dispatch controls priority/schedule/multi-assign/force (admin-09-dispatch; app fix: target-change-request OffsetDateTime rfc3339) · ☑ ADMIN-10 inspection schedule (admin-10-inspection; app fix: due_date Date iso_date serde; seed: 예방 mechanic) · ☑ ADMIN-11 KPI dashboard (admin-11-12-dashboards; app fix: Period Timestamp rfc3339) · ☑ ADMIN-12 ops dashboard (admin-11-12-dashboards) · ☑ ADMIN-13 financial quote+ledger+purchase-approve (admin-13-financial; app fix: RentalQuote/CostLedger/PurchaseRequest Timestamp rfc3339; seed: equipment vehicle/residual value + REQUEST evidence) · ☑ ADMIN-14 substitution 대차 assign/return (admin-14-substitution; seed: compatible 예비 spare) · ☑ ADMIN-15 reporting export (admin-15-reporting) · ☑ SADMIN elevated-role grant (SUPER_ADMIN) + ADMIN-negative (admin-sadmin-elevated)
- ☑ ADMIN-16 credential-reset / recovery action (admin-16-auth-08-recovery) · ☐ ADMIN-17 dispatch MAP view (#12) — out of scope this batch

## EXECUTIVE
- ☑ EXEC-01 KPI dashboard (exec-01-kpi; KpiRead `[D,D,A,A,A]`) · ☑ EXEC-03 purchase final-approve, exec-only PurchaseFinalApprove `[D,D,D,A,A]` → EXECUTIVE_PENDING→READY_TO_EXECUTE, 집행 stays hidden (exec-03-purchase-final-approve; seed-exec.sql: …f10001 EXECUTIVE_PENDING) · ☑ EXEC-04 rental quote + ☑ EXEC-05 reporting export (exec-04-05-quote-export) · ☑ EXEC-neg approvals/daily-plan/inspection/ops/users/org/security hidden + each direct-URL bounces to /dispatch (exec-neg-nav)

## PLATFORM-ADMIN (sentinel org, /platform/*)
- ☑ PLAT-01 list tenants (valid 생성일, NOT "Invalid Date") + cross-tenant ops health (plat-01-tenants-health) · ☑ PLAT-02 onboard tenant → one-time SUPER_ADMIN OTP renders (plat-02-onboard) · ☑ PLAT-03 suspend→reactivate via confirm dialog (plat-03-suspend-reactivate) · ☑ PLAT-04 platform bearer 403 on tenant /api + UI bounce off tenant page (plat-04-neg-tenant-api)
- App fixes (caught ONLY by real-backend E2E; unit-test mocks encode the right contract so they never see it): platform DTO timestamps serialized as serde integer-arrays (created_at/updated_at/last_activity_at/admin_otp_expires_at) → added `#[serde(with="time::serde::rfc3339")]`/`::option`; GET /platform/orgs returned `{items:[…]}` but console reads a bare array → return bare array; POST onboard returned `{organization, admin_otp}` but console reads `{org, otp}` → renamed REST DTO fields so the one-time OTP actually surfaces. Verified by curling the live backend with a minted platform JWT before+after.

## Public / unauthenticated
- ☐ PUB-01 customer support intake /support/new · ☐ PUB-02 wallboard kiosk /wallboard

## i18n / UX baseline (GOAL B-UX)
- ☑ Shared UX layer `e2e/fixtures/ux.ts` woven into every new spec + reused across the suite: (a) ZERO critical/serious axe (@axe-core/playwright) violations per settled screen; (b) NO console.error / pageerror during the flow (fail on capture; only benign vite/favicon/ResizeObserver noise ignored); (c) loading/empty/error states exercised where applicable; (d) Korean i18n — assert no raw i18n key (`/^[a-z]+(?:\.[a-z][a-z-]*)+$/`) leaks into visible text (code/pre/inputs excluded so slugs/OTP/identifiers aren't flagged). Pragmatic: minor/moderate a11y nits do not fail; genuine findings fixed in-app, any deliberate exception annotated `// UX-DEBT` at the call site.

Prereqs: recovery flow (AUTH-08/ADMIN-16) + #12 map (ADMIN-17) must ship before their specs. Every red spec that is an APP bug → fix the app (that's the point of browser E2E).
