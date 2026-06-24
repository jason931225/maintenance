I have a comprehensive set of role-workflow audits. Let me synthesize the prioritized backlog directly from the provided JSON — no file exploration needed since the audits already carry exact locations.

# KNL Forklift-FSM Console — Prioritized Role-Workflow Improvement Backlog

## Part 1 — Highest-impact ergonomic wins for the highest-frequency roles

### A. 정비사 / MECHANIC — the mobile daily flow (most time saved per fix)
The mechanic runs the same loop dozens of times a day on a phone: get dispatched → navigate → diagnose → upload → report. Today every step has avoidable friction, and one step is fully broken.

1. **[BLOCKER] Build a work-order detail view — the diagnose→report loop is broken.** The mechanic diagnoses and writes the report without ever seeing the customer's reported symptom. `GET /api/v1/work-orders/{id}` (WorkOrderDetail: symptom, customer_request, status_history, evidence) is fully built backend-side but **never called by the web client**. Add route `/dispatch/:workOrderId` (or an expandable card) that fetches detail and shows symptom + customer_request + history + existing evidence; open start/report/EvidenceUpload from that context. *(`web/src/pages/DispatchPage.tsx`; `clients/ts` WorkOrderListItem:2897 vs WorkOrderDetail:2924)*

2. **[HIGH] Deep-link push → the exact order, auto-fill P1 accept.** Accepting a P1 emergency means hand-keying a UUID off the notification into a lookup box buried at the page bottom. Make the FCM push a deep-link (`/dispatch?dispatch=<id>`), auto-lookup, and hoist a pending-offer banner with inline 수락/거절 to the **top** of /dispatch. Add a backend "list my open dispatch offers" endpoint so offers render without any code entry. *(`web/src/features/dispatch/MechanicDispatchOffers.tsx:26-30`; `DispatchPage.tsx:438-444`)*

3. **[HIGH] Add a 길찾기 (directions) affordance.** Only a `tel:` link exists; the site address isn't even shown though sites are geocoded. Surface the address on the row and add a maps deep-link (`nmap:`/`comgooglemaps`/`geo:`) using the lat/lon already available. *(`web/src/features/dispatch/WorkOrderList.tsx:68-81`)*

4. **[MED] Collapse the triple render into a single "my work" queue.** /dispatch renders the same orders 3× (flat list + 6-col board + actions) — heavy phone scroll for a mechanic who only acts via WorkOrderActions. Default MECHANIC to their own assignment queue; board/full-list become a secondary tab. *(`DispatchPage.tsx:396-436`)*

5. **[MED] Make evidence attachable from detail, regardless of state + add retry.** EvidenceUpload only renders while ASSIGNED/IN_PROGRESS, so the AFTER/완료 proof category disappears after reporting. Surface it from the detail view; add per-item 재시도 on FAILED uploads + a progress indicator. Consider wiring the existing (unused) SyncBatch endpoint for offline tolerance. *(`WorkOrderActions.tsx:87-92,209-211`; `EvidenceUpload.tsx:74-98`)*

6. **[MED/LOW] Relabel the mechanic's "배정" button + neutral report default.** On a RECEIVED card the 배정 button silently performs claim-and-start (→IN_PROGRESS) for mechanics. Relabel to "내가 작업 시작" + add a one-line confirm. Default report result-type to an unselected option (today defaults COMPLETED, nudging over-reporting). Pre-select the lone-self mechanic in /daily-plan. *(`DispatchPage.tsx:106-126`; `WorkOrderActions.tsx:111-121`; `DailyPlanPage.tsx:65-83`)*

### B. 접수담당 / RECEPTIONIST — the intake + status-lookup flow
A call-handling role whose two dominant tasks (create intake, look up status for a caller) are both slow and lossy.

1. **[HIGH] Make caller callback number (정비문의) a first-class field.** The single most important call datum is stuffed into `customer_request` as bracket-text (`[정비문의: 010-…]`) — unsearchable, unvalidated, invisible to the mechanic (who sees a *different* master-data number). Add `contact_phone`, `requested_on`, `service_category` columns to CreateWorkOrderRequest + work_orders; surface contact_phone as a `tel:` link on the dispatch card. *(`IntakeForm.tsx:130-152`; `openapi.yaml` CreateWorkOrderRequest:4633)* — **shared fix with ADMIN intake.**

2. **[HIGH] Kill the intake dead-end.** On submit the form blanks and the returned `request_no`/order is **discarded** (`IntakePage.tsx:108-112`), so the receptionist can't read the number back to the caller. Show `request_no` in the success banner with a "작업지시 보기" deep-link to `/dispatch?wo={id}`, keep the equipment context.

3. **[HIGH] Add search to the read surfaces.** /dispatch is a flat 100-at-a-time scroll with no search by request_no/customer/호기 — the exact anti-pattern for "I'm calling about order 1234". Add a search/filter bar wired to existing list query params. *(`DispatchPage.tsx:52-66`; `WorkOrderList.tsx`)* — **shared fix with ADMIN.**

4. **[HIGH] Unstrand WorkOrderReadAll: read-only detail for non-managers.** Rows are openable only `isManager` (`onSelectWorkOrder` gated, `DispatchPage.tsx:411`), so the receptionist can't see assignee/ETA to answer "is someone coming?" despite holding the read entitlement. Provide a read-only detail drawer for any WorkOrderReadAll holder (no write controls).

5. **[MED] Duplicate/open-order awareness on lookup.** When the lookup resolves a known machine, also fetch+show any OPEN work orders for it ("진행 중 작업지시 1건 — #R-1234") to prevent duplicate intakes. *(`IntakePage.tsx:32-62`; `IntakeForm.tsx:350-417`)*

6. **[MED] Symptom quick-pick chips + promote 서비스 분류.** Add tappable common-fault chips (시동불량/유압누유/주행이상/포크작동불량) and make 서비스 분류 a real column. *(`IntakeForm.tsx:229-302`)*

---

## Part 2 — Cross-role themes (recurring friction + shared fixes)

| Theme | Roles hit | Shared fix |
|---|---|---|
| **No work-order detail route / no deep-linking** (`/work-orders/:id` doesn't exist) | MECHANIC, RECEPTIONIST, ADMIN, SUPER_ADMIN | Add a work-order detail route; link `request_no` everywhere; support `?wo={id}`. Single fix unblocks diagnose-loop, status-lookup, approvals review, and intake→order handoff. |
| **Scroll-not-search** (flat 100–200 row lists, no search/filter/sort) | RECEPTIONIST, ADMIN, SUPER_ADMIN (users table), EXECUTIVE | Add search/filter bars wired to existing query params; add server-side total/offset where capped (users @200, dispatch @100). |
| **Reviewer/approver acts BLIND** (approves without seeing the content) | ADMIN/SUPER_ADMIN approvals (no diagnosis/evidence), EXECUTIVE integrity (names 403 → 미상) | Render the report/evidence inline before approve/reject; embed display names server-side or open a minimal name-lookup to entitled readers. |
| **No work-queue for a role's flagship action** (UUID-paste only) | EXECUTIVE + SUPER_ADMIN purchase final-approve; ADMIN/EXECUTIVE P1 escalations | Add list endpoints + "pending my approval"/"escalated P1" queues that render on load. |
| **Select-then-act split across two scroll regions** | ADMIN/SUPER_ADMIN dispatch, approvals | Move controls into a drawer/popover anchored to the selected card (Users page already uses the drawer pattern). |
| **Destructive/irreversible action under-guarded** | SUPER_ADMIN (elevated-role grant, hard-remove), EXECUTIVE/SUPER_ADMIN (final approve no confirm), PLATFORM (hard-remove inline) | Confirm dialogs restating consequences; type-to-confirm for org deletes; segregate elevated grants. |
| **Branch context is weak** (hard-pinned `branches[0]`, chip shows UUID tail) | RECEPTIONIST, ADMIN, SUPER_ADMIN | Make Topbar BranchChip a real switcher showing branch **name**; let OTP/intake choose among branches. |
| **403 indistinguishable from failure** (generic red PageError + futile Retry) | MEMBER especially; all roles on any denial | Thread HTTP status into PageError; for 403 show permission message, hide Retry. |
| **No nav badges / status-at-a-glance** (pending approvals, escalations, OPEN findings) | ADMIN, EXECUTIVE, SUPER_ADMIN | Pending-count badges on nav items (financial, approvals) + integrity OPEN counts. |

---

## Part 3 — Per-role fixes by severity

### ADMIN (관리자)
- **[BLOCKER]** Approval queue shows only request_no + 3 badges — no diagnosis/action_taken/result_type/evidence. Render the report + evidence thumbnails per item before approve/reject. *(`ApprovalQueue.tsx`)*
- **[HIGH]** Dispatch select-then-act split → side drawer/popover. *(`DispatchPage.tsx`)* · No board search/filter/sort → filter bar wired to query params. · Shared reject-memo textarea at top of queue → **per-order** reject dialog (today can reject order B with order A's memo). *(`ApprovalQueue.tsx`)*
- **[HIGH]** **No customer/site CREATE path** — customers/sites only exist via .xlsx import or public intake. Add a Customers/Sites admin surface (today PATCH-only). *(`SitesPage.tsx`, `SiteGeographyPanel.tsx`)*
- **[HIGH]** No P1 escalation queue → add pending/escalated list coupled to one-click force-assign. *(`MechanicDispatchOffers.tsx`)*
- **[MED]** Board mutations refetch the whole board, no optimistic update / per-card busy state → optimistic + card-attached feedback. · Card-level quick-assign self-assigns the admin → hide/relabel for managers. · Org delete fails late (409 only after confirm) → annotate Delete with dependent count, block upfront. *(`OrgPage.tsx`)* · Import shows only error **count**, not `report.errors[]` rows → render per-row errors; add template download + dry-run. *(`EquipmentImportPanel.tsx`)* · Equipment manage is search-only → deep-link browse rows into manage. · Daily-plan shows one plan at a time → add a daily roster view across mechanics.
- **[LOW]** Financial tabs not URL-synced + no pending badges. · Users: create→OTP requires hunting the new row → auto-open Issue-OTP after create.

### EXECUTIVE (임원)
- **[BLOCKER]** Final purchase approval (EXECUTIVE-exclusive) has **no discovery path** — panel starts empty, no list endpoint, requires pasted UUID. Add `GET …/purchase-requests?status=EXECUTIVE_PENDING` + "pending my approval" queue. *(`PurchaseRequestPanel.tsx`; `financial/rest/src/lib.rs`)*
- **[HIGH]** Integrity page (EXECUTIVE-only) **can't resolve any name** — its `/api/v1/users` call 403s (UserManage denied) so every subject/approver = 미상; CI is green only because the test mocks users→200. Embed display names in the finding payload or add a minimal name-lookup for IntegrityFindingsRead holders; fix the test to assert the 403 path. *(`IntegrityPage.tsx:107-126`)*
- **[HIGH]** **Granted-but-unreachable**: EXECUTIVE holds RegionManage/BranchManage (Allow) but /settings/org is ADMIN-gated in nav + router. Reconcile: gate org by a role set including EXECUTIVE, **or** downgrade the matrix cells to Deny. *(`nav.ts:112`; `AppRouter.tsx:231,237`; `authz/src/lib.rs:221-222`)*
- **[HIGH]** No approval inbox/badge/push for EXECUTIVE_PENDING.
- **[MED]** Final approve fires on one unconfirmed click → ConfirmDialog restating vendor + ₩amount. · KPI period is a regex free-text input (no date picker/presets) → native date inputs + 이번 달/지난 달/분기 presets; add prior-period deltas + Excel export (entitlement already held); deep-link metrics into filtered /dispatch.

### SUPER_ADMIN (최고관리자)
- **[BLOCKER]** Same purchase-approval no-queue blocker as EXECUTIVE.
- **[HIGH]** Elevated-role grant (incl. minting another SUPER_ADMIN via exclusive ElevatedRoleGrant) is a flat checkbox beside MECHANIC — **least friction on the most sensitive action**. Split standard vs elevated group + ConfirmDialog naming role+user. *(`UsersPage.tsx` roles fieldset; `org-format.ts` ASSIGNABLE_ROLES)*
- **[HIGH]** Provisioning is a broken two-beat (create → hunt OTP in ⋯ menu, though it's the mandatory next step) → promote a primary "OTP 발급" on the new row or auto-open the dialog. · User table doesn't scale (no search, 200 cap, no total/offset) → add filter box now + server-side search.
- **[MED]** OTP always binds `branch_ids[0]` with no chooser → add branch Select when >1. · Two parallel OTP surfaces (UsersPage vs AdminSettingsPage) → consolidate. · Final-approve no confirm. · Integrity finding → no deep-link to the referenced purchase request.
- **[MED/LOW]** OrgPage delete is actually soft-deactivation (migration 0047) but labeled 삭제 with no "show inactive"/재활성화 → rename to 비활성화 + add inactive toggle (mirror Users). · Branch creation resets parent region each time → keep last region selected.

### MEMBER (구성원) — **incoherent / dead role**
- **[BLOCKER]** Lands on /dispatch which 403s → generic "load failed/retry". Detect empty/`['MEMBER']` roles and route to a `/pending` page ("계정이 생성되었습니다 — 관리자 승인 대기"). *(`OnboardingPage.tsx:44`, `LoginPage.tsx:19`, `ProtectedRoute.tsx`)*
- **[BLOCKER]** Nav advertises ~10 destinations that all 403 (MEMBER absent from the ROLES map; "ungated" = shown to any authenticated role). Add MEMBER to ROLES map; default-deny so only Profile shows. *(`nav.ts:32-38,100-138`)*
- **[HIGH]** /intake renders a full fillable form with no gate → fails only on submit. Hide from MEMBER or render disabled with a permission notice. *(`IntakePage.tsx`)* · 403 collapses into futile Retry → distinguish authz from transient. · Topbar shows raw user_id UUID, never the role → show display_name + role chip + pending badge. *(`Topbar.tsx:96`)*
- **[LOW]** Profile works — add a one-line helper under the 일반 멤버 badge explaining the waiting state. *(`ProfilePage.tsx:133-145`)*

### PLATFORM_SUPER_ADMIN (플랫폼 — vendor tier)
- **[HIGH]** One-shot onboarding OTP with **no re-issue path** → lost/expired = bricked tenant (recovery = delete+re-onboard or DB). Add `POST …/orgs/{id}/admin-otp` (revoke unredeemed + reissue, audited); surface `admin_otp_expires_at` (already returned, unused). *(`PlatformOnboardPage.tsx`; `provisioning/src/lib.rs:764`)*
- **[MED]** No admin contact captured (display_name hardcoded "Tenant Admin") → add optional email/phone, persist + echo on success card. · Ops health table is unsortable/unsearchable; the key idle signal `last_activity_at` can't be sorted → add sort/filter/search + idle highlight. · Ops (detect) and Tenants (act) are unlinked → make ops rows actionable or deep-link `/platform/tenants?focus={id}`.
- **[MED/LOW]** Hard-remove rendered inline on every row, visually identical to reversible Archive, plain confirm → move to danger-zone + type-the-slug-to-confirm; differentiate Suspend/Archive/Remove dialog copy. · View-as always lands /dispatch, defaults ADMIN, 30-min hard expiry silently bounces operator, hidden on suspended tenants → accept optional target path, persist last role, show countdown + extend, allow read-only view-as on suspended.

---

## Part 4 — Incoherent access, missing workflows, top FSM best-practice gaps

**Incoherent / dead access**
- **MEMBER** — default-deny on every Feature but Login, yet nav advertises ~10 dead links and default-lands on a 403 screen. The frontend nav and backend authz matrix are out of sync.
- **EXECUTIVE org-structure** — holds RegionManage/BranchManage but has no UI path (ADMIN-gated nav+router). A granted permission with no surface; authz and UI contradict.
- **EXECUTIVE integrity names** — the page's entire purpose (who self-approved) renders 미상 because its name-lookup 403s for the only role allowed on the page.

**Missing workflows a role needs but can't do**
- Mechanic cannot see the reported symptom (no detail fetch). Receptionist/admin cannot read back a request_no or open an order they're entitled to read. Admin cannot create a customer/site. Executive & Super-Admin cannot discover purchase requests awaiting their approval. Admin/Executive cannot find an escalated P1 without its UUID.

**Top best-practice gaps vs industry FSM tools**
- Search-first dispatch boards (we have scroll-only). · Deep-linkable/shareable work orders (none exist). · Reviewer sees the work + evidence before approving (we approve blind). · Mobile field tech gets symptom + one-tap navigation (we give neither). · Approval inbox with badges/notifications (pull-only via UUID). · Optimistic updates with per-item busy/error state (full-board refetch + global banner). · Type-to-confirm + privileged-action segregation for destructive/elevated ops.

---

## Part 5 — TOP 15 highest-impact improvements to do first

1. **Work-order detail view + `/work-orders/:id` route** wiring the existing `GET /api/v1/work-orders/{id}` — unblocks the mechanic diagnose→report **blocker** and gives receptionist/admin a readable order. *(highest leverage; one fix, four roles)*
2. **Approval queue shows the report + evidence** before approve/reject — fixes the ADMIN/SUPER_ADMIN **blind-approval blocker**.
3. **Purchase-request "pending my approval" list + endpoint** (`status=EXECUTIVE_PENDING`) — fixes the EXECUTIVE & SUPER_ADMIN flagship-action **blocker**.
4. **MEMBER landing + nav fix** — route empty/MEMBER roles to `/pending`, add MEMBER to ROLES map, default-deny nav — fixes the dead-role **blocker**.
5. **Search/filter bar on /dispatch** wired to existing query params — kills scroll-not-search for receptionist + admin.
6. **First-class `contact_phone` / `requested_on` / `service_category`** on CreateWorkOrderRequest + work_orders; surface contact_phone as `tel:` on dispatch — fixes lossy intake (receptionist + admin).
7. **Intake success → request_no + deep-link** instead of blank reset (`IntakePage.tsx:108-112`).
8. **P1 push deep-link + top-of-page pending-offer banner** + "list my open offers" endpoint — mechanic emergency accept and admin escalation queue.
9. **길찾기 directions deep-link + show site address** on the work-order row (`WorkOrderList.tsx`).
10. **Read-only WO detail drawer for any WorkOrderReadAll holder** — unstrand the receptionist (`DispatchPage.tsx:411`).
11. **Fix EXECUTIVE integrity names** — embed display names server-side (or minimal lookup) + correct the misleading test (`IntegrityPage.tsx`).
12. **Reconcile EXECUTIVE org-structure authz** — grant a route or downgrade the matrix cells so policy and UI agree.
13. **Segregate + confirm elevated-role grants** (split standard/elevated group + ConfirmDialog) — SUPER_ADMIN security hardening.
14. **Onboarding OTP re-issue endpoint + expiry display** — remove the platform "bricked tenant" trap.
15. **403-aware PageError** (status threaded, permission message, no futile Retry) — cross-role clarity, biggest cheap win for MEMBER and any denial.

*Sequencing note:* items 1, 5, and 10 share the same detail-view/list-query infrastructure — build that foundation first; items 2 and 3 then reuse the detail-fetch pattern; items 4 and 15 are a small paired front-end change that should ship together.