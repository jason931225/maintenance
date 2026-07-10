# LEGACY-PARITY-BACKLOG — superset register (legacy console → Oyatie console)

> **Goal (founder, 2026-07-09):** the finished console is the **superset** of planned features/capabilities of BOTH generations. The Oyatie design is the sole UI/UX authority; nothing below is ported as-is — each capability is **re-expressed in the Oyatie grammar** (typed objects with codes and chains, pin-panel details, token grammar, PBAC-gated rendering deny-by-omission, audit-everywhere, §3.9 lifecycle), preserving the philosophy: intuitive · seamless integration · object-oriented · self-explanatory (no explanatory copy, §4-12).
>
> **How this file is used:** it is a **merge-gate input** for every UI milestone (a milestone that replaces a legacy route must cover or explicitly defer that route's items here) and a **hard checklist for the AppShell-deletion endgame** — no legacy route is deleted while it is the only carrier of an item below. Source inventory: full sweep of `web/src/AppRouter.tsx` routes vs the design surface (2026-07-09). Evidence file:line refs are in the sweep report; keep them current when routes move.
>
> Register status legend: ⛔ UNCOVERED (no design surface) · ◐ PARTIAL (domain covered, capability missing) · ✅ scheduled (named milestone/charter owns it).
> Audit legend: ✅ SHIPPED (Oyatie console now carries the full capability) · 🟨 PARTIAL (some Oyatie primitives exist; legacy route is still a carrier) · ⛔ OPEN (no deletion-safe Oyatie carrier found) · ⚪ DESCOPED/FOLDED (founder/design decision removes or folds the standalone route obligation).

## Living deletion-readiness checklist (audit 2026-07-09T21:43:34Z)

Evidence basis for this audit:
- The founder gate for this file is unchanged: the finished console must be the superset of both generations, expressed through the Oyatie grammar, and legacy routes may not be deleted while they are the only carrier of an item (`LEGACY-PARITY-BACKLOG.md:3-5`).
- Offline design authority comes from the synced markdowns and change log; the sync manifest says `web/src/**` is implementation truth and this directory's fresh markdowns are design authority, with `AGENTS.md` as the current design delta record (`SYNC-MANIFEST.md:26-29`). The large desktop `Oyatie Console.dc.html` is intentionally stale/missing from the second-pass mirror; post-Jul-4 desktop console evidence is therefore taken from `AGENTS.md`/`ROADMAP.md` (`SYNC-MANIFEST.md:14-18`).
- Legacy route carriers are still present under `/platform/*` and the AppShell routes (`web/src/AppRouter.tsx:281-418`). A row is deletion-ready only when the Oyatie console carries the full capability or the founder/design decision explicitly removes/folds the obligation.

| # | Audit state | Evidence | Remaining gap / deletion note |
|---|---|---|---|
| 1 | ⛔ OPEN — not deletion-ready | Oyatie has Person/PEOPLE, directory/policy/candidate-to-employee primitives (`AGENTS.md:53`, `AGENTS.md:55`, `AGENTS.md:57`, `AGENTS.md:121`), but no shipped Identity Console charter. Legacy `/settings/users` and `/settings/security` remain (`web/src/AppRouter.tsx:412-418`). | Still missing the full operations-only identity admin path: user CRUD/deactivate, multi-role + multi-branch scope assignment, user↔employee linking, admin sign-in OTP issuance, passkey wipe/re-OTP credential reset. |
| 2 | ✅ SHIPPED — coverage exists; cutover criteria still apply | The carbon-copy console source owns a first-login flow under `web/src/console/identity`: versioned KR/PIPA consent object (`web/src/console/identity/useFirstLoginFlow.ts:16`, `web/src/console/identity/useFirstLoginFlow.ts:37-58`), consent-before-enrollment UI (`web/src/console/identity/FirstLoginOnboarding.tsx:75-145`), platform passkey enrollment (`web/src/console/identity/useFirstLoginFlow.ts:221-236`), phone-QR/OTP enrollment (`web/src/console/identity/PasskeyEnrollmentPanel.tsx:86-185`, `web/src/console/identity/useFirstLoginFlow.ts:238-256`), and desktop approval polling (`web/src/console/identity/useFirstLoginFlow.ts:261-286`). Tests cover PIPA, platform passkey, phone QR, and deny-by-omission affordances (`web/src/console/identity/FirstLoginOnboarding.test.tsx:106-273`). Legacy `/onboarding` still mounts the route during rollout (`web/src/AppRouter.tsx:250-263`). | Capability coverage is green for the checklist, but deletion/cutover still depends on the D5 route-smoke/fidelity/adoption gates; do not remove the route merely because the component exists. |
| 3 | 🟨 PARTIAL — not deletion-ready | Self/inbox passkey viewing and candidate/legal-document receipt are present (`AGENTS.md:20`, `AGENTS.md:121`); legacy profile route remains (`web/src/AppRouter.tsx:383-388`). | Still missing self-service passkey list/register/revoke with last-credential guard plus self name/phone edit in the Oyatie self-card grammar. |
| 4 | 🟨 PARTIAL — not deletion-ready | Lifecycle/settlement primitives exist: org lifecycle preflight names payroll/4대보험/퇴직 settlement gates (`AGENTS.md:47`), the generic lifecycle engine is shipped (`AGENTS.md:69`), and payroll run series exists (`AGENTS.md:115`). Legacy payroll/insurance carriers remain (`web/src/AppRouter.tsx:380-395`). | Still missing an Oyatie exit-case chain with social-insurance acquisition/loss + EDI readiness, severance draft/submit, and 퇴직금 calculation. |
| 5 | ⛔ OPEN — not deletion-ready | Oyatie shipped view-as personas only (`AGENTS.md:93`). The vendor operator console is still a separate legacy `/platform/*` shell with tenants/groups/ops/onboard/account routes (`web/src/AppRouter.tsx:281-301`). | Founder/product decision remains unresolved: separate operator program vs operator-scoped module. Tenant provision/activate/suspend/archive/erase, group/org assignment, bootstrap/group-account OTP, cross-tenant health, and audited view-as tenant must outlive tenant-console deletion until built/decided. |
| 6 | 🟨 PARTIAL — not deletion-ready | Dispatch screen with WO queue × candidates × SLA and process-panel linkage shipped (`AGENTS.md:77`); SLA kanban lanes and map round-trip shipped (`AGENTS.md:113`, `AGENTS.md:79`). Legacy dispatch routes remain (`web/src/AppRouter.tsx:314-322`). | Still missing P1 broadcast/offers accept-decline, policy-gated force assign with reason, multi-mechanic roles, review-gated target-due change, and outsource-work record. |
| 7 | 🟨 PARTIAL — not deletion-ready | Operations map with site markers, unit layer, queue panels, edit/right-click actions shipped (`AGENTS.md:79`, `AGENTS.md:89`). Legacy map/location settings routes remain (`web/src/AppRouter.tsx:320-322`, `web/src/AppRouter.tsx:388-390`). | Still missing arrival/departure event feed, directions handoff, ungeocoded-site worklist, and per-branch GPS/PIPA consent objects. |
| 8 | 🟨 PARTIAL — not deletion-ready | Maintenance/asset module surfaces and series objects exist, including inspection-style series (`AGENTS.md:53`, `AGENTS.md:71`); legacy inspection route remains (`web/src/AppRouter.tsx:409-410`). | Still missing PM schedule CRUD with cycle presets/intervals, overdue detection, and checklist round completion. |
| 9 | 🟨 PARTIAL — not deletion-ready | Generic lifecycle engine and My Work aggregation shipped (`AGENTS.md:69`, `AGENTS.md:77`); legacy daily-plan route remains (`web/src/AppRouter.tsx:326-328`). | Still missing a daily-plan object with DRAFT→REQUESTED→APPROVED→confirmed review, branch queue, and absence/exit warning panel. |
| 10 | 🟨 PARTIAL — not deletion-ready | Field/CS module, comms surfaces, and SLA lanes are present (`AGENTS.md:53`, `AGENTS.md:61-65`, `AGENTS.md:113`); legacy support route remains (`web/src/AppRouter.tsx:354-356`). | Still missing support-ticket console depth: CS-threaded replies, internal notes, self-assign/claim, and live SLA command-center clocks. |
| 11 | 🟨 PARTIAL — not deletion-ready | Audit stream, anomalies, compliance/control evidence matrix, and policy links exist (`AGENTS.md:34`, `AGENTS.md:87`, `AGENTS.md:115`); legacy integrity route remains (`web/src/AppRouter.tsx:339-344`). | Still missing detector finding objects with REVIEWED/DISMISSED/ESCALATED triage lifecycle and mandatory memo. |
| 12 | 🟨 PARTIAL — not deletion-ready | Cedar policy no-code canvas, simulation, view-as deny-by-omission, and type schema editing are shipped (`AGENTS.md:55`, `AGENTS.md:93`, `AGENTS.md:121`); legacy policy route remains (`web/src/AppRouter.tsx:399-401`). | Still missing the full assignment planner: mandatory impact-preview receipt gate, role status preview→confirm, custom-role CRUD, and 16-attribute editor reconciled with Cedar/PBAC. |
| 13 | 🟨 PARTIAL — not deletion-ready | Automation no-code blocks, workflow edit/archive, pending-revision lifecycle, and n8n-style run log shipped (`AGENTS.md:50`, `AGENTS.md:77`, `AGENTS.md:81`, `AGENTS.md:113`); legacy workflow route remains (`web/src/AppRouter.tsx:399-401`). | Still missing clone, visual DAG canvas validation, node-level fallback-role/SLA/step-up config, and connector catalog. |
| 14 | 🟨 PARTIAL — not deletion-ready | Asset module, asset lifecycle display, ontology graph merge, and deterministic ingest pipeline are present (`AGENTS.md:53`, `AGENTS.md:101`, `AGENTS.md:71`, `AGENTS.md:38-39`). Legacy equipment routes remain (`web/src/AppRouter.tsx:357-375`). | Still missing management-no lookup/resolve, bulk XLSX master import with dry-run diagnostics, owner-org cross-context, and equipment substitution assign/return. |
| 15 | 🟨 PARTIAL — not deletion-ready | Recruiting can create employee/Person objects, workforce surface exists, and deterministic ingest/lifecycle primitives are present (`AGENTS.md:57`, `AGENTS.md:121`, `AGENTS.md:38-39`, `AGENTS.md:69`). Legacy employee/HR carriers remain (`web/src/AppRouter.tsx:391-395`). | Still missing employee + attendance import with dry-run diagnostics, identity-resolution merge, lifecycle events, and Korean 4-item sign-off checklist. |
| 16 | 🟨 PARTIAL — not deletion-ready | Messenger/mail/board/directory surfaces are shipped (`AGENTS.md:53`, `AGENTS.md:61-65`, `AGENTS.md:103`); legacy collaboration route remains (`web/src/AppRouter.tsx:329-331`). | Still missing unified cross-object 7-day calendar plus scoped polls/voting objects. |
| 17 | 🟨 PARTIAL — not deletion-ready | Field/maintenance/dispatch/map primitives are shipped (`AGENTS.md:53`, `AGENTS.md:77`, `AGENTS.md:79`); legacy intake route remains (`web/src/AppRouter.tsx:323-325`). | Still missing equipment-code lookup that resolves customer/site and auto-attaches branch chips. |
| 18 | 🟨 PARTIAL — not deletion-ready | Finance module surface is shipped (`AGENTS.md:53`); legacy financial route remains (`web/src/AppRouter.tsx:377-379`). | Rental quote objects linked to the C- chain are not evidenced in the Oyatie console audit sources. |
| 19 | ⚪ FOLDED/CONDITIONAL | Design already folds exports into egress-gated module actions: mail egress gate (`AGENTS.md:50`) and file-as-boundary/egress treatment (`AGENTS.md:59`, `AGENTS.md:71`). Legacy reporting route remains (`web/src/AppRouter.tsx:345-347`). | No standalone export farm should be rebuilt. Delete `/reporting` only after a per-module export inventory confirms every needed export is covered by egress-gated actions. |
| 20 | 🟨 PARTIAL — not deletion-ready | Dashboard v1 and operations map/dashboard primitives are shipped (`AGENTS.md:50`, `AGENTS.md:79`, `AGENTS.md:113`); shell-less `/wallboard` route remains (`web/src/AppRouter.tsx:246-248`). | Still missing kiosk/no-chrome auto-rotate wallboard preset. |
| 21 | 🟨 PARTIAL — not deletion-ready | View-as personas, PBAC/nav deny-by-omission, and dashboard scope controls exist (`AGENTS.md:93`, `AGENTS.md:113`). Legacy group-admin route remains (`web/src/AppRouter.tsx:396-398`). | Still missing enter-subsidiary MANAGE context, per-group health, and DoA/policy-gated manage-context switch. |
| 22 | ⚪ DESCOPED FROM TENANT CONSOLE — retain sales program route | Item text below records sales #6 as a separate program. Current public storefront and catalog-admin routes are separate from the tenant console (`web/src/AppRouter.tsx:223-240`, `web/src/AppRouter.tsx:403-405`), and catalog is sales-gated (`web/src/components/shell/nav.ts:243-245`). | Do not delete with AppShell wholesale cleanup; migrate/retire through the separate sales/storefront program. |
| 23 | 🟨 SPLIT — not wholesale deletion-ready | Self-profile remains a legacy route (`web/src/AppRouter.tsx:383-388`) and inherits item 3. Operations Intelligence can be folded into dashboard insights: dashboard v1, insight objects, as-of/scope, and payrun series are shipped (`AGENTS.md:50`, `AGENTS.md:71`, `AGENTS.md:113`, `AGENTS.md:115`). Legacy intelligence route remains (`web/src/AppRouter.tsx:332-337`). | Self-profile cannot be deleted until item 3 ships. The standalone intelligence launchpad can be retired only after dashboard-insight acceptance proves every kept action is reachable there. |

Audit rollup: Tier 1 remains deletion-blocked by identity/admin, self-service credential, offboarding, and operator-console gaps (items 1, 3, 4, 5). Item 2 has a console implementation and tests, but still waits for the broader D5 rollout/fidelity/adoption gates before route removal. Most Tier 2/Tier 3 rows have usable Oyatie primitives but are still partial, so the legacy route remains the source of truth for the named depth until the gap is explicitly shipped or descoped. Only item 22 is explicitly outside the tenant-console program; item 19 and part of item 23 are folded, but still require route-specific acceptance before deletion.

## Tier 1 — blocks core operation (none scheduled in plan §3 unless noted)

### 1. ⛔ Identity & credential administration (`/settings/users`, `/settings/security`)
Capability: user CRUD + deactivate, multi-role assignment, multi-branch scope, user↔employee linking, **sign-in OTP issuance**, **credential reset** (passkey wipe + re-OTP). This is the mandated "operations through console only" provisioning/recovery path.
Oyatie re-expression: Account/Person as first-class objects (BE-OBJ resolve + cards); role/scope changes = policy-evaluated mutations with audit chips (roles = principal attributes per the PBAC direction, so assignment UI converges with the policy screen); OTP issuance & credential reset = **audited action objects** with step-up (passkey) + reason, surfaced as single CTAs on the person card — never a settings-form farm. → **Needs charter: `UI-M13 Identity Console`** (pairs with Cedar promotion).

### 2. ⛔ First-sign-in onboarding (`/onboarding`)
Capability: versioned PIPA consent gate, platform-authenticator passkey enrollment, phone-QR enrollment, desktop QR-login approval.
Oyatie re-expression: Consent = versioned object (ties into the multi-jurisdiction PII backlog); enrollment = guided first-login flow reusing the M5 passkey ceremony components; QR approval = notification-center action. → **Needs charter (rides the Identity Console charter).**

### 3. ⛔ Self-service credential management (`ProfilePage`/`SecurityPanel`)
Capability: list/register/revoke own passkeys (step-up + phone-QR), last-credential guard; self name/phone edit.
Oyatie re-expression: passkey = object with lifecycle on the self card (셀프서비스 zone, §4.8); revoke = guarded transition; profile edit = §3.9.0 whitelist ① (self-owned draft-direct). → **Identity Console charter.**

### 4. ⛔ 4대보험 & offboarding settlement (`/hr/insurance`, parts of `PayrollPage`)
Capability: social-insurance acquisition/loss classification + EDI readiness; exit-case workflow (현장 report → HR confirm → HQ confirm); severance draft/submit + 퇴직금 calculation. **Korean legal payroll obligation.**
Oyatie re-expression: exit case = lifecycle object chain (person → exit event object → settlement gates per §3.9.1 참조무결성/법정 정산 — the design's own governance model already demands this); severance = AP- template on the engine with structured fields; EDI readiness = compliance CP- rows whose evidence = the working exit objects. → **Needs charter: extends UI-M8(pay)/UI-M9(hr); schedule before their legacy routes retire.**

### 5. ⛔ Vendor multi-tenant operator console (`/platform/*`)
Capability: tenant provision/activate/suspend/archive + guarded force-erase, group CRUD + org assignment, bootstrap/group-account OTP issuance, cross-tenant ops health, read-only impersonation (view-as tenant).
Oyatie re-expression: a distinct **operator persona/surface**, not the tenant console — but it can (and should) reuse the Oyatie grammar (tenant = object with lifecycle; suspend/erase = gated transitions with impact pre-check; impersonation = audited view-as, the design already has view-as grammar). → **Decision needed:** separate operator program vs. operator-scoped module. Until decided + built, **the `/platform/*` legacy routes must outlive tenant-console replacement.**

## Tier 2 — operational depth on covered domains

### 6. ◐ Dispatch depth (`DispatchPage`)
P1 auto-dispatch broadcast + mechanic offer accept/decline; force-assign escalated P1 (policy-gated override + reason); multi-mechanic roles; target-due change (review-gated); outsource-work record. → Extend design `dispatch` screen; offers ride the notification center (M2b) as actionable rows; force-assign = §3.10 override (사유+승인+감사). Owner: **dispatch-depth slice after UI-M3** (also consumes BE-AUTO triggers).

### 7. ◐/⛔ Location tracking & consent (`DispatchMapPage`, `/settings/location`)
Mechanic arrival/departure event feed, directions handoff, ungeocoded-site worklist; per-branch GPS-consent (PIPA).
→ map screen unit layer (design `map` already has units) + events-as-objects timeline; consent = jurisdiction/consent objects (PII program); geo data gated by deviceCtx policy. Owner: **map-depth slice; consent rides the PII charter.**

### 8. ◐ Preventive inspection (`InspectionPage`)
PM schedule CRUD (cycle presets → interval, overdue detection), checklist round completion.
→ This is literally design §4-15 (series SR- objects: 정기 검진) + §3.10 checklist objects; schedules ride **BE-AUTO** cron substrate. Owner: **maintenance-module slice.**

### 9. ◐ Daily plan lifecycle (`DailyPlanPage`)
Mechanic daily-plan object, DRAFT→REQUESTED→APPROVED→confirmed review, branch queue; absence/exit warning panel.
→ plan = JL--adjacent object on the generic lifecycle engine (**BE-LC**); surfaces in overview Today/Plan (UI-M3) + approval via engine. Owner: **UI-M3 follow-on slice.**

### 10. ◐ Support ticket console depth (`SupportPage`)
CS- threaded replies + internal notes, self-assign/claim, SLA command center (live clocks).
→ field/CS- module: thread = comm object (comms backbone), claim = assignment action, SLA = chips + map overlay. Owner: **field-module slice.**

### 11. ◐ Integrity findings triage (`IntegrityPage`)
Detector findings (self-approval, price-outlier) with triage lifecycle REVIEWED/DISMISSED/ESCALATED + mandatory memo.
→ detective-controls queue (§3.10-⑥): finding = object linked to its evidence chain (the SoD guard now emits `anomaly.self_approval` findings — this queue is its UI); triage transitions audited. Owner: **UI-M10 (audit) extension.**

### 12. ◐ Policy authoring depth (`PolicyStudioPage`)
Assignment planner with mandatory impact-preview receipt gate; role status preview→confirm; custom-role CRUD; 16-attribute editor.
→ reconcile FIRST with the PBAC direction (roles = principal attributes; policies own behavior): impact-preview = §3.9.1 사전점검 on policy objects; keep the receipt-gate pattern (it's the reference impl of impact pre-check). Owner: **UI-M11 + Cedar promotion charter.**

### 13. ◐ Workflow-studio depth (`WorkflowStudioPage`)
Version rollback, clone, visual DAG canvas + validation, node-level config (fallback-role/SLA/step-up), connector catalog.
→ rollback/clone ride **BE-LC** generic versioning; canvas = no-code block grammar (design `auto`); node config = engine definition schema. Owner: **UI-M11 + BE-AUTO.**

### 14. ◐ Asset-module depth (`Equipment*`)
Management-no lookup (resolve by code — now **BE-OBJ resolve**), bulk xlsx master import, owner-org cross-context, equipment substitution assign/return.
→ import = ingest pipeline (DX- with dry-run = validation stage); substitution = Substitution object (design has it for people; equipment variant). Owner: **asset-module slice.**

### 15. ◐ HR import + lifecycle depth (`EmployeesPage`)
Employee/attendance xlsx import with dry-run diagnostics; identity-resolution merge; lifecycle events + Korean 4-item sign-off checklist.
→ imports = ingest DX- (design §4-13: file은 경계 포맷); merge = review step objects; sign-off = §3.10 checklist attestation. Owner: **UI-M9 extension.**

### 16. ⛔ Collaboration surfaces (`CollaborationPage`)
Unified cross-object 7-day calendar; scoped polls + voting.
→ calendar = date-objects + `object_links` traversal (BE-OBJ shipped the edge store); polls = scoped objects with vote actions + result chips. Owner: **needs a small slice after M2b/M3** (calendar feeds overview Today/Plan).

### 17. ◐ WO intake depth (`IntakePage`) — equipment code lookup resolving customer/site + branch auto-attach → BE-OBJ resolve + auto-linked chips. Owner: **dispatch/field slice.**
### 18. ◐ Rental-quote workspace (`FinancialPage`) — quote objects in finance module linked to C- chain. Owner: **finance-module slice.**
### 19. ◐ Reporting export hub (`ReportingPage`) — consolidated exports become **egress-gated** export actions (§3.10-⑤) per module; no standalone export farm. Owner: **dashboard-depth slice.**
### 20. ⛔ Shop-floor wallboard (`WallBoardPage`) — kiosk auto-rotate KPI/SLA display → display-only preset of design `dashboard`/`map` (workspace preset, no chrome). Owner: **dashboard-depth slice.**
### 21. ◐ Group-admin console (`GroupAdminPage`) — enter-subsidiary MANAGE context + per-group health → scope-switcher gains policy-gated manage context (전결/DoA); health = dashboard rows. Owner: **Identity Console charter.**
### 22. ⛔ Storefront catalog admin (`CatalogAdminPage`) — sales-listing CRUD + sales-inquiry pipeline. **Separate program (sales #6)**; recorded here only so its legacy routes are not deleted with AppShell.
### 23. ◐ Low priority — self-profile editor (covered in item 3); decision-intelligence launchpad (`OperationsIntelligencePage`) → fold into dashboard insights (AN-) if kept at all.

## Non-gaps (verified, do not re-add)
- Legacy equipment pages have **no QR/label printing**; MailPage has **no IMAP/SMTP config UI** (only a readiness probe) — earlier assumptions, disproved by the sweep.
- Payroll runs, leave/§61, approvals, org CRUD (via 결재), equipment browse/detail, KPI/analytics lenses, messenger/mail/comms — covered by scheduled milestones (M4–M11) or already-merged slices.

## Endgame reminder
AppShell + a legacy route may be deleted only when every item above that the route carries is either shipped in the Oyatie console or explicitly descoped by the founder. Tier 1 items 1–4 are hard blockers for any wholesale legacy deletion; item 5 blocks deletion of `/platform/*` specifically.
