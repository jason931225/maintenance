# KNL one-stop platform — vision & roadmap

Living plan so nothing is lost. The platform is **one integrated product**: corporate web
front + FSM operational dashboard + governance/observability + CX SaaS — running the full
business **lifecycles** (maintenance; asset acquisition→use→sale; employee/HR), with cost
and governance woven through. Bar: **highest quality, industry-best UI/UX, no stubs, no
filler, online-centric** (phone is a last resort). Korean-first, multi-tenant (RLS).

## Already built & verified (browser E2E: 76/78 specs pass)
- **FSM operations** — dispatch board, work orders (= the per-asset maintenance record),
  daily plans, evidence upload, mobile offline sync. State machine RECEIVED→…→FINAL_COMPLETED.
- **Approvals / 기안서 chain** — purchase-request approval incl. executive final-approve
  (`admin-13-financial`, `exec-03-purchase-final-approve`; `PurchaseFinalApprove` feature).
- **CX / customer relations** — REAL support tickets (`/api/v1/support/intake` → support_tickets)
  + sales inquiries. Not a board.
- **Governance & observability** — multi-tenant platform admin (onboard/suspend/reactivate),
  cross-tenant ops-health rollup, KPI + ops dashboards, audit_events.
- **Sales** — sales_listings + public storefront + inquiries.
- **Platform** — multi-tenant org isolation + RLS, passkey/WebAuthn auth (cold-start OTP →
  enroll → usernameless login), org-scoped roles (RECEPTIONIST/MECHANIC/ADMIN/EXECUTIVE/SUPER_ADMIN).
- **Live** — knllogistic.com (storefront) + console.knllogistic.com (console; legacy fsm.knllogistic.com 301-redirects here) on the OCI/Talos cluster.

## In progress
- **Web front door redesign** — unified one-stop site (corporate + FSM/CX-SaaS), online-centric.
  - DONE + committed: FSM/console access from the landing; maintenance-request as the primary
    online CTA (→ /support/new); phone demoted to last resort; `consoleHref()` cross-host helper.
  - DESIGNING: full integrated homepage + IA (expert design panel), reusing the real corporate
    (`storefront.*`) + FSM-SaaS (`landing.*`) copy already in `ko.ts`; ISO + partner-wall credibility.

## Net-new domains — agreed sequence
1. **Asset lifecycle & cost analytics** ⟵ **FIRST (user-chosen)**
   - Capture **acquisition cost** (+ date, vendor) per asset; roll up **maintenance cost** per
     asset (parts/labor/outsource) from work orders; **TCO analytics** per asset; tie into the
     sale (compare sale price vs acquisition + maintenance). Spans acquisition→maintenance→sale.
2. **Procurement price governance** — extend 기안서 so each purchase request surfaces **past
   price records** for the item/equipment and **flags abnormal pricing** for management.
3. **Payroll** — internal payroll (net-new).
4. **Bookkeeping / accounting** — double-entry internal accounting (net-new).
5. **Employee / HR cycle** — hiring/onboarding → records → (feeds payroll).
6. **Manufacturing execution / MES** — future scope after group/org, people, assets/inventory,
   ontology, workflow, policy, and ERP foundations. Target capabilities include production orders,
   dispatch lists, work-center/line execution, operator work instructions, quality/NC handling,
   material consumption, genealogy/traceability, OEE/downtime, labor capture, and ERP/asset/quality
   integration. See [`docs/specs/mes.md`](./specs/mes.md); this must be benchmarked against
   SAP Digital Manufacturing, Siemens Opcenter Execution, Rockwell Plex MES, Tulip, and Dynamics
   production-floor patterns before implementation.
7. **Customer accounts / portal** — decide whether clients/guests get accounts to track their
   own tickets/orders (today: guests file tickets w/o account; clients = SaaS tenants + staff
   sign in via the console). **Open decision.**

## Cross-cutting requirements
- **Unified sign-in** — clients (SaaS tenants) + employees via the passkey console; guests file
  tickets with no account. Prominent + clear per audience.
- **Real ticket system** everywhere "contact/support" appears (never a static board).
- **Cost & governance woven in** — acquisition cost, maintenance cost, price history/anomaly,
  who-approved-what (audit), per-asset and per-tenant.
- Every new read is **RLS-armed** (`with_org_conn`/`current_org`; the `mnt-gate-rls-arming`
  gate flags bare-pool reads). All migrations bounded-text + CHECK constraints per repo convention.

## Verification / debt
- Browser-E2E harness (`e2e/run.sh`, WebAuthn virtual authenticator) — keep green per change.
- GAP specs to add: **sales-listing create/publish** (the "put assets up for sale" path),
  **public customer support-request** (`/support/new`).
- Stale specs to update: `landing.spec.ts` (tests removed #10 page — replace with the new
  homepage), `mech-01-02-dispatch.spec.ts` (a "현장 담당자" text assertion).
- Live deploy of the web changes needs a `mnt-web` image rebuild plus the default
  verified `scripts/deploy.sh` path (digest bump + Argo sync + rollout/pod digest
  + endpoint evidence); bump-only mode is not a deployed/verified claim. See
  `deploy/OPS-RUNBOOK.md`.
