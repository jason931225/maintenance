# Plan: Oyatie Console — new console UI/UX authority (CONSENSUS-APPROVED · pending execution approval)

Status: v4 final — Critic APPROVE 2026-07-04 · execution approved by user 2026-07-04 (ooo-seeds-per-milestone machinery)
Authority: `docs/design/oyatie-console/` — `Oyatie Console.dc.html` (prototype), `DESIGN.md` (charter), `TODO.md`, `HANDOFF.md`, `AGENTS.md`, `readme.md` (DS foundations)
Research: `.omc/research/oyatie/{frontend-map,template-inventory,logic-inventory}.md`
Consensus log: Architect v1 SOUND-WITH-CHANGES (6 changes → v2). Critic v2 ITERATE (split UI-M2, UI-M12 ACs, naming/soft-AC/scope-honesty → v3). Architect v3 delta-review SOUND-WITH-CHANGES (2 minors: name UI-M1b's migrated screens; bind UI-M2a `@`-notify to the verified messenger MessageNotifier surface, M2b upgrades delivery → v4). Critic v4: **APPROVE** (all v2 items + both Architect minors verified incorporated; code claims spot-checked; 2 cosmetic nits noted, non-blocking). Consensus reached after 2 full Planner→Architect→Critic iterations.
Naming note: "workflow-engine M2" (PR #179, the backend engine milestone) ≠ "UI-M2a/b" (milestones of this plan). This plan's milestones always carry the `UI-`/`Engine-Gen` prefix.
RESTORED 2026-07-04 after a parallel-session sweep deleted untracked .omc artifacts — this file is now committed to the program branches to prevent recurrence.

## 0. Mandate

Adopt the Oyatie Console design as the UI/UX authority for the authenticated console in `web/`. Rebuild the shell and views to the Oyatie grammar (ontology-first objects, window/pin workspace, Cedar-gated rendering, audit-everywhere). No stubs, no placeholders — every shipped screen is fully wired to real backend APIs with tests. Backend gaps are in-scope: when the backend can't realize the design intent, the slice builds the backend (user directive 2026-07-04).

## 1. RALPLAN-DR summary

### Principles
1. **Ontology-first UI**: every noun/verb is a typed object with a code, reference chips, and one-click up/down-stream traversal (DESIGN §1–3, §5).
2. **Render = policy decision**: PBAC gates screens/cards/rows/actions/search; deny-by-omission; views of sensitive data are audited (DESIGN §4.5). During the Cedar migration this means **legacy enforce + Cedar shadow** (DualEngineMode); milestones never claim Cedar *enforcement* before the enforce-flip charter.
3. **Grammar over pages**: window model, list grammar, token grammar (@/#/!) are built ONCE as shared primitives and propagate (DESIGN §4.7). Fidelity is enforced centrally, not per-page.
4. **Strangler increments of a complete system**: each slice ships fully wired (real API + tests + audit + a11y + ko.ts); untouched screens keep the old UI until their slice lands (enterprise-production-standard memory). A milestone whose UI has no live backend source may not ship — backend prerequisites are explicit milestones.
5. **Reuse over rewrite**: the typed OpenAPI client, 60-screen feature corpus, PBAC guards, M2 workflow engine, audit log, and ko corpus are proven assets — extend them.

### Decision drivers
1. `web/` already has React 19 + Tailwind v4 + shadcn + generated typed client + ~80 tests + CI gates — discarding it would burn months and violate the always-shippable rule.
2. Backend readiness is uneven: att/pay/leave/hr/org/audit/policy/auto map to live APIs (some partial); **generalized approvals need engine work first** (M2 engine is currently single-template, authoring-only REST, terminal FSM — verified `workflow_studio.rs:16-31`, `domain/src/lib.rs:230,462`); inbox/notifications/recruit/review/benefit/docs-archive need net-new server domains.
3. The design is a prototype with fictional "Acme" data; every screen must bind to real KNL-group org/data and real Korean-law flows (§61 promotion, 주52h, 4대보험).

### Options
- **A. Big-bang rewrite** of the console as a new app matching the prototype 1:1. Pros: fastest visual fidelity. Cons: discards 60 wired screens + tests; console goes dark for months; violates increments-of-complete-system. **Rejected.**
- **B. Strangler inside `web/` with two-shell coexistence** — new tokens + shared chrome land first (whole console re-skins at once); a new `ConsoleShell` hosts migrated, mounted-persistent screens while `AppShell` keeps legacy Outlet routes until each migrates; net-new domains are full-stack vertical slices. Pros: always shippable, reuses everything, central fidelity, window engine ships only where used. Cons: transient two-shell period; chrome primitives shared across both shells. **Chosen** (Architect synthesis).
- **C. Token-only refresh** (restyle existing pages, skip window grammar/ontology). Pros: cheap. Cons: the grammar IS the design — fails the authority mandate. **Rejected.**
- **D. Bespoke thin approvals model instead of generalizing M2** (Architect antithesis). Pros: de-risks four UI milestones if engine generalization stalls. Cons: violates "one workflow engine" direction, creates a second approval store to later migrate. **Rejected in favor of Engine-Gen as an explicit prerequisite milestone** — if Engine-Gen's spike finds the FSM change structurally infeasible, this option is the documented fallback and the plan returns to consensus.

## 2. Architecture decisions

- **AD-1 Token system**: translate the prototype helmet tokens (canvas/surface/muted/border/ink/steel/faint, signal amber, teal, 6 status triads, shadow/shadow-pop) into the Tailwind v4 `@theme` in `web/src/styles.css` as a `console-*` token family with **light + dark** values. Public storefront keeps its existing KNL brand tokens untouched.
- **AD-2 Workspace state**: **Zustand** for the window/panel/workspace engine only. Data fetching stays on the existing `openapi-fetch` wrapper + read cache. No React-Query migration.
- **AD-3 DnD**: native pointer events + HTML5 DnD exactly as the prototype does (proven, zero new deps).
- **AD-4 Workspace persistence**: server-owned per-user profile — `GET/PUT /api/v1/me/workspace` (JSON blob, schema-versioned, sanitized on load like `mergeCardLayout`). RLS-scoped to the person. Ships with M1b (first consumer), not M1a.
- **AD-5 Object layer**: an `ObjectRef` registry (`kind → {code prefix, chip colors, icon, pin-panel renderer, route}`) grows from existing `ObjectLink`/`ObjectViewScaffold`. Reference chips, drag tokens, palette results, token-grammar candidates, and pin-panel bodies all dispatch through it.
- **AD-6 Approvals ride M2 — after Engine-Gen**: the generalized AP- approval object (8 templates, dynamic 결재선 with 검토/승인/합의/참조 roles, enum reasons, object-link targets, 종결≠최종승인, 대행, 사후 반려, receipt step) runs on the M2 engine. **This requires net-new engine work, not surface reuse**: (a) runtime/instance REST does not exist today (studio REST is authoring-only — catalog/definitions/history/simulate/publish/pause/rollback/clone, `workflow_studio.rs:16-31`); (b) the FSM forbids edges out of terminal nodes (`domain/src/lib.rs:230`, test :462), so finalization/receipt must be modeled as **pre-terminal WAITING nodes** (run stays WAITING through 최종승인 → 종결/수령확인) and 사후 반려 as a **compensating document/event**, never a reopened terminal run; (c) a definition builder/parser for arbitrary approval-line DAGs. All of this is the explicit **Engine-Gen milestone** (§3).
- **AD-7 Audit**: audit UI binds to existing append-only `audit_events` + `GET /api/audit`. Telemetry enrichment (device ctx, classification, seq+hash chain, trace) is a backend slice extending the `with_audit` envelope — additive. "실시간" = polling first; SSE/WS later via `crates/platform/realtime`.
- **AD-8 Cedar**: UI renders from server decisions + `policy_projection` claim (non-authoritative hints). DualEngineMode → enforce flip stays a separate charter; no UI milestone blocks on it; **all ACs phrase authorization as "policy-gated (legacy enforce, Cedar shadow)"**. Deny-by-omission is honored today by not rendering what APIs don't return.
- **AD-9 Screens without design** (dispatch/equipment/financial/support/messenger/mail/settings…): adopt tokens + shared chrome immediately (M1a re-skins them), keep current layouts until a design exists. New work on them follows the Oyatie grammar.
- **AD-10 Branching**: new workstream branches off `main` after PR #179 (workflow-engine M2) merges — `feat/console-oyatie-<milestone>`, one PR per milestone, CI-gated. Not stacked on `feat/workflow-engine-m2`.

## 3. Milestones (each = one PR, fully wired, tests green; UI-M12 is four such slices)

Order (Architect synthesis + Critic split): **UI-M0 → UI-M1a → Engine-Gen → UI-M1b → UI-M2a → UI-M2b → UI-M3 → UI-M4 → UI-M5 → UI-M6 → UI-M7 → UI-M8 → UI-M9 → UI-M10 → UI-M11 → UI-M12**. Engine-Gen is backend-only and can proceed in parallel with UI-M1a/M1b/M2a/M2b (different lanes) but must merge before UI-M3 (which consumes its instance REST).

### UI-M0 — Design-system foundation (frontend-only)
Tokens (light+dark `console-*` family); icon mapping (~50 prototype names → lucide-react, hand-inline the missing few); primitives: `Chip`/`StatusChip`, `StatBar` (compact 1-row KPI strip), `MonoRef`, `ObjectChip`, `SearchInput`, `SectionCard`, `Toast` (with undo), list grammar hooks (`useListNav` J/K/Enter, `useColumnResize`, bottom fade + overscroll contain, shared track alignment).
- AC: Vitest coverage per primitive; axe clean; dark theme toggles; storefront unchanged, proven by Playwright visual snapshots of the public routes (/, /rental, /used, /support/new) recorded before the change and asserted after.
- Verify: `npm run web:lint && web:test && web:build`, check-ui-strings, Playwright smoke.

### UI-M1a — Shared chrome (all routes re-skin; no window engine)
Sidebar (grouped nav + badges + collapse), topbar (scope switcher + ⌘K trigger + user), toast host — built as shared chrome components consumed by BOTH `AppShell` (legacy Outlet routes, all ~40 re-skin immediately) and the future `ConsoleShell`. The comms rail (including its collapsed strip) is NOT in this slice — it ships wired in UI-M2b (no unwired chrome). Scope switcher binds to real authorized-entity list (identity org API) — "그룹 전체" = union of authorized 법인 (+group-common), never a literal all.
- AC: every tenant route renders with new chrome; existing page tests green; axe + keyboard; mobile drawer covered by a Playwright viewport-320px spec (open/close/nav/focus-trap); no window-engine code shipped.

### Engine-Gen — workflow-engine generalization (backend-only; prerequisite for UI-M3/M4/M6/M8/M9)
Opens with a 1–2 day **spike** validating the FSM design; if structurally infeasible, stop and return to consensus with Option D (bespoke thin approvals) on the table.
Deliverables: (a) **runtime/instance REST**: start-run, list-waiting-tasks (by role/assignee — "내 결재함"), list-my-runs ("상신함"), claim, decide (approve/reject/return with comment-required rule), finalize; (b) **generalized definition builder** for arbitrary approval-line DAGs (dynamic-length lines, 검토/승인/합의/참조 step roles, enum reasons, object-link targets, template catalog for the 8 기안 types); (c) **finalization model**: 최종승인 ≠ 종결 — finalization and receipt-confirmation are pre-terminal `WAITING` nodes (author finalize; policy-gated 대행 finalize with reason; run reaches terminal only at 종결); 사후 반려 = compensating document/event linked to the finalized run (legacy enforce, Cedar shadow), notifying the whole line; (d) audit events on every transition via `with_audit`.
- AC: engine tests for the new FSM shape (terminal-node invariant preserved); instance REST covered by sqlx::test as `mnt_rt`; the completion→approval→payroll template still passes; OpenAPI regenerated, client drift gate green.

### UI-M1b — ConsoleShell + window engine (ships adjacent to its first consumer, UI-M2a objects)
`ConsoleShell` for migrated mounted-persistent screens: quadrant panel container (`dashArea` + `panels[].area`), body padding reservation, pin-panel chrome (shared header: minimize/popout/close), float/popout windows (header-drag ≤54px, 16px grid magnet), tray (min chips + docked drafts), snap drop zones + preview, Esc cascade + global keys. Zustand workspace store + `me/workspace` persistence endpoint (backend: identity-adjacent, migration, RLS, audited writes). **First inhabitants (named live consumers): `/work-hub` and `/attendance` migrate into ConsoleShell in this slice** — two low-risk personal screens with real objects to pin (work orders/tickets; attendance records); /work-hub is later replaced by UI-M3's overview. The per-screen card/split/preset sub-engine (`computeCardLay`/presets/split bar) is **deferred to UI-M7** (first card screen).
- AC: window grammar E2E on the two migrated screens — pin a real object panel on /work-hub, switch to /attendance and back (panel survives — mounted persistence), reload (layout restored via server profile), minimize/restore via tray; keyboard + axe.

### UI-M2a — Object layer + token grammar (the two shared grammars; one PR)
(1) `ObjectRef` registry + reference chips + drag tokens + pin-panel renderers for object kinds with live APIs (work order WO-, support CS-, person, org unit). (2) **Token grammar primitive** (DESIGN §4.7 catalog item 7 — single parser/renderer for ALL inputs): `@`=mention→notifies, `#`=object link→no notify, `!`=code link (`!AP-3121`); search dropdown with viewport flip/clamp; PBAC-gated candidates (only objects the principal may see — deny-by-omission; `!` codes to unauthorized objects do not link); plain-text non-interference rules (email local-parts, `#23`, `!!`); explicit confirm only (click/Tab — space/Enter never auto-select). (3) ⌘K palette upgraded (pending work + screens + people via real APIs). `@`-mention **delivery in this slice binds to the existing messenger surface** (verified: messenger exposes a `MessageNotifier` post-commit port + `unread_count`): a mention in a messenger-backed input notifies via message-posted fan-out + recipient unread. Non-messenger inputs (comments, todos, 기안) insert and persist the mention in M2a; their notification *delivery* is UI-M2b's AC (notification center) — M2b upgrades delivery rather than introducing `@` behavior.
- AC: drag a work-order row into a composer → chip inserts and resolves; in a messenger input, `@` mention produces recipient unread + WS message-posted event and `#` does not (integration test); unauthorized object codes fail to link (PBAC test persona); person chip → pin panel with server-recorded view-audit for non-self; token-parser unit suite covers every non-interference case in the design spec.

### UI-M2b — Comms rail + notification center (full-stack; one PR)
Comms rail (collapsed strip + open views): messenger threads + mail backed by existing messenger/comms APIs; rail↔main promotion for /messenger and /mail (read/reply scope — compose stays in main views). **Notification center backend**: general `notifications` domain (pointer objects: cat/text/link/unread), LISTEN/NOTIFY → WS fan-out via `crates/platform/realtime`, REST list/mark-read; nav + rail badges driven by it.
- AC: rail counts real (unread threads/mail/notifs match API); `@`-mentions from non-messenger inputs (M2a) now deliver notification-center items (integration test); notification click routes to its object/screen; mark-all works and persists; WS delivery observed in E2E; rail↔main promotion keeps state (same thread selected).

### UI-M3 — Overview (통합 개요) — depends on Engine-Gen + UI-M2a
Unified action inbox aggregating real pending items (approvals-for-me via **Engine-Gen instance REST**, dispatch offers, support tickets, attendance exceptions) with kind filters/counts, J/K/Enter, done/undo mapped to real mutations; Today/Plan panel (todos CRUD — new small `todos` domain w/ scope chips + object links; punch status from attendance); KPI strip from reporting APIs. Replaces /work-hub.
- AC: every row's primary action executes the real mutation with audit; empty/error/loading states; scope filter = authorized entities only.

### UI-M4 — 전자결재 (appr) on the generalized engine
결재함/상신함/기안 tabs; template gallery + compose (사유 enum, 대상 지정 = object links via registry + token grammar, auto 결재선 preview); approval pin panel (line, comment-required 반려/거부, 승인); progress timelines; 종결 workflow (author finalize; 대행 and 사후 반려 policy-gated — legacy enforce, Cedar shadow — with reason + audit + line-wide notification). The 내 급여 명세 sidebar is explicitly deferred to UI-M5 (its data source is InboxDoc) — UI-M4 ships without it rather than with a dead link.
- AC: end-to-end compose → line advances via real engine transitions → 최종승인 → author 종결 → appears in docs-archive query; 사후 반려 produces compensating document + notifications; all transitions audited.

### UI-M5 — 개인 수신함 + passkey receipts (full-stack; deliberate mode)
`InboxDoc` domain (HANDOFF §3): `{kind pay|contract|rule|promote|refusal, ref, title, from, date, legal, basis, body, links, confirmed{by,at}, owner}`; payslips generated from payroll runs (self-view unaudited per policy flag); legal docs gated: server-issued WebAuthn challenge (reuse `webauthn-rs` infra), verified assertion = receipt evidence → `confirmed` + immutable audit event; AP- receipt step closes via back-ref (AP.receiptDoc ↔ InboxDoc — the Engine-Gen receipt WAITING node). Frontend: 2-pane vault, filters, lock/unlock, real passkey ceremony (`navigator.credentials.get`), 수령 확인 stamp, nav badge = unconfirmed legal docs.
- AC: fresh-session passkey assertion required for `legal && !confirmed`; replay-attack tests (webauthn_ceremony_replay.rs pattern); payslip self-view leaves no view-audit event; RLS owner-only; security-reviewer pass before merge.

### UI-M6 — 연차 + §61 촉진/노무수령거부 (full-stack)
Leave screen (balances/소진율 from hr.rs APIs, request queue 승인/반려/거부 w/ audit); promotion engine: round 1→2 tracking, 촉진 통지 = AP- via engine with receipt step wired to M5 InboxDoc; refusal-right flow after round 2 (근로기준법 §61).
- AC: full round-trip: push → AP- in 상신함 → target inbox doc → passkey confirm → AP- 종결; every transition audited + notifies line.

### UI-M7 — 근태 (att) — first card-workspace screen
Card/split/preset sub-engine lands here (presets 63:37/74/50:50/stack, split bar with snap stops, drop-reorder, per-screen persistence via me/workspace). Cards: 근무 현황 today/month (real attendance records + drill 그룹→법인→사업장→개인; column resize), 주52h monitor, 예외 queue, 월 마감 gate. Backend: month aggregation endpoints if missing; close-gate state.
- AC: month close blocks until exceptions resolved; 급여로 이동 handoff; presets + column widths persist server-side.

### UI-M8 — 급여 (pay)
5-step run pipeline bound to payroll crate (마감 gate → 계산 → 예외 검토 w/ cross-object chips → 상신 as AP- via engine → 이체 schedule); register gated pre-calculation; totals per entity.
- AC: run FSM server-owned — client cannot advance a step out of order (integration test asserts 409/reject on out-of-order transition; state survives reload); submit creates real approval; exception chips traverse to att/person objects.

### UI-M9 — 인사 관리 + 조직도 + person card
HR roster card zone (real employee list), 근태 이상 card; tiered person card (기본/직무/최근 업무·KPI/민감 categories, "열람 — 기록 남음" gate emitting real view-audit, masked PII, admin mode); org chart (real org tree; edit mode produces 조직 개편 결재 via engine rather than direct mutation — "operations through console only").
- AC: sensitive-category view = recorded audit event; org edits land as approval documents (policy-gated — legacy enforce, Cedar shadow), not direct writes.

### UI-M10 — 감사 로그 (audit)
Feed UI (day groups, filters incl. classification/anomaly/decision, full-text, correlation drill, expanded telemetry grid, export). Backend: extend audit envelope with device/browser/geo/auth-method, data classification, seq + hash chain, trace id; polling now, SSE later.
- AC: events from M3–M9 visible with full telemetry; hash chain verifies; export works; covert rows absent for unauthorized principals.

### UI-M11 — 권한·정책 (policy) + 자동화 (auto)
Policy: NL rule rows over the real Cedar policy store (read + simulation via existing studio APIs; who→what→action rendering; full no-code visual canvas = follow-on charter). Auto (NET-NEW design — prototype has no template): 2-pane workflow + schedule lists per the renderVals contract, bound to engine studio APIs (definitions/simulate/publish/pause/history) + `crates/platform/jobs` schedules (cron + NL label + next-run preview + run history).
- AC: toggle/run/simulate real definitions; schedule edit recomputes next run server-side; all actions audited.

### UI-M12 — 문서·기록물 + 복리후생 + 채용 + 평가 (four independent full-stack slices, one PR each; internal order = open question 1)
- **docs**: finalized-records archive over engine/document data + retention labels. AC: a finalized AP- from UI-M4 appears in the archive with type/보존 label and is full-text findable; opening a record emits a view-audit event; export works.
- **benefit**: benefits domain w/ lifecycle FSM (draft→pending→finalized→implemented→retiring→retired) + tier tables. AC: a lifecycle transition notifies participants + emits audit; tier table renders per 직급/현장; invalid transitions rejected server-side (FSM test).
- **recruit**: postings/applicants domain (stage FSM 접수→서류→면접→오퍼→입사; hold/doc-request/reject with reason catalog). AC: advancing a candidate to 입사 creates a real employee record linked to the posting (DESIGN §2 chain), audited; rejected candidates retain reasons ("사유 기록됨"); stage counts on the posting row match the API.
- **review**: evaluation domain (period, per-team progress, my evaluation tasks). AC: submitting an evaluation updates team progress and emits audit; my-tasks list reflects real assignments — OR the slice is formally deferred per open question 3 before execution reaches it.

## 4. Cross-cutting execution rules (every slice)

- TDD (failing test first) for logic; Vitest + Testing Library; Playwright + axe for flows; MSW for mocks; dev-auth E2E where auth-sensitive (passkey, PBAC).
- ko.ts for every string (check-ui-strings); Korean-first labels per design vocab.
- Backend slices: clean-architecture crate layout, sqlx migrations (migration-safety gate), RLS + `with_org_conn` (rls-arming gate; verify as `mnt_rt`), `with_audit` on every mutation (audit-coverage gate), no PII in logs.
- WCAG AA; window grammar keyboard-operable; reduced-motion respected.
- Each milestone = 1 PR to main, CI green. No dark code paths except: Engine-Gen may dark-land REST behind the existing strangler pattern; M1b's ConsoleShell mounts only migrated screens (legacy stays on AppShell — two-shell coexistence, not a flag).

## 5. Risks / pre-mortem

1. **Engine-Gen FSM redesign proves structurally hard** (Architect's steelman) — 사후 반려 on finalized runs cannot reopen terminal nodes. Mitigation: pre-terminal WAITING finalization/receipt nodes + compensating documents designed in the opening spike; hard stop + consensus return with Option D fallback if the spike fails; Engine-Gen merges before any UI consumer.
2. **Chrome swap regressions (M1a)** — ~40 routes re-skin at once. Mitigation: page bodies untouched; full existing suite green; Playwright route-smoke matrix; chrome components are additive (AppShell keeps structure).
3. **Passkey receipt = legal evidence (M5)** — highest stakes (본인확인, 근로기준법 evidence). Mitigation: deliberate-mode slice — server-side challenge verification, replay tests, immutable audit, legal-basis fields, RFC3161 interface reserved; security-reviewer pass before merge.
4. **Scope creep via design backlog** (multi-jurisdiction PII, access-grant tokens, object graph explorer). Mitigation: scope frozen to §3; backlog → future charters.
5. **Two-generation UI period** — mitigated by M1a (tokens/chrome re-skin everything immediately; only layouts differ) and ordering (highest-traffic screens first).

## 6. Test plan

- Unit: primitives; workspace store (snap/evict/dedupe/sanitize); object registry dispatch; token-grammar parser (trigger/non-interference/PBAC-gating cases); audit hash-chain verify; Engine-Gen FSM invariants (terminal-node rule preserved).
- Integration: per-screen API binding (MSW); backend crate tests per slice (sqlx::test as mnt_rt); engine template tests (old payroll template + new generalized templates).
- E2E (Playwright dev-auth): window grammar persistence; overview action round-trip; appr compose→종결; §61 promotion round-trip incl. real passkey (virtual authenticator); PBAC persona matrix extension; axe per migrated screen.
- Observability: audit events asserted in E2E (existence, decision, classification).

## 7. Open questions (do not block UI-M0–M2b)

1. UI-M12 internal order (docs/benefit/recruit/review) — business priority?
2. Comms rail: read/reply only confirmed for UI-M2b; mail compose stays in /mail main view — OK?
3. 평가 (review) design is thin (2 cards) — accept as-is or defer for a richer design pass?
4. **No-code policy canvas**: DESIGN §4.6 makes the no-code visual canvas the *baseline*, but UI-M11 ships read-only NL rows + simulation and defers the canvas to a follow-on charter. Explicit sign-off requested that read-only-first is acceptable for this program.

## 8. ADR (to be committed as docs/decisions/ADR-00XX-oyatie-console-authority.md)

- Decision: adopt Oyatie design authority; strangler rebuild in `web/` with two-shell coexistence; approvals standardize on the M2 engine after an explicit Engine-Gen milestone (instance REST, generalized DAG builder, pre-terminal finalization model).
- Drivers: reuse of proven assets; uneven backend readiness (engine authoring-only today); central fidelity enforcement.
- Alternatives: big-bang rewrite (rejected: dark period, asset burn); token-only refresh (rejected: misses grammar mandate); bespoke thin approvals (rejected: second store; retained as documented fallback if Engine-Gen spike fails).
- Consequences: Zustand enters (workspace only); ConsoleShell/AppShell coexist during migration; new domains (notifications, inbox, todos, benefits, recruit, review, docs-archive) join as crates; engine gains instance/task REST + finalization semantics.
- Follow-ups (named out-of-scope for this program, per charter): Cedar enforce flip charter — **including covert clearance** (CEO-designated 비밀인가, clearance role itself as covert resource, CEO-only audit stream; DESIGN §4.5 / HANDOFF §2 / design-TODO #13); audit SSE stream; no-code policy/workflow visual canvas (see open question 4); **Contract C- → Position(인원편성) → PolicyPreset chain editor** (DESIGN §3 head of the standard flow — design backlog, not in the prototype; enters as its own charter); multi-jurisdiction PII program; object graph explorer; **mobile-app parity** for 메신저·메일·알림·전자결재 (DESIGN §4.8 — outside this `web/` program; coss-rn charter).
