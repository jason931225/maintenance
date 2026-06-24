# Build-Everything Execution Pipeline (user: "build everything", 2026-06-23)

Ultracode ON. Sequential committed batches on the main checkout (feat/multi-tenant-phase1).
Rule: ONE agent mutates the checkout at a time (overlapping uncommitted changes = the risk).
Each batch: wait checkout-free → launch ONE executor (no commit/push) → verify/security-check →
commit → `git pull --rebase` (non-merge) → push (auto-deploys; bot bumps digests). Backlogs in
`.omc/research/{role-workflow-backlog,analytics-intelligence-roadmap,mail-messenger-maturity}.md`.

## IN FLIGHT
- [running, owns checkout] Backend criterion-3 batch: display-name joins (sender/author/assignee/
  mechanic/kpi-scope) + pagination (users/support/inspections total+offset) + slim ArrivalEvent.
  → COMMIT FIRST when it lands.

## ORDER (dependency + value)

### A. Role-workflow blockers (FUNCTIONAL — broken, not polish) — task #23
A1. [WEB-ONLY] Work-order DETAIL view + /work-orders/:id route (wire existing GET; symptom/
    customer_request/status_history/evidence). Unblocks mechanic diagnose-loop + receptionist/
    admin lookup. ← highest leverage. Start here (no openapi conflict).
A2. [WEB-ONLY] MEMBER dead-role: route empty/['MEMBER']→/pending; MEMBER in ROLES map default-deny;
    gate /intake. + A3.
A3. [WEB-ONLY] 403-aware PageError (thread status; permission msg; hide Retry). Ship with A2.
A4. Approval queue shows report+evidence before approve/reject; per-order reject dialog.
A5. [BACKEND] Purchase "pending my approval" list endpoint (status=EXECUTIVE_PENDING) + queue UI.
A6. EXECUTIVE integrity names (embed display_name in finding payload OR lookup; fix misleading test).
A7. Reconcile EXECUTIVE RegionManage/BranchManage authz vs ADMIN-gated /settings/org.
A8. Remaining per-role (search-on-dispatch, contact_phone first-class field, intake success deep-link,
    P1 push deep-link + open-offers endpoint, 길찾기 directions, branch switcher, nav badges,
    elevated-grant segregation+confirm, onboarding OTP re-issue, admin customer/site create…).

### B. Mail + messenger maturity — task #25
B1. [P0] Messenger notify-on-message via existing push (FCM/APNs/SMS) + email to offline members
    (presence from hub + per-user notif prefs table). ← reliability: messages currently missable.
B2. [P0] Email bounce/complaint ingest + account-level suppression list; check before every send.
B3. [P0] Don't orphan accounts / hard-502 on email failure (send-before-commit or cleanup; queue).
B4. [P1] Unread counts + badges; edit/delete (soft, audited); @mentions (→targeted notify);
    branded multipart/alternative HTML email.
B5. [P2] Send queue+retry+idempotency; per-event business email/push (WO assigned, approval needed,
    SLA breach, inspection due, evidence ready); reactions/replies/typing/presence; mutable
    membership + non-WO attachments; deliverability dashboards; messenger eDiscovery export.

### C. Analytics intelligence — task #24
C1. [Tier1] Drill-down on every KPI (return the work_order_ids already carried per rollup → link to
    WO list). + period-over-period delta + target line + sparkline on every KPI/Ops tile.
C2. [Tier1] PM compliance & overdue PM (regular_inspection_schedules); maintenance cost per asset +
    trend (equipment_cost_ledger); true MTTR (time-in-IN_PROGRESS from status_history) + FTFR;
    rental/fleet utilization.
C3. [Tier2] MTBF + bad-actor Pareto per asset; repair-vs-replace/TCO (cost ledger vs acquisition_cost
    0044); availability (substitution downtime); support SLA compliance; planned-vs-unplanned ratio.
C4. [Tier3] reuse compute_price_intel for reliability/technician anomaly detectors; MC/RAV;
    technician utilization.
C5. [Part D — new capture] equipment hours time-series (biggest unlock: predictive PM); structured
    failure/root-cause code; downtime stamps; per-item inspection results; parts line-items; CSAT.

### E. Webmail subsystem (task #26; full plan in .omc/research/webmail-build-plan.md)
User's most-recent big ask. Per-tenant corporate SMTP+IMAP webmail in console. `comms` crate context.
Envelope cred encryption (XChaCha20Poly1305 + KEK from MNT_MAIL_MASTER_KEY), async-imap sync worker.
B-mail-1  Migration 0053 + domain + credential-cipher (foundation, no endpoints).
B-mail-2  Account config + test-connection + SMTP send/reply/forward (first user value).
B-mail-3  Inbound IMAP sync engine + apalis worker wiring + folders/messages read.
B-mail-4  Threads: assign-to-staff + link-to-WO/customer.
B-mail-5  Search + unread badges + realtime + polish.
B-mail-6  [deferred] IMAP IDLE + KEK rotation job + bounce/suppression.
2 new authz Features (MailAccountManage, MailUse) → Feature::ALL 39→41. Phase-1 = ONE account/tenant.
BUILD-TIME RISK GATES (before B-mail-1): R1 `cargo tree -d | grep -E 'rustls|ring'` — pin tokio-rustls
to lettre 0.11.22's rustls major, NO native-tls/openssl (buck2 holdout pain); confirm live FK table
names (registry_customers? work_orders) before the migration. Ops backstop: egress NetworkPolicy on the
worker pod (deny cluster CIDR + 169.254.0.0/16; allow public :465/:587/:993/:143/:25) — parallel ops ticket.
SECURITY REVIEW required per backend batch (cred encryption, TLS verify, SSRF guard, RLS in the sync
worker's background loop, audit coverage, secrets-never-logged).

### F. Dispatch map live (task #29; full plan in .omc/research/dispatchmap-build-plan.md)
Uber/DoorDash-style: consent-gated ON-DUTY realtime mechanic location + road routing/ETA.
Keyless now (Leaflet/OSM + OSRM via a server proxy), Kakao/Google swappable (key stays server-side).
D-map-1  Routing proxy POST /api/v1/dispatch/route (RoutingProvider trait, OSRM impl, Kakao/Google
         stubs) + draw-a-route + ETA chip on DispatchMapPage. Value-first, zero new tables/privacy.
D-map-2  Migrations 0048 ping motion fields / 0049 user_duty_status (audited) / 0050
         mechanic_live_positions (not audited, purged on duty-off/withdraw) + server-owned duty gate
         (record_location_ping requires consent AND user_duty_status.on_duty; fail-closed).
D-map-3  WS live-position stream (RealtimeEvent::MechanicPositionUpdated, NOTIFY ids+org → listener
         re-reads under armed RLS; opt-in ?subscribe=positions; snapshot replay) + GET
         /dispatch/live-positions fallback. Dispatcher-only (OpsDashboardRead), branch-scoped.
D-map-4  Mechanic on-duty toggle + share-location consent UI + browser Geolocation sender (on-duty
         gated, stop on off-duty/withdraw, persistent sharing indicator) — PIPA-forward.
D-map-5  Polish: layered markers (mechanics heading/status, sites, WOs), clustering, follow-mechanic,
         live-vs-stale, filters, mobile, route auto-recompute as mechanic moves.
Provider design agent rate-limited; routing covered by the merged plan. Retention/purge on raw pings
+ audit of who views live location (PIPA). User chose ON-DUTY scope; Google = swap when KR allows.

### D. Remaining from earlier
- #18 Tenant force-remove (opt-in "delete data too"; type-name confirm; audit row counts) — unblocks
  deleting acme. SECURITY REVIEW. (touches openapi → sequence solo.)
- #19 Week/month calendar views (DailyPlan, Inspection by due-date, optional WO-by-due).
- #14 Visual-verdict screenshot loop to ≥90 on every path (after the above land).
- #15 mnt-gate-tenant-isolation char-boundary panic (em-dash byte-slice in 0035 migration).

## Notes
- Korean copy only in web/src/i18n/ko.ts (check-ui-strings forbids inline Hangul).
- Every tenant read/write arms app.current_org (with_org_conn/with_audit + current_org()); test as
  real mnt_rt, never BYPASSRLS superuser.
- openapi served via include_str (static) → check:openapi-app is file-equality; regen ts+swift on any
  schema change. Platform routes intentionally NOT in openapi.
- Anomaly framing: 검토 필요/이상 징후 — never collusion/fraud/intent. Self-approval = 대표/CEO + SUPER_ADMIN only.
