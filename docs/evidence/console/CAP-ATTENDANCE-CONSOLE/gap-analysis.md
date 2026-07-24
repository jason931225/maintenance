# CAP-ATTENDANCE-CONSOLE — Gap Analysis (backend inventory vs design contract)

Scout inventory of what already exists, what the new `backend/crates/attendance` crate must own,
and what belongs to other owners (gap manifest — not this lane's code).

## 1. Existing backend surface (reads to REUSE, do not rebuild)

### app/src/hr.rs (app-level HR router, mounted in the main app)
- `GET /api/v1/hr/attendance-summary` — branch-scoped daily summaries over `site_attendance_events` (geofence clock-in facts; coordinate-free). Gate: `authorize_hr_org_wide(Feature::EmployeeDirectoryRead)`.
- `GET|POST /api/v1/hr/attendance-records/me` — self-service attendance transitions. FSM `next_employee_attendance_state`: OFF_DUTY→CLOCK_IN→CLOCKED_IN; CLOCKED_IN→{OUT_FOR_WORK, BUSINESS_TRIP, CLOCK_OUT}; OUT_FOR_WORK/BUSINESS_TRIP→{RETURNED→CLOCKED_IN, CLOCK_OUT}. Idempotency-keyed, append-only, writes `payroll_attendance_material_refs`, **freeze-window gate** via `mnt_platform_db::period_lock::assert_period_open` (whole txn 409s inside an active lock).
- `GET /api/v1/hr/attendance-records` — HR/payroll review listing (per-employee or org).
- `POST /api/v1/hr/attendance-import/{preview,{run_id}/dry-run,{run_id}/apply}` + `GET …/summary` — governed direct import ledger (`attendance_direct_import_events`, lineage-preserving, masked).
- `GET /api/v1/hr/readiness-summary` — import/payroll/leave/attendance readiness counters.
- Exit/absence workflow: `employee_absence_alerts`, `employee_exit_cases`, settlement packages (mig 0092) — long-term absence/exit is owned here, NOT by the attendance crate (cover planner only reads it).

### workorder crate (`crates/workorder/rest`)
- `/api/daily-work-plans` (+`{plan_id}`, `/request-review`, `/review`, `/confirm`) — the **plan** side of plan-vs-actual. DRAFT→REQUESTED→APPROVED/REJECTED→FINAL_CONFIRMED. Console day board reads plans from here.

### leave crate (`crates/leave/rest`)
- `/api/v1/leave/requests` (+v2, decide, charge-resolution), `/api/v2/me/leave`, balances, promotions, refusal-notices — approvals that feed the cover planner (승인 부재 rows) and the `pa`/`lv` month statuses.

### payroll crate (`crates/payroll/rest`)
- `/api/v1/payroll/runs`, `/runs/{id}`, `/payslips/me` — downstream consumer of the close gate; already mirrors the attendance-self authz/audit pattern.

### platform
- `period_locks` (mig 0107, domain ∈ {payroll, accounting}) + `assert_period_open` fail-closed helper + `POST /api/v1/period-locks` / `…/{lockId}/unlock` (app/src/lifecycle.rs). `Feature::PeriodLockManage` is documented as 월마감 close authority.
- Generic object lifecycle FSM tables (`object_lifecycles`, transitions, rules — mig 0107), object code counters (0113), audit chain (0100/0101), authz feature matrix (`crates/platform/authz`).
- Registry `equipment_substitutions` = equipment 대차 (기계 대체) — **unrelated to personnel 대근**; do not reuse.

### DB substrate already present (platform/db/migrations)
- 0042 `site_attendance_events`, `site_geofence_presence`
- 0090 `attendance_direct_import_events`
- 0091 `employee_attendance_records` (append-only, RLS, idempotency) + `payroll_attendance_material_refs`
- 0092 absence/exit workflow tables
- 0074 payroll readiness (`payroll_draft_runs/lines`, `annual_leave_obligations`)
- 0107 `period_locks` + lifecycle engine

## 2. Genuinely missing domain state → NEW `backend/crates/attendance`

| Design need (design-spec §2–3) | Existing? | Decision |
|---|---|---|
| Attendance exception objects `AT-` (지각/미출근/무승인 연장/조퇴) with OPEN→RESOLVED and **mandatory-reason resolution** (OT additionally requires linked work scope) | ✗ (absence_alerts ≠ typed day exceptions; nothing stores resolutions) | NEW: `attendance_exceptions` + append-only `attendance_exception_resolutions` |
| Monthly close gate per entity(branch-scope)×month with server-recomputed preflight, attest, fail-closed on open exceptions, post-close retro amendments | ✗ (period_locks is the freeze mechanism, not the close object/evidence) | NEW: `attendance_month_closes` (+ append-only `attendance_close_amendments`); closing arms a payroll `period_lock` and stores its id |
| Personnel substitution (대근) assignments: gap × worker, date-keyed (future scheduling), AP-/contract linkage refs | ✗ | NEW: `attendance_substitutions` |
| Week-52 "근무 조정 요청됨" handled state (survives refresh) | ✗ | NEW: `attendance_week52_acks` (tiny; week totals themselves are derived reads, no table) |
| Week-52 weekly totals / projection | derivable from `employee_attendance_records` (+ plan OT) | Derived read endpoint in attendance/rest — no new state |
| Day board plan-vs-actual composition | plans (workorder) + records/summary (hr) + new exceptions/substitutions | Frontend composes existing reads + new reads; no new backend aggregate |

## 3. Gap manifest — belongs to OTHER owners (no code in this lane)

1. **platform/authz feature codes** (shared crate): add `ATTENDANCE_EXCEPTION_MANAGE`, `ATTENDANCE_SUBSTITUTION_MANAGE`, reuse `PeriodLockManage` as close authority and `EmployeeDirectoryRead` as the org-wide read tier; self reads ride the linked-employee floor (payroll/rest pattern). → integration-manifest.json `authzFeatures`.
2. **Router mount** (`backend/app` build_router touch) for the new attendance/rest router. → manifest `backendMounts`.
3. **openapi.yaml + regenerated clients** (`backend/openapi/**`, `clients/**`): new tag `attendance` (per-domain `tags:` mandatory — Kotlin client OOM regression otherwise), paths in design-contract §2. → manifest `openapi`.
4. **web shared roots**: `shell/nav.ts` already declares `{ screen: "attendance", labelKey: "console.shell.nav.attendance", icon: "clock" }` (급여·근태 group, ungated self-service floor) but `"attendance"` is **not** in `MOUNTED_SCREEN_KEYS` and has no `SCREEN_REGISTRY` entry; `console.shell.nav.attendance` key must exist in `web/src/i18n/ko.ts`. → manifest `webRegistry`.
5. **Migration number**: 0188 is provisional (repo head today = 0180; parallel lanes collide) — integrator renumbers to the next free number right before push.
6. **Cross-module effects deferred to their owners** (recorded as future integration, endpoints return refs only):
   - AP- approval object for substitutions / 교대 스왑 (appr/approvals owner) — attendance stores `approval_ref`.
   - 건별 근로계약 InboxDoc + passkey receipt (inbox crate owner) — attendance stores `contract_ref`.
   - wf3 automation OT→payroll exception propagation (workflow owner) — attendance emits the audit event + payroll material ref; rule wiring is automation's.
   - SLO breach notification + auto-resolution on assignment (notifications owner).
   - Payroll run calc blocking on incomplete closes (payroll owner reads `GET /api/v1/attendance/closes`).
   - WorkforcePool registry (people/workforce owner): until it exists, substitution worker = employee reference (non-regular employment statuses already exist on `employees`) + snapshot fields; pool-specific registry is a named gap, **not** faked.
7. **Not built in any lane yet (honest design gaps, from prototype-only affordances)**: cover-planner forward queue is a derived read (leave approvals × cover-mandatory positions × assignment state) — needs a "cover-mandatory position/team" attribute that today exists nowhere in the backend (prototype regexes job titles). Recorded as an ontology/HR gap; slice 1 derives it from a conservative job/team allowlist configured server-side, never client-side.

## 4. Frontend conventions (exemplar: `web/src/console/production/**`, read in full)

- **Files**: `index.ts` (exports Screen, Route, createApi, routeContract), `routeContract.ts` (`{ branchId: string }` + structural fixture, no business data), `xxxApi.ts` (`createXxxApi(api: ConsoleApiClient)` over `@maintenance/api-client-ts` `components["schemas"]`, `requireData` + typed `XxxApiError(status)`), `xxxCapabilities.ts` (pure projection: `deriveXxxCapabilities(gate: PolicyGate, branchId)` → boolean caps from feature codes), `useXxxConsoleAuthz.ts` (JWT-floor projection → authoritative `fetchAuthzProjection`, fail-closed while loading, `makePolicyGate`), `XxxConsoleRoute.tsx` (adapter: useAuth → capabilities → Screen), `XxxScreen.tsx` (props `{api, branchId, actorId, capabilities, sessionKey}`; **session-fence remount** via `key` composed of sessionKey:branchId:actorId:apiFenceKey:capabilityKey; generation counter + AbortController on every load/mutate; `canRead=false` → denied `role="status"` panel; loading/`role="alert"` error+retry/empty states; plain string className only), `xxx.css`, colocated `*.test.ts(x)`.
- **i18n**: module-owned strings file `web/src/i18n/attendance.ts` (Hangul lives there, never inline in components — check-ui-strings gate); nav label key goes through shared `ko.ts` (manifest).
- **Purity gate**: no cn/clsx in `web/src/console/**`; token colors only.
- **Registry entry shapes** (read-only capture): `SCREEN_REGISTRY: Record<MountedScreenKey, ComponentType>` maps key→Body component with **no props** (route contract applied inside the body via shell context); nav item `{ screen, labelKey, icon, gate? }`; exposure = `EXPOSED_SCREEN_KEYS` (ADR-0025, currently `["sales"]`) — attendance stays DARK/mounted-only.
