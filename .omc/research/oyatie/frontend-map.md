# Current console frontend + backend API map (2026-07-04, branch feat/workflow-engine-m2)

## 1. Stack

Single frontend: `web/` (npm workspace `@console/web`).

- React 19.2.7 SPA, react-router-dom ^7 (declarative, React.lazy code-split), Vite 8 + @tailwindcss/vite, TypeScript strict (`tsc -b`).
- Tailwind CSS v4.3 (CSS-first `@theme`, no config file) + shadcn/ui ("new-york", `web/components.json`) + CVA + tailwind-merge + lucide-react. Pretendard font.
- Libs: react-leaflet (dispatch map), qrcode.react (passkey handoff), dompurify (mail HTML), openapi-fetch.
- Siblings (not console): android/, ios/, clients/{ts,kotlin,swift} generated API clients. The former `coss-rn` RN public site is historical and retired by ADR-0026.

## 2. Routes (~60 real screens, source `web/src/AppRouter.tsx`, pages in `web/src/pages/`)

- Public: storefront marketing (/, /rental, /used, /maintenance, /about, /contact, /privacy, /platform-fsm), /support/new intake, /login (passkey/OTP).
- Auth shell-less: /wallboard, /onboarding (passkey enrollment), /pending.
- Platform admin (`PlatformShell`): /platform/{tenants,groups,ops,onboard,account}.
- Tenant console (`AppShell`): /work-hub (client-side personal inbox), /attendance, /dispatch, /work-orders/:id, /dispatch-map, /intake, /daily-plan, /collaboration, /kpi, /intelligence, /integrity, /reporting, /messenger, /mail, /support, /equipment(+manage/legacy/:id), /catalog, /financial, /payroll, /hr/leave-management, /hr/insurance, /inspection, /ops, /settings/{profile,location,employees,group,users,org,sites,security}, /settings/policy (Cedar Policy Studio), /settings/workflows (M2 Workflow Studio).
- Nearly all pages have co-located `*.test.tsx` + `features/<domain>/` implementation. Thin: storefront marketing, legacy EquipmentPage.

## 3. Component architecture

- Tokens: `web/src/styles.css` Tailwind v4 `@theme` — KNL storefront brand (--color-ink/signal/brand-teal/steel/line) + console semantic palette (--color-console-canvas/surface/muted/border, tone-{danger,warning,success,info,accent,neutral}-{bg,border,text}). Light-only. `word-break:keep-all`.
- Shared UI: `web/src/components/ui/` shadcn primitives (button, badge, card, combobox, data-table, dialog, input, select, textarea).
- Shell: `web/src/components/shell/` — AppShell (sidebar+topbar+main, ⌘K CommandPalette, skip-link, mobile drawer), Sidebar (collapsible rail), Topbar, BackStackBreadcrumbs, PageHeader, PlatformShell. Nav registry `nav.ts`/`nav-labels.ts` grouped personal/operations/executive/assets/finance/organization/identity/settings, role+feature gated.
- State: React Context only (context/auth.tsx session, context/title.tsx). No Redux/Zustand/React-Query. Hand-rolled useEffect fetching per page; bespoke read cache in `api/client.ts` (30s fresh/5min stale, single-flight).
- API: generated OpenAPI types `@maintenance/api-client-ts` (clients/ts, openapi-typescript + openapi-fetch). Wrapper adds device-id header, refresh, caching. Sub-clients api/{device,groupAdmin,platform}.ts.
- i18n: Korean single-locale hard-coded `web/src/i18n/ko.ts` (5,233 lines) + hrWorkflows.ts + dataExchange.ts. `scripts/check-ui-strings.mjs` enforces no raw strings.
- Object-centric seeds: `features/object-view/ObjectViewScaffold.tsx` (ObjectViewPanel/Properties/Field), `components/object/ObjectLink.tsx` (typed object link, UUID-suppressing labels), `components/text/MentionText.tsx`.

## 4. Auth wiring

- `context/auth.tsx`: access token in memory only. JWT claims drive UI: roles, group_roles, feature_grants, policy_projection (Cedar projection — display-only, non-authoritative), branches, platform, display_name.
- `auth/webauthn.ts`: usernameless discoverable passkey login (/api/v1/auth/passkey/login/start → navigator.credentials.get → /finish), registration/enrollment, redeemOtp, signup. QR handoff EnrollHandoffQr.tsx. SecurityPanel, RoleSwitcher.
- `api/refresh.ts` single-flight refresh on 401.
- PBAC-gated rendering: ~12 `components/Require*Route.tsx` guards + nav gating (`ITEM_ROLE_GATES`/`ITEM_FEATURE_GATES`); `auth/policyProjection.ts` normalizes Cedar claim. Backend re-authorizes every call.
- Backend WebAuthn real: webauthn-rs in `crates/platform/auth/`, surfaced via `crates/identity/rest/`.

## 5. Backend API surface (backend/, composition root backend/app/src/lib.rs build_router ~line 1270)

Domain crates under backend/crates/ (each domain/application/adapter-postgres/rest):
- workorder (+ mobile_router, m2_strangler.rs), dispatch, inspection, support (tickets + public intake), sales (catalog/inquiry), registry (equipment), reporting (KPI+Excel), financial (cost ledger, purchase requests), messenger (realtime chat), comms (mailbox IMAP/SMTP), compliance, identity (auth/org/users/roles/webauthn), erp, payroll.
- HR: `app/src/hr.rs` (369KB, app-level): /api/v1/hr/* — org-chart, leave-balances, attendance-summary/import/records, absence-exit, exit-cases, readiness-summary.
- Approvals: no standalone crate; approval/completion-review in workorder + frontend features/approvals/ (ApprovalCommandCenter, ApprovalDocumentDesk, TargetChangeReviewQueue).
- Audit: EXISTS append-only — audit_events table + audit_events_immutable() trigger (migrations 0051, 0059 in crates/platform/db/migrations/), with_audit(...) wrapper, read GET /api/audit (lib.rs:1635, branch-scoped, paginated). NOT a live stream (no SSE/WS for audit).
- Personal inbox: DOES NOT EXIST server-side (inbox = sales inquiries / IMAP folders only; /work-hub composes client-side from work-orders + support tickets).
- Notifications: WebSocket messenger-only (crates/platform/realtime/ — PG LISTEN/NOTIFY → WS hub) + mobile push (crates/platform/push/). No general notification center. Messenger application exposes MessageNotifier post-commit port + unread_count (crates/messenger/application/src/lib.rs:17-27,116).
- Cedar PBAC: EXISTS mid-migration — crates/platform/authz/src/cedar_pbac.rs DualEngineMode: LegacyOnly → CedarShadowLegacyEnforce → CedarEnforceLegacyCompare. Currently legacy enforces, Cedar shadows/records. crates/platform/request-context/ per-request principal. Policy Studio UI /settings/policy.
- Workflow engine (M2): EXISTS, PR #179 — crates/workflow/{domain,runtime,adapter-postgres}: engine.rs, interpreter.rs (NodeKind: ObjectGate/ObjectMutation/HumanTask/Job), authz_guard.rs (Cedar guard INERT — pinned LegacyOnly/NotConfigured), idempotency.rs, crash-safe reconciler (app/src/workflow_drain.rs). REST app/src/workflow_studio.rs (90KB) is AUTHORING-ONLY: /api/v1/workflow-studio/catalog|definitions|{id}/history|simulate|publish|pause|rollback|clone — NO instance/run/task/decide/finalize routes. Terminal FSM: no edge leaves a terminal node (domain/src/lib.rs:~230, test :461); RunStatus/NodeStatus Waiting⇄Running legal. Single seeded template approve_work_order; wf.exec.v1 executable node-graph schema exists.
- Platform crates: auth, authz, db, email, excel, group, jobs, provisioning, push, realtime, request-context, storage, platform-rest.

## 6. Tests + CI

- Vitest 4.1.8 + Testing Library + jsdom + MSW 2.14.6 (~80 co-located tests, setup web/src/test/setup.ts). ESLint 10 flat --max-warnings 0 + check-ui-strings.mjs.
- Playwright 1.61 + @axe-core/playwright; CI --project=dev-auth against real dev-auth stack via scripts/dev-up.mjs; specs in /e2e/.
- CI `.github/workflows/ci.yml`: web job (lint/test/build + foundation-gate), Backend job (fmt/clippy/test + mnt-gate-* binaries: layer-boundary, audit-coverage, migration-safety, tenant-isolation, pii-no-logs, rls-arming, dev-auth-absence — backend-only), dev-up smoke + e2e, API clients gen + drift gate. Root package.json check:* scripts (enterprise-ux-parity, browser-persona-matrix, api-drift).

## 7. Serving

Static SPA: web/Dockerfile Node 24 build → nginx-unprivileged:8080 (SPA fallback, immutable assets, security headers). Deploy k8s + ArgoCD (deploy/), image via .github/workflows/image-release.yml (ci-gated).

## 8. Gap assessment (to Palantir-Foundry-style object console)

Medium-to-large; re-skin + shell-rebuild, not rewrite. Transfers directly: typed OpenAPI client, PBAC-gated rendering + Cedar projection claim, ObjectViewScaffold/ObjectLink seeds, M2 workflow engine + studio, immutable audit log, command palette, token layer, ko corpus.

Missing: (1) object/ontology layer in UI — app is page-centric, no uniform object card/type registry/object-set; (2) pin/workspace/panel system — classic sidebar+Outlet shell, no state layer to hold it; (3) drag-and-drop reference tokens — fully greenfield; (4) server gaps — no notification center, no audit stream (queryable log only), no personal inbox.
