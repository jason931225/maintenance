# Approved auth / attendance / payroll / role PR lanes — t_20260702

Updated: 2026-07-02
Coordinator: GJC Ultragoal session `.gjc/_session-019f2034-b14a-7000-b23f-c08b37919868/ultragoal`
Approved source plan: `.gjc/_session-019f1c84-29db-7000-9191-a07b3b6d29f7/plans/ralplan/019f1c84-29db-7000-9191-a07b3b6d29f7/pending-approval.md`

## Steering recorded

- The existing permission bug fix remains its own PR lane.
- Requirements 2-4 are approved execution scope, but each must finalize plan / acceptance criteria / boundaries / likely conflicting files before implementation.
- Requirement 2, 3, and 4 each become a separate PR lane.
- Payroll/self-service work must keep the approved dedicated payroll boundary; do not turn `payroll_draft_*` readiness staging into issued payroll.
- New 2026-07-02 steering adds a separate nav/access segmentation PR lane because `물류·정비 운영` and `장비·영업` access gates share `web/src/components/shell/nav.ts`, route guards, Korean i18n, and accessibility tests with the role lane.
- `업무 허브`, `메신저`, and `메일함` must not live under `물류·정비 운영`; they move to a new topmost `개인/부서 업무` left-nav group because other teams/departments also need their own work hub.
- Correction 2026-07-02: PR #134 is **not** the substitute for the 베스텍/패스키 pending MEMBER 권한버그 web fix. PR #134 is tracked as a separate backend org-wide authz PR.
- The 베스텍/패스키 pending MEMBER 권한버그 candidate is the 9-file web change set currently left in `/Users/jasonlee/Developer/maintenance.gajae-code-worktrees/perf-hr-read-path-indexes-t-f873770a-9f520d9e`.

## Lane A0 — Bestec pending/member web access bug PR

Working branch/worktree source: `/Users/jasonlee/Developer/maintenance.gajae-code-worktrees/perf-hr-read-path-indexes-t-f873770a-9f520d9e`
Clean-main PR branch target: `fix/bestec-pending-member-web-access-t_20260702`
Scope:
- Promote the actual 베스텍/패스키 pending MEMBER web authorization fix from the 9-file candidate change set, not PR #134.
- Base the PR on clean `main` and include only the 9 intended web files; `node_modules` must never be added, staged, committed, pushed, or mentioned as part of the diff.
- Treat console access as granted when a `MEMBER` session has a mapped runtime feature grant with a visible route guard, or group-admin authority, while preserving no-grant MEMBER pending behavior.
- Keep first-login passkey onboarding behavior intact.
- Add/keep pending-page access refresh UX so a newly elevated user can re-check authorization and leave `/pending` without a full manual session reset.
- Keep topbar identity/access menus consistent with granted console access.

Acceptance criteria:
- Clean-main PR contains exactly the intended 9 web files and no `node_modules`.
- No-grant MEMBER still reaches only `/pending` and `/settings/profile`; gated console routes redirect to `/pending`.
- MEMBER with mapped runtime `feature_grants` can access the matching console route and is not trapped on `/pending`.
- GROUP_ADMIN-only MEMBER is treated as having console access where group admin pages apply, without leaking tenant location/admin menus.
- Pending page exposes Korean `권한 다시 확인` / `권한 확인 중` / failure copy, refreshes session state, and redirects once access is granted.
- Topbar pending badge and menu actions reflect granted console access, not raw built-in role only.
- User elevation flow can show/clear the `MEMBER` role when a self-signup user is elevated.
- Focused tests cover `ProtectedRoute`, pending page behavior, nav feature-grant access, topbar group-admin-only behavior, Korean i18n labels, and user elevation handling.
- PR is opened/updated with verification and independent review evidence, then left as a merge candidate only after CI/merge-condition checks are recorded.

Boundary / non-goals:
- This lane does not change backend org-wide authz semantics from PR #134.
- This lane does not implement Lane E nav/access segmentation for `물류·정비 운영` / `장비·영업`; it only fixes pending MEMBER/passkey access behavior.
- This lane does not add attendance import, payroll linkage, payroll self-service, or new operational role templates.
- This lane must not broaden no-grant MEMBER access beyond Profile/Pending.
- Do not report PR #134 and this lane as the same symptom or the same fix.

Likely conflict files:
- `web/src/components/ProtectedRoute.tsx`
- `web/src/pages/PendingPage.tsx`
- `web/src/components/shell/nav.ts`
- `web/src/components/shell/nav.test.ts`
- `web/src/components/shell/Topbar.tsx`
- `web/src/features/org/org-format.ts`
- `web/src/i18n/ko.ts`
- `web/src/pages/MemberAccess.test.tsx`
- `web/src/pages/UsersPage.test.tsx`

Current candidate evidence:
- Current worktree diff contains exactly these 9 web files with approximately 320 insertions / 34 deletions.

Current PR status:
- PR: https://github.com/jason931225/maintenance/pull/136 — `fix(web): unblock granted pending members`.
- Branch: `fix/bestec-pending-member-web-access-t_20260702`, rebased onto current `origin/main`.
- Diff scope: exactly 9 web files; `node_modules` excluded.
- Local verification after rebase: focused tests 52 passed; full `web:test` 77 files / 457 tests passed; `web:lint` passed; `web:build` passed; `git diff --check` passed.
- Independent review: architect CLEAR/CLEAR/CLEAR APPROVE blockers=[]; executor QA/red-team passed blockers=[].
- GitHub CI: all checks SUCCESS; mergeability observed as CLEAN / MERGEABLE.
- Status: merge candidate only; not auto-merged here.

## Lane A1 — backend org-wide authz PR #134, separate from Bestec pending/member web bug

PR: https://github.com/jason931225/maintenance/pull/134 — `fix(authz): restrict org-wide built-in roles`
Branch: `fix/authz-org-wide-builtins-t_31ff3f4e`
Scope:
- Keep `authorize_org_wide` from widening all built-in `ADMIN` users into tenant-wide authority.
- Preserve tenant-owned custom org-wide effective grants where the API intentionally authorizes an org-wide read.
- Keep HR attendance summary branch-omitted reads on the org-wide gate.
- Track this as a backend org-wide authz PR only; do **not** report it as the 베스텍/패스키 pending MEMBER 권한버그 fix.

Acceptance criteria:
- Built-in `ADMIN` with synthetic `BranchScope::All` is not enough for unrestricted org-wide reads unless the feature explicitly allows that built-in role.
- `SUPER_ADMIN` and intended executive/org-wide features continue to work.
- Active custom roles with org-wide effective grants still authorize their granted features.
- HR attendance summary no-branch behavior is tested.
- PR CI remains green and independent review evidence exists before merge.
- Reports explicitly state this is separate from the Bestec pending/member web bug lane.

Boundary / non-goals:
- No pending MEMBER web routing, passkey pending-state, topbar, Korean i18n, or nav visibility fixes in this PR.
- No attendance import, payroll UI/API, role-template expansion, or migration work in this PR.
- No branch protection bypass. Merge only after review/fix/verification evidence is attached.

Likely conflict files:
- `backend/crates/platform/authz/src/lib.rs`
- `backend/crates/platform/authz/tests/policy.rs`
- `backend/app/src/hr.rs`

Current status evidence:
- PR #134 is MERGED at 2026-07-02T00:46:09Z with merge commit `78d42f43d5dc4674683142e789adb944c0936e10`.
- PR #134 CI was SUCCESS before merge.
- This is recorded only as the separate backend org-wide authz lane; it is not reported as the Bestec pending/member web access bug fix.

## Lane B — requirement 2 PR lane: direct attendance import

Working branch target: `feat/attendance-direct-import-t_20260702`
Scope:
- Add a first-class attendance import entity separate from `employee_hr`.
- Extend the governed import ledger (`data_import_runs`, `data_import_rows`) to accept `attendance_direct` without exposing raw restricted cells to normal HR readers.
- Parse direct attendance workbook/CSV rows into append-only, audited, coordinate-free attendance facts or a new staging table that can be safely linked to payroll readiness.
- Keep existing geofence-derived `site_attendance_events` behavior intact.

Acceptance criteria:
- Upload/preview/dry-run/apply flow exists for direct attendance imports.
- Accepted rows preserve source lineage (`run_id`, row id/source row, source hash) and reject malformed/ambiguous rows with per-row reasons.
- Imported attendance can be summarized by existing HR attendance summary or a new dedicated endpoint without cross-branch leakage.
- Payroll readiness can reference attendance import rows without making payroll payable.
- Sensitive/raw fields are masked in preview responses unless the caller has the explicit import/manage feature.
- Tests cover valid rows, missing employee resolution, duplicate rows, formula-injection neutralization for exports, branch/RLS denial, and audit rows.

Boundary / non-goals:
- No employee mobile/PC punch UI in this lane.
- No payroll ledger generation or employee payroll self-service downloads in this lane.
- No new built-in tenant roles unless needed for authz compatibility; prefer custom role templates for operational personas.

Likely conflict files:
- `backend/crates/platform/db/migrations/0070_create_data_import_runs.sql` or new `0084_*` migration
- `backend/app/src/hr.rs` or a new attendance REST module mounted from `backend/app/src/lib.rs`
- `backend/openapi/openapi.yaml`
- `web/src/pages/EmployeesPage.tsx`
- `web/src/pages/EmployeesPage.test.tsx`
- `web/src/features/data-exchange/domainMapping.ts`
- `web/src/i18n/dataExchange.ts`
- `web/src/api/types.ts` after OpenAPI generation
- `scripts/check-g008-payroll-readiness.mjs` if readiness lineage checks change

## Lane C — requirement 3 PR lane: employee mobile/PC attendance records and payroll linkage

Working branch target: `feat/employee-attendance-payroll-link-t_20260702`
Scope:
- Add employee self-service attendance recording for mobile and PC: clock-in, out-of-office, business trip, return/normalization if needed, and clock-out.
- Link employee attendance records to payroll readiness/payroll material lineage without exposing generated payroll or legal/tax advice.
- Add self-only user↔employee linkage gates, plus manager/payroll/audit read boundaries.
- Add UI surfaces appropriate for employees and authorized managers/payroll operators.

Acceptance criteria:
- Linked employee can create and view only their own attendance records from web/mobile-compatible API paths.
- Other employees cannot read or mutate another employee's attendance by API URL, browser route, or forged body.
- Manager/payroll/admin reads require explicit feature authorization and branch/org scope.
- Attendance records feed payroll readiness/material lineage with immutable source refs and audit/download/read logs where sensitive.
- UI shows pending/today/history states and avoids legal/tax/payroll-calculation claims.
- Tests cover mobile/PC user agents or API clients, own-only RLS/API denial, invalid transition sequences, idempotency/duplicate punch handling, and payroll-readiness linkage.

Boundary / non-goals:
- No direct attendance bulk import in this lane except consuming the output of Lane B after merge.
- No full payroll statement download/ledger generation unless it is only a link placeholder to the approved payroll module.
- No production payroll calculation enablement; `BLOCKED_LEGAL_GATE` remains closed.

Likely conflict files:
- New `0085_*` migration for employee attendance records / transitions / linkage
- `backend/crates/platform/db/migrations/0074_create_payroll_readiness.sql` only via additive follow-up migration, not direct mutation if already shipped
- `backend/crates/platform/db/migrations/0076_user_employee_link.sql` usage/tests
- `backend/app/src/hr.rs` or new attendance/payroll REST modules
- `backend/crates/platform/request-context/src/lib.rs` if employee-scoped DB context is added
- `backend/openapi/openapi.yaml`
- `web/src/components/ProtectedRoute.tsx`
- `web/src/components/shell/nav.ts`
- `web/src/AppRouter.tsx`
- New payroll/attendance pages and tests under `web/src/pages` / `web/src/features`
- Mobile parity surfaces under `ios/` / `android/` only if API/client generation changes require it

## Lane D — requirement 4 PR lane: site/security/cleaning/dispatch-office roles

Working branch target: `feat/operational-role-templates-t_20260702`
Scope:
- Add role/profile support for 현장, 경비, 미화, 파견사무 as governed operational personas.
- Prefer Policy Studio custom role templates and feature grants over expanding the hard-coded backend `Role` enum, unless a token-level built-in role is strictly necessary.
- Update UI/nav gates and backend feature catalog/tests so these personas see only their intended work surfaces.

Acceptance criteria:
- Policy role templates exist for 현장, 경비, 미화, 파견사무 with unique keys, Korean labels, categories, and non-elevated feature grants.
- Template grants do not include elevated policy/admin features (`role_manage`, `elevated_role_grant`, `user_manage`) unless a separate explicit approval exists.
- Assigned custom roles become runtime-effective through existing `feature_grants` claims/resolution and are visible in nav only through allowed feature gates.
- Tests prove each role can reach intended surfaces and is denied unrelated admin/payroll/ledger/policy surfaces.
- Policy Studio UI can display/create from the templates and retains passkey/preview/audit safety.

Boundary / non-goals:
- Do not overload `MECHANIC`/`RECEPTIONIST` labels or silently treat these personas as payroll authorities.
- Do not change existing users' built-in roles in data migrations.
- Do not grant payroll/tax features unless the payroll lane explicitly adds and tests them.
- Do not implement the `물류·정비 운영` / `장비·영업` nav group split or route-access segmentation in this role-template lane; that is Lane E below.

Likely conflict files:
- `backend/crates/identity/rest/src/lib.rs`
- `backend/crates/identity/rest/tests/org_setup.rs`
- `backend/crates/platform/authz/src/lib.rs` only if new features are required
- `backend/crates/platform/authz/tests/policy.rs`
- `backend/crates/platform/db/migrations/0065_create_policy_roles.sql` only via additive follow-up migration/catalog update if needed
- `web/src/pages/PolicyStudioPage.tsx`
- `web/src/pages/PolicyStudioPage.test.tsx`
- `web/src/components/shell/nav.ts`
- `web/src/components/shell/nav.test.ts`
- `web/src/i18n/ko.ts`

## Lane E — nav/access segmentation PR lane

Working branch target: `feat/nav-access-segmentation-t_20260702`
Scope:
- Restrict `물류·정비 운영` nav, routes, and access gates to the intended viewers only: 케이엔엘 정비사업부, 임원, 경영진, and 계열사 사업운영팀.
- Restrict `장비·영업` nav, routes, and access gates to the same intended viewers only.
- Add a new topmost left-menu group `개인/부서 업무` and move `업무 허브`, `메신저`, and `메일함` there so non-maintenance teams keep their own work hub/message/mail entry points.
- Use feature/custom-role gates rather than broad operational-role visibility wherever possible; do not broaden the existing auth bug PR.

Acceptance criteria:
- `개인/부서 업무` is the first nav group and contains only `업무 허브`, `메신저`, and `메일함`.
- `물류·정비 운영` no longer contains `업무 허브`, `메신저`, or `메일함`.
- `물류·정비 운영` items are visible only to the approved maintenance-division / executive-management / affiliate-business-operations personas or their explicit feature grants.
- `장비·영업` items are visible only to the same approved personas or their explicit feature grants.
- Other employees/teams can still access their allowed `개인/부서 업무` surfaces without seeing logistics-maintenance or equipment-sales nav items.
- Route guards match nav visibility; direct URL access to restricted logistics-maintenance/equipment-sales routes redirects or denies consistently.
- Korean i18n labels exist for the new nav group and any deny/empty copy.
- Accessible nav tests cover group order, labels, visible item names, keyboard/ARIA semantics where the existing test harness supports them, and restricted-persona denial.

Boundary / non-goals:
- This lane does not change the authz org-wide bug fix in PR #134.
- This lane does not add 현장/경비/미화/파견사무 role templates; it may only consume existing or already-merged feature grants.
- This lane does not implement attendance import, employee attendance records, or payroll linkage.
- This lane must not remove backend enforcement; UI nav hiding is only a client hint and routes/API still need server-side gates where data is sensitive.

Likely conflict files:
- `web/src/components/shell/nav.ts`
- `web/src/components/shell/nav.test.ts`
- `web/src/components/ProtectedRoute.tsx`
- `web/src/AppRouter.tsx`
- route guard components under `web/src/components/Require*Route.tsx`
- `web/src/i18n/ko.ts`
- affected page tests for `/work-hub`, `/messenger`, `/mail`, `/dispatch`, `/daily-plan`, `/collaboration`, `/equipment`, `/equipment/manage`, and `/catalog`
- `backend/crates/platform/authz/src/lib.rs` and `backend/crates/platform/authz/tests/policy.rs` only if new feature keys are required
- `backend/crates/identity/rest/src/lib.rs` only if the lane consumes/labels Policy Studio templates

## Cross-lane merge order

1. Lane A0 Bestec pending/member web access bug: promote the 9-file web candidate to a clean-main PR, verify/review/CI-check it, and keep `node_modules` out.
2. Lane A1 backend org-wide authz PR #134: track and report separately; it can merge independently after backend review/verification, but it is not the Bestec pending/member web bug fix.
3. Lane E nav/access segmentation: land or at least rebase after Lane A0 before role-template and attendance/payroll UI work touches shared nav/route gates; keep Lane A1 backend PR #134 independent.
4. Lane B direct attendance import: establish source-ledger ingestion before employee-created records consume or compare against imports.
5. Lane C employee attendance records/payroll linkage: depends on authz behavior and should consume Lane B lineage where needed.
6. Lane D role templates: can run after auth foundations and mostly parallel with B/C, but final nav/permission tests should be rebased after Lane E and after any new attendance/payroll feature keys land.

## Required verification classes

- Backend: focused Rust tests for authz, HR/attendance REST, RLS/API denial, import parsing, policy templates.
- API clients/OpenAPI: regenerate and run drift checks for any new endpoint/schema.
- Web: component/nav/route tests, Korean i18n checks, accessible label/group-order tests, build/lint after UI changes.
- E2E/security: own-vs-other employee denial, custom role persona route matrix, payroll/readiness gate remains blocked.
- Hermes/GJC: each PR lane must leave PR status, checks, review/fix evidence, and merge condition evidence in Hermes or PR comments.
