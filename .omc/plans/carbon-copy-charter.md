# Carbon-Copy Charter — Oyatie Console

Status: DRAFT for Architect → Critic consensus review (RALPLAN-DR + ADR below).
Founder directive (2026-07-09, **supersedes** `.omc/plans/oyatie-console-plan.md`'s strangler/re-skin): "Implement the designs in this project as the design and feature authority. The current frontend should be reference for additional gaps that we need to cover. Focus on creating a **carbon copy that is fully wired first** with backend that is able to support it."

Design & feature authority: `docs/design/oyatie-console/` — `Oyatie Console.dc.html` (prototype, 698 KB), `DESIGN.md` (charter), `AGENTS.md` (change-log = live design state), `TODO.md`, `SYNC-MANIFEST.md`, `HANDOFF.md`, `ROADMAP.md`. Backend truth: `.omc/research/oyatie/backend-adequacy-audit.md`. Gap superset: `docs/design/oyatie-console/LEGACY-PARITY-BACKLOG.md`. Per-screen spec source (being extracted, may not exist yet): `.omc/research/oyatie/prototype-anatomy/`.

Why this charter exists: the prior plan chose a **strangler re-skin inside `web/`** (shared chrome primitives across two shells, prototype tokens folded into Tailwind `@theme`). The founder has replaced the goal with a **carbon copy** — pixel/behavior fidelity to the prototype with **zero visual inheritance from legacy**. A shared-chrome strangler structurally cannot deliver that (it shares the chrome it is supposed to replace). This charter re-decides surface, fidelity gate, and phasing around fidelity-first; it **keeps** the prior plan's still-valid backend findings (Engine-Gen REST is live, the four BE charters) and its always-shippable / no-stubs / RLS-as-`mnt_rt` discipline.

---

## 1. RALPLAN-DR summary (for step-2 alignment + Architect/Critic)

### Principles
1. **Fidelity is the product.** The console *is* the prototype's grammar and look — verbatim tokens, exact window/pin/composer behaviors. "Close enough" fails the mandate; fidelity is a merge gate, enforced centrally not per-page (DESIGN §4.7, §4-18 "same shape drawn twice = violation").
2. **Fully wired or not shipped.** Every slice binds to a real backend API with tests (incl. browser E2E on a real backend). No fabricated data, no stub galleries, no dead ends. Honest backend gaps become **named backend charters**, not placeholders.
3. **Grammar before screens.** The reusable grammar (tokens, shell, window engine, token composer, generic module template, lifecycle modal, object card) is built **once** in P0; every screen composes it. This is the §4.7 propagation contract made structural.
4. **Zero visual inheritance, shared data spine.** The carbon copy owns its whole viewport with its own CSS and shell — no AppShell chrome, no shadcn/Tailwind utility visuals. It **reuses** the expensive proven spine: typed OpenAPI client, auth/session, realtime, i18n, E2E harness.
5. **Ontology-first + render=policy + audit-everywhere** (unchanged from DESIGN §1–5, §4.5): every noun/verb is a typed object with a code and chains; PBAC gates every rendered thing (deny-by-omission; legacy enforce + Cedar shadow during migration); sensitive views are audited.

### Decision drivers (top 3)
1. **Fidelity mandate vs. asset reuse tension.** Discarding `web/`'s typed client + auth + 21-spec real-backend E2E harness burns months and the always-shippable rule; but inheriting its Tailwind/shadcn visuals violates the carbon-copy mandate. The surface strategy must split these cleanly (rebuild visual, import spine).
2. **Backend split is precise (adequacy audit verdict).** Workflow/approval spine + comms/notifications/audit envelope are **live and adequate**; the Foundry-like generic object/automation/lifecycle layer has **near-zero backend**. Phasing must front-load screens whose backend exists and gate the rest behind four small parallel BE charters — plus fix one **live security defect** (engine self-approval, gap #5).
3. **Heavy concurrent-session reality.** ~15 active worktrees (`.worktrees/`: ui-m4/PR#233, audit-chain, notif lanes, m3 spike) + migrations reserved to 0115. The program must branch off `main`, not stack on in-flight lanes, and coordinate migration slots / openapi regen so it doesn't collide.

### Options (≥2 viable)
- **Option A — App-within-app `web/src/console/` at `/console`, own tokens + shell, shared spine. [CHOSEN]**
  Pros: pixel/behavior fidelity (no chrome shared with legacy); grammar built once; reuses client/auth/realtime/E2E; legacy stays fully functional during build; clean final cutover (`/console`→`/`, then delete AppShell). Cons: transient duplicate shells; one router hosts two visual worlds until cutover; console must re-implement primitives legacy already has (intended — they're the wrong visuals).
- **Option B — Strangler re-skin inside `web/` (the superseded prior plan).**
  Pros: least new scaffolding; incremental per-route. Cons: **shares chrome primitives across both shells → cannot reach carbon-copy fidelity**; tokens diluted into Tailwind `@theme`; §4-18 "one grammar" impossible while two shells co-own chrome. **Invalidated by the founder directive** (explicitly supersedes re-skin).
- **Option C — Separate package / repo for the console.**
  Pros: hard visual isolation. Cons: **fractures the single typed OpenAPI client + openapi-regen discipline + auth/session + one CI/E2E harness** — the exact proven assets driver 1 says to keep; duplicate build/deploy; cross-package version skew. Rejected: isolation is achievable in-repo (Option A) without fracturing the spine.

Mode: **SHORT** by default. Escalate this charter to **DELIBERATE** only for the passkey-receipt and audit-chain slices (legal-evidence stakes) — those inherit the prior plan's deliberate-mode treatment (pre-mortem + expanded test plan) at slice time.

---

## 2. Decisions (one per founder question, decisive)

### D1 — Surface strategy: new `web/src/console/` app-within-app at `/console`
A new console app that **owns the whole viewport** under a single `/console` route (nested/catch-all; internal navigation is `state.screen`-driven exactly like the prototype, not React-Router pages). It ships:
- its **own token CSS** — `web/src/console/tokens.css` — copied **verbatim** from `docs/design/oyatie-console/tokens/{colors,typography,spacing,elevation}.css` + `styles.css`, exposed as CSS custom properties under a `.console` theme scope (NOT folded into Tailwind `@theme`);
- its own `ConsoleShell` (sidebar / topbar / comms-rail grid), **no `AppShell` chrome, no shadcn, no Tailwind utility classes** inside `web/src/console/**`;
- **shared, imported (not re-forked):** auth/session, the typed OpenAPI client, realtime, i18n, E2E harness (see D4).

Coexistence: `AppShell` + its ~40 legacy routes stay fully functional at their current paths throughout the build.

**~~Final cutover in one PR~~ — REVERSED 2026-07-09 (founder: "what would hyperscalers do")**: hard swaps are not hyperscaler practice (precedent: FB5 rewrite, YouTube Polymer, Gmail redesigns — all staged). Cutover is a **staged rollout**: (1) server-driven rollout flag (org-runtime-flag, reusing the `org_runtime_flags` substrate) + per-user opt-in toggle ("새 콘솔") with instant revert and a kill switch; (2) percentage ramp gated on RUM error/perf budgets and adoption metrics; (3) legacy deletion only after the D5 endgame criteria AND sustained adoption metrics (the "two release cycles of zero legacy traffic" criterion is the deletion trigger, measured, not declared).

**Hyperscaler operational layer (added 2026-07-09, applies to every P0/P1+ slice):**
- **Grammar = versioned component library**: each P0 primitive (shell, window engine, composer, module template, lifecycle modal, object card) ships with component-level visual-regression states (Playwright component screenshots of its distinct states — e.g. the window engine's 4 states, composer dropdown open/clamped, chip tones). The D2 dual-capture gate covers screens; component snapshots cover the grammar so a regression is caught at the primitive, not the 30 screens composing it.
- **Performance budgets + RUM as launch gates**: CWV budgets per console screen (LCP/INP/CLS thresholds asserted in the E2E rig), real-user monitoring events wired from P0 (route timing + error reporting through the existing OTel path), error budget on the console surface before any ramp-up.
- **Adoption metrics**: console vs legacy route usage counted from the rollout flag's telemetry; deprecation decisions cite the numbers.
**Why:** only a self-owned viewport with verbatim tokens and no shared chrome can be a carbon copy (D-drivers 1); in-repo keeps the one client + auth + CI the spine depends on (rules out C); founder superseded the re-skin (rules out B).

> **Deviation rule (founder, 2026-07-09): do not weaken the carbon-copy directives unless the deviation is a genuine positive addition / fix / polish.** Every divergence from the prototype must be CLASSIFIED and justified in the slice's gate note as exactly one of: (a) accessibility/AA fix (e.g. the `--faint` contrast fix — also pushed back to the design authority), (b) design-charter compliance the prototype itself mandates (§4-12 no-explanatory-UI, §4-18 reuse), or (c) genuine polish with named benefit. Unclassified or convenience deviations = NO-GO. Ratified precedents: minimize→default-zone (prototype wins over AC wording), --faint #5f6d7e (class a), scope-switcher meta-prose drop (class b).

### D2 — Fidelity bar as a merge gate: prototype-vs-build visual verdict + grammar checklist
Every screen slice must clear a **fidelity gate** before merge, mechanized as:
1. **Dual capture (Playwright).** The gate renders the local `Oyatie Console.dc.html` in headless Chromium, navigates it to the target screen/state (selectors + state-setter hooks come from `.omc/research/oyatie/prototype-anatomy/`), and screenshots it; it renders the built console screen at the **same state** on a real backend (persona fixtures, D4) and screenshots it. The two images go to the **`visual-verdict`** skill → structured GO/NO-GO with per-region deltas. `dc.html` exceeds the 256 KiB DesignSync read cap but **renders fine in a browser** — capture, don't read.
2. **Grammar checklist** (from DESIGN §4.7 catalog + §4-12 + §4-18), asserted per slice: window/pin model (header-drag popout ≤54px, dblclick pin-split with real `padding-right`/`-bottom` reservation, tray minimize); list grammar (J/K/Enter, shared-track alignment, column-resize, bottom fade + overscroll-contain); token composer (@/#/! parse + PBAC-gated candidates + plain-text non-interference); **no explanatory UI** (§4-12: no subtitles/protocol captions/"열람됨" meta/chip-echo prose — status=chips, only action-driving copy); **no shape drawn twice** (§4-18: reuse `MOD_SCREENS` cfg, single `lcOpen` card, `TONE()` palette).
3. **Wired-to-real-backend proof.** No fabricated object codes; every displayed code resolves; every row's primary action executes a real mutation with an audit event asserted in E2E.
4. **Legacy-parity coverage note.** If the slice replaces a legacy route's domain, it cites LEGACY-PARITY-BACKLOG items covered or explicitly deferred (D5).

Gate owner: extend the existing **`review-gate`** skill (correctness + RLS-as-`mnt_rt` + codex cross-model + a11y/perf) with the visual-verdict + grammar-checklist axes. A slice is NO-GO if any of the four fail. Prototype-anatomy is the state-source; if a screen's anatomy is not yet extracted, that extraction is the slice's first task (do not eyeball).

> **RATIFIED 2026-07-09 — post-snapshot screens (axis-1 substitute).** For a screen/primitive with **no surface in the mirrored `dc.html`** (added upstream after the Jul-4 snapshot, e.g. `MOD_SCREENS`), the prototype side of the dual capture is unsatisfiable, per SYNC-MANIFEST precedence #3 the **AGENTS.md change log + DESIGN §4.7 grammar catalog ARE the spec**. Axis-1 is then satisfied by: (a) the grammar checklist asserted item-by-item against the §4.7 catalog text + the screen's change-log entries (cite each), and (b) **build-side state captures** of the registered demo component (each distinct state), committed as the visual-regression baseline for future slices. The capture rig must still navigate to and screenshot the BUILT surface — "no prototype region" never waives build-side capture. When a later sync delivers the screen's dc.html surface, the next slice touching it runs the full dual capture retroactively.

### D3 — Phases
**P0 — Foundation grammar (build first; every screen composes it).** Slices P0.1–P0.7 in §3. Tokens verbatim + `.console` theme → `ConsoleShell` chrome (sidebar/topbar/comms-rail grid) → window/pin engine (exact prototype behaviors) → token composer → generic module template (`MOD_SCREENS` config-driven statbar/search/shared-track list/detail kv+links+actions) → lifecycle modal (`lcOpen` single card: stepper/version/rollback/effective-date/archive+dispose gates) → object card (3-layer: 의미 attrs · 동작 lifecycle+audit · 역학 automation/policy/series chips). P0 ships behind `/console` with a real login + scope switcher, gated by the fidelity gate against the prototype's shell + one reference module.

**P1+ — Screens in dependency order** (each = fully-wired vertical slice through the fidelity gate):
- **P1 (personal, highest-traffic, backend live):** overview → mywork → appr. overview + mywork aggregate live engine/notification/attendance reads; **appr rides the verified engine instance REST** (결재함/상신함/claim/decide/finalize/대행/사후반려 — adequacy audit "exists, live"). Blockers: **BE-WF-HARDEN** (self-approval SoD fix gap #5 — *security*, must land before appr decide ships truthfully; SoD-guard portion already DONE #205) and the **submittable-templates catalog gap** surfaced by PR #233 (normal initiators have no live source for the 기안 gallery — needs an all-employee "submittable definitions" endpoint before compose ships; **do not stub the gallery**).
- **P2 (comms cluster — share the rail):** msgr → mail → notif. Backend live (notifications/realtime #198 merged; messenger REST live). `message_refs` parse-on-write (gap #21, in BE-OBJ) upgrades mentions to live refs.
- **P3 (modules ride the generic template + object substrate):** finance · purchase · inventory · asset · maintenance · field · compliance · laborcost · board · directory — each a thin domain binding on the P0 generic template, standing on **BE-OBJ** (resolve/codes/links) + **BE-LC** (lifecycle/versioning/effective-dating/period-locks). Then audit (BE audit-chain), policy+auto (**BE-AUTO** — hard-blocks UI-M11), object-explorer graph (recursive-CTE over `object_links`), Cedar no-code canvas (rides Cedar promotion).
- **P-Mobile (later):** `Oyatie Mobile.dc.html` (7-module employee app) — own charter, pairs with the native-app direction (memory `native-app-identifiers`).

Backend charters (from the adequacy audit; run in parallel worktrees, each merges before its named UI consumer): **BE-OBJ** (resolve + canonical codes + `object_links` + AuditQuery target_id/trace_id + `message_refs` + sales DELETE→UPDATE; slice-1 MERGED #206) · **BE-WF-HARDEN** (run-read surface + SoD self-approval guard) · **BE-AUTO** (trigger bindings + cron schedules + condition/branch nodes) · **BE-LC** (lifecycle FSM + generalized versioning + effective-dating + period-locks + retention/legal-hold). Plus **Audit-Chain** (`feat/audit-chain-l20`, existing lane).

### D4 — Transferable assets (import; do not re-fork) vs. rebuild
**TRANSFER (shared spine, imported by `web/src/console/`):**
- **Typed OpenAPI client + read cache** — `web/src/api/{client.ts,refresh.ts,types.ts,client-cache.ts,device.ts}` (openapi-fetch + generated types). Single client, single regen (D6).
- **Auth/session/dev-auth** — `web/src/context/auth.tsx`, `web/src/auth/*`, `web/src/features/auth/RoleSwitcher.tsx`, `web/src/api/refresh.ts`. Shell-agnostic; the console mounts inside the same auth provider.
- **Object wiring logic** — `web/src/components/object/ObjectLink.tsx`, `web/src/features/object-view/ObjectViewScaffold.tsx` (on `main`), and `objectRegistry.ts` (currently on the `pr209-ui-m3` lane). Transfer the **dispatch/resolve logic**, re-skin the rendering.
- **Engine decide flows** — the wiring in PR #233 (`.worktrees/ui-m4/web/src/pages/{EApprovalsPage,OverviewPage}.tsx`: `workflow-runs`/`workflow-tasks`/`decide` calls). Transfer the data flow, **not** the JSX.
- **Realtime** — `web/src/lib/notification-events.ts` (+ `/api/v1/ws` bridge).
- **E2E harness (major asset)** — root `playwright.config.ts` + `e2e/{fixtures/personas.ts,roles.ts,auth.ts, harness/boot-backend.sh,db.sh,seed-*.sql, specs/*}`. Real-backend, persona-based (admin/exec/mech/recp) browser E2E — this is the substrate for the D2 fidelity gate, the route-smoke matrix, and the PBAC persona matrix.
- **i18n** — `web/src/i18n/ko.ts` corpus + the `check-ui-strings` gate. Korean-first labels per design vocab.

**REBUILD (legacy visual — must NOT carry into `web/src/console/`):**
- `web/src/components/shell/*` (AppShell chrome), `web/src/components/ui/*` (shadcn/Tailwind primitives), `web/src/styles.css` Tailwind `@theme`, all `web/src/pages/*` JSX. These are the wrong look by definition.
- **Decision item (BE-OBJ slice-2, from the 2026-07-09 simplify pass):** backend `url_path_for` (`backend/app/src/objects.rs:570`) and frontend `objectRegistry` route closures are two kind→URL tables that **already diverge** (support_ticket path mismatch) and `url_path` has zero web consumers. Before the console wires object resolution: pick **one** authority — (a) client trusts server `url_path`, drop per-kind closures; or (b) delete `url_path_for`, `objectRegistry` stays sole router. Ship one, not both.

### D5 — Legacy = gap reference (unchanged register, new consumer)
`LEGACY-PARITY-BACKLOG.md` stays the **unchanged superset register**; its **new consumer** is the D2 fidelity gate. Each console slice that covers a legacy route's domain must cover or explicitly defer that route's backlog items in its merge-gate note. The **AppShell-deletion endgame** = the adequacy audit's 6 criteria (every legacy route has a parity-verified ConsoleShell replacement; no fabricated codes; all mutations audited + SoD live; `/me/authz` sole gating source; period-locks/view-audit/passkey proven in E2E; two release cycles of zero legacy-route traffic) **AND** every backlog item shipped or founder-descoped. **Tier-1 items 1–4** (identity/credential admin, onboarding, self-service credentials, 4대보험/offboarding — the "operations through console only" path + Korean legal payroll) are **hard blockers** for any wholesale legacy deletion; item 5 (`/platform/*` operator console) blocks deletion of those routes specifically and needs a separate-program vs operator-module decision.

### D6 — Collision / coordination
- **Migration slots:** next free = **0116** (verified: highest across all branches = 0115; the working tree shows 0096, with 0097–0115 reserved by in-flight lanes). Backend charters claim contiguous blocks from 0116 up, recorded in a shared reservation note before writing.
- **OpenAPI regen discipline:** every BE charter that adds routes regenerates the typed client; the console imports the **same** client, so the `client-drift` CI gate must be green before any consumer slice merges. One client, one regen — never a console-private fork.
- **Concurrent sessions:** branch off `main` as `feat/console-cc-*` (one PR per slice, CI-gated); **do not stack** on `.worktrees/ui-m4`, `audit-chain`, notif, or spike lanes. Rebase forward as each BE charter merges. Reuse PR #233 / M3-spike work by transferring logic (D4), not by branching off their worktrees.
- **Mobile:** `Oyatie Mobile.dc.html` is a **later phase (P-Mobile)** with its own charter; not in P0–P3 scope.

---

## 3. Slice-by-slice — P0 foundation + first 3 screen slices

Each slice = one PR to `main`, CI green, through the D2 fidelity gate. Cross-cutting rules (every slice): TDD for logic; Vitest + Testing Library units; **Playwright browser E2E on a real backend** with persona fixtures; `ko.ts` for every string (`check-ui-strings`); backend slices use clean-arch crates + sqlx migrations (migration-safety gate) + RLS `with_org_conn` **verified as `mnt_rt`** (rls-arming gate) + `with_audit` on every mutation; WCAG AA; window grammar keyboard-operable; reduced-motion respected.

### P0.0 — Prototype-anatomy consumption + app scaffold
Consume `.omc/research/oyatie/prototype-anatomy/` (if absent, extract it first as this slice's task). Scaffold `web/src/console/` mounted at `/console` inside the shared auth provider; copy tokens verbatim into `console/tokens.css` under `.console`; establish the Playwright dual-capture rig (dc.html headless render + state navigation + `visual-verdict` wiring).
- **AC:** `/console` renders an empty themed viewport behind real login; token values byte-match the mirror; dual-capture rig produces a GO on a trivial reference element; zero shadcn/Tailwind class in `console/**` (lint rule); storefront + legacy routes unchanged (route-smoke matrix green).

### P0.1 — ConsoleShell chrome (sidebar / topbar / comms-rail grid)
Grid shell: grouped nav sidebar (persona deny-by-omission filter via `/me/authz` when live, JWT-derived hint until then) + badges + collapse; topbar with scope switcher (**"그룹 전체" = union of authorized 법인**, bound to identity org API, never literal-all) + ⌘K trigger + user/role card; comms-rail column (collapsed strip; wired views arrive in P2 — no unwired chrome). Mobile off-canvas drawer behavior deferred to P-Mobile.
- **AC:** fidelity gate GO vs prototype shell (all states: collapsed/expanded, rail strip); scope switcher lists only authorized entities (PBAC persona E2E); keyboard + axe; no explanatory copy (§4-12 checklist).

### P0.2 — Window / pin engine (the grammar's spine)
Exact prototype behaviors, defined centrally (`cardVal`/`cardToolVals`/`cardGrab`/`cardPinRight`/`cardRestoreDefault` equivalents + single pin-panel header): 4 states (grid / pin-split / popout-float / tray-minimize); header-drag ≤54px = popout (grid-tick magnet, non-interactive-element guard); dblclick = pin-split with **real body `padding-right`/`-bottom` reservation** (not overlay); tray minimize/restore; float = `position:fixed;visibility:visible` surviving screen changes; per-user layout persisted via `GET/PUT /api/v1/me/workspace` (RLS owner-only, audited writes, sanitized on load).
- **AC:** E2E — pin a panel, switch screen and back (survives, mounted-persistent), reload (layout restored server-side), minimize→tray→restore-as-float; header-drag doesn't fire on buttons/inputs/rows; fidelity gate GO vs prototype window interactions; workspace endpoint RLS verified as `mnt_rt`.

### P0.3 — Token composer (@ / # / !)
Single parser/renderer for **all** inputs (기안/할일/메신저/메일/코멘트): `@`=mention→notify, `#`=object link→no-notify, `!CODE-NNNN`=code link; search dropdown with viewport flip/clamp; **PBAC-gated candidates** (only authorized objects; `!` to unauthorized does not link — deny-by-omission); plain-text non-interference (`example@x.com`, `#23`, `주의!!`); explicit-confirm only (click/Tab; space/Enter never auto-select).
- **AC:** unit suite covers every non-interference + trigger case in the DESIGN §4.7-7 spec; integration — `@` in a messenger-backed input yields recipient unread + WS event, `#` does not; unauthorized code fails to link (PBAC persona); fidelity gate GO vs prototype dropdown.

### P0.4 — Generic module template + P0.5 lifecycle modal + P0.6 object card
`MOD_SCREENS`-style single config → generic screen (compact 1-row statbar, multi-attr search, shared-track list with J/K/Enter + column-resize + fade, detail = kv + link chips + domain primary action). `lcOpen` single lifecycle card (stepper 초안→검토·결재→활성→보관→폐기, version history + non-destructive rollback, effective-date on draft only, archive gate = referential-integrity settle, dispose gate = retention/legal-hold). Object card 3-layer (의미 attrs · 동작 lifecycle+audit history · 역학 automation/policy/series chips) with relation-drawing (code-input/drag-drop edge, audited).
- **AC (per sub-slice):** one reference module renders through the generic template from a real domain read; `lcOpen` drives a real lifecycle transition (audited, version+rollback) on a domain that has a backend today; object card resolves a real object + its real audit timeline (needs BE-OBJ AuditQuery target_id — smallest gap, do first); §4-18 checklist (no duplicated shapes); fidelity gate GO. Where the generic lifecycle backend is absent, the sub-slice binds only the domains with live FSMs and names **BE-LC** as the blocker for the rest (no decorative ribbons).

### P1.1 — overview (통합 개요) [first screen slice]
Unified action inbox aggregating **real** pending items (approvals-for-me via engine instance REST, dispatch offers, support tickets, attendance exceptions) with kind filters/counts, J/K/Enter, done/undo → real mutations; Today/Plan panel (todos CRUD — small `todos` domain + scope chips + object links; punch status from attendance); KPI statbar from reporting APIs — **every number drills to its source object** (§4.7-9). Replaces `/work-hub`.
- **AC:** fidelity gate GO vs prototype overview; every row's primary action executes the real mutation with an audit event asserted in E2E; empty/error/loading states; scope filter = authorized entities only; LEGACY-PARITY note vs `DailyPlanPage` (item 9) + `OperationsIntelligencePage` (item 23).

### P1.2 — mywork (내 업무) [second screen slice]
Live `state` aggregation for the current viewer/persona: my turn in 결재함, my dispatch queue, in-progress 상신, receipts awaiting confirm, unread notifications — each row opens the real object / 처리 패널. Data-scope gated to the viewer (the design's own fix: non-admin personas must not see another owner's 상신함/수신함/알림 — deny-by-omission).
- **AC:** fidelity gate GO; persona E2E proves scope isolation (admin vs 반장 vs 사무직 see different, correctly-owned rows); stat tiles drill to real screens; audit on any action taken; no fabricated codes.

### P1.3 — appr (전자결재) [third screen slice] — deliberate-mode
결재함/상신함/기안 tabs on the **live engine instance REST**; approval pin panel (line, comment-required 반려/거부, 승인); progress timelines bound to the run-read endpoints; 종결 (author finalize; 대행 + 사후반려 policy-gated — legacy enforce, Cedar shadow — reason + audit + line-wide notify); compose (사유 enum, 대상 지정 = object links via registry + token composer, auto 결재선 preview) — **gated on the submittable-definitions catalog endpoint** (BE follow-up; gallery must not be stubbed) and **BE-WF-HARDEN self-approval guard** (security).
- **AC:** E2E compose → line advances via **real** engine transitions → 최종승인 → author 종결 → appears in a docs-archive query; **self-approval is rejected** (SoD guard, security regression test); 사후반려 produces a compensating document + notifications; all transitions audited; fidelity gate GO vs prototype appr; canonical codes only (BE-OBJ issuance). Deliberate treatment: pre-mortem for the finalization/receipt model + expanded test plan (unit FSM invariants · integration engine templates · E2E round-trip · audit-event observability).

---

## 4. Pre-mortem (3 scenarios)
1. **Fidelity gate is too noisy to be a gate** (anti-aliasing/font/scroll-position deltas flood visual-verdict → teams rubber-stamp NO-GOs into GOs). Mitigation: capture at fixed viewport + disabled animations + `prefers-reduced-motion`; verdict scores per semantic region with a tolerance band; the grammar checklist (deterministic) is the hard gate, the pixel diff is advisory-with-threshold. Anatomy provides stable state selectors so both sides land on the identical state.
2. **Backend charters slip and P3 modules pile up behind BE-OBJ/BE-LC.** Mitigation: P1/P2 depend only on **live** backend (engine REST, notifications, audit, att/pay/hr) and carry the program alone; BE-OBJ slice-1 already merged (#206); each module slice names its exact blocker and is not started until it merges — no decorative lifecycle ribbons shipped ahead of BE-LC.
3. **Two-shell period leaks legacy visuals or a half-cutover ships.** Mitigation: `console/**` lint bans Tailwind/shadcn imports; route-smoke matrix asserts legacy routes stay intact every slice; cutover is a single gated PR only after the D5 endgame criteria + Tier-1 items hold — never partial.

## 5. Expanded test plan (deliberate slices)
- **Unit:** window store (snap/evict/dedupe/sanitize); token-composer parser (trigger/non-interference/PBAC); lifecycle FSM invariants; object-registry dispatch; engine FSM terminal-node invariant.
- **Integration (real backend, sqlx::test as `mnt_rt`):** per-screen API binding; engine templates (old payroll + generalized); workspace-profile RLS; BE-WF-HARDEN self-approval guard.
- **E2E (Playwright, real backend, persona fixtures + dev-auth):** fidelity dual-capture per screen; window-grammar persistence; overview action round-trip; appr compose→종결 + self-approval-rejected; PBAC persona matrix; route-smoke matrix (legacy intact); axe per screen.
- **Observability:** audit events asserted in E2E (existence, decision, actor); no PII in logs; client-drift gate green after every openapi regen.

## 6. ADR — Oyatie Carbon-Copy Console
- **Decision:** Build a from-scratch carbon-copy console as an app-within-app at `web/src/console/` (`/console`), owning its viewport with verbatim prototype tokens and its own `ConsoleShell` (no AppShell/shadcn/Tailwind visuals), reusing the shared typed client / auth / realtime / i18n / E2E spine. Grammar (tokens, shell, window engine, token composer, generic template, lifecycle modal, object card) is built once in P0; screens follow in dependency order (overview→mywork→appr→comms→modules), each fully wired to real backend through a fidelity merge gate (prototype dual-capture visual-verdict + §4.7/§4-12/§4-18 grammar checklist + wired proof + legacy-parity note). Four parallel backend charters (BE-OBJ, BE-WF-HARDEN, BE-AUTO, BE-LC) + Audit-Chain close the object/automation/lifecycle backend gaps; one is a live security fix (engine self-approval).
- **Drivers:** carbon-copy fidelity mandate (needs zero visual inheritance); precise backend split (spine live, object layer near-empty); heavy concurrent-worktree reality (no stacking, coordinated 0116+ slots + one openapi regen).
- **Alternatives considered:** (B) strangler re-skin inside `web/` — invalidated by the founder directive (shares the chrome it must replace, can't reach fidelity); (C) separate package/repo — rejected (fractures the single client + auth + CI/E2E the reuse driver depends on); isolation achieved in-repo instead.
- **Why chosen:** A is the only option that delivers pixel/behavior fidelity **and** keeps the expensive proven spine **and** keeps legacy shippable during build with a clean single-PR cutover.
- **Consequences:** transient two-shell period (mitigated by lint + route-smoke + gated cutover); a Zustand-style workspace store enters for the window engine only (data stays on openapi-fetch); new domains (todos, notifications already merged, inbox, etc.) + four BE charters land as crates; the prototype-anatomy extraction becomes a hard dependency of the fidelity gate.
- **Follow-ups:** prototype-anatomy extraction lane; BE-OBJ slice-2 `url_path` authority decision (server vs client, not both); submittable-definitions catalog endpoint before appr compose; Cedar enforce-flip + covert clearance charter; P-Mobile charter; `/platform/*` operator program vs operator-module decision (LEGACY item 5).

## 7. Open questions (persisted to `.omc/plans/open-questions.md`)
1. BE-OBJ slice-2: is `url_path` authority (a) server-trusted or (b) client-only? Ship one.
2. P3 module internal order (finance/purchase/inventory/asset/maintenance/field/compliance/laborcost/board/directory) — business priority?
3. `/platform/*` operator console (LEGACY item 5): separate operator program or operator-scoped module?
4. Cutover trigger: two release cycles of zero legacy-route traffic — is nav telemetry in place to measure it, or is a manual founder sign-off the gate?
5. Fidelity pixel-diff tolerance band: who owns the threshold, and is visual-verdict advisory-with-threshold or a hard blocker alongside the grammar checklist?
