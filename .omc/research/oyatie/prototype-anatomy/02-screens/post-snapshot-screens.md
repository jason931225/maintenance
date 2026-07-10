# Screens added after the Jul-4 snapshot — spec from AGENTS.md changelog only

**UNVERIFIED-AGAINST-SNAPSHOT for every screen in this file.** None of these have template or logic source read directly (the Jul-4 `Oyatie Console.dc.html` predates all of them — confirmed earlier via `grep` returning zero hits for `ingest`/`explore`/`notif`/`map`/`dashboard`/`mywork`/module-prefix strings in the snapshot file, and only stub-toast nav wiring for `mail`/`msgr`/`dispatch`). Everything below is reconstructed from `AGENTS.md` §5 changelog prose (entries dated 2026-07-04 through 2026-07-09) plus `DESIGN.md` §4.7-4.8. Treat as a specification to build toward, not a transcription of working code — method names, state keys, and exact field lists are best-effort inference from changelog wording, not verified reads.

---

## 인제스트 (Data Ingest) — `screen:"ingest"`

Changelog 2026-07-04(5)(6). Deterministic (no-AI) data-integration pipeline, benchmarked against Palantir Foundry (Pipeline/Data Connection/Ontology/Lineage) + Rossum/ABBYY/Textract (deterministic OCR) + Airbyte/Fivetran (connectors).

- **Sources**: 11 file types + photo/video/ZIP + arbitrary files + external API connectors.
- **Pipeline** (7 deterministic stages, no LLM/AI step): 파싱/OCR(parse/OCR) → 정제(clean) → 분류·템플릿(classify+template) → 매핑(field mapping) → 검증(validate) → 온톨로지 적재(load into ontology).
- **Screen layout**: queue (filter+search+J/K nav) + a 7-stage pipeline visualization + source preview panel (scanned-doc OCR region overlay, table extraction preview, JSON preview, media player, ZIP tree, failure state) + field-mapping review (confidence score + provenance source shown per field, inline verify/correct) + final ontology commit step.
- **Object code**: `DX-` (ingest job).
- **Methods** (named, not read): `ingestAdvance`/`ingestUpload`/`ingestConnPoll`(external API connector polling)/`ingestFieldEdit`/`ingestVerify`/`ingestCommit`/`ingestAutoToggle`/ingest-screen J/K nav handler.
- **Seed workflows feeding it**: `wf5` (나라장터 = Korean government e-procurement portal) and `wf6` (오픈뱅킹 = Korean open-banking) — external-API ingest workflows wired as automation-triggered pipeline runs.
- **Verified-in-demo-only outcomes**: a contract document → `C-208`; a 나라장터 bid notice → `Bid-633`, both landing as committed ontology objects + an audit event.
- **Downstream**: a committed ingest row's click target IS the generic lifecycle card (item 7 in `03-systems.md`) — ingest and lifecycle are directly coupled.

## 객체 탐색 (Object Explorer) — `screen:"explore"`

Changelog 2026-07-04(7), extended 2026-07-08(11)(12)(13), (24) client nodes, (14) node-search. Fully described under `03-systems.md` §9 (ONTOLOGY_GRAPH). Screen-specific notes: radial SVG graph + center-object card + upstream/downstream panels + type-legend (clickable → type card); side panel carries "+ 새 개체" (create node) and object-search-across-the-whole-graph (by name/code/type). Verified-in-demo traversal: `c207`(contract) → `att_cho`(attendance) → `pay_cho`(payroll), over a 20-node graph at initial build (later much larger once all 10 modules merged in).

## 메일 (Mail, full view) — `screen:"mail"`

Changelog 2026-07-04(8)(9)(10). Backend decision: **mox** (github.com/mjl-/mox, Go, MIT license — chosen specifically because MIT permits a heavy fork, unlike the AGPL office-editor decision) — an all-in-one mail server (IMAP4rev2/SMTP/SPF/DKIM/DMARC/MTA-STS/DANE/at-rest encryption/webapi+webhooks), fronted by a fully custom UI (no mox web UI reused) shared between the rail-summary and this full-view surface (same state, per DESIGN §4.8 rail↔main promotion).

- **Layout** (as of (10), consolidated from an initial 3-pane to a single unified surface): folders (7 types: inbox/sent/draft/archive/spam/trash + presumably one more) + list + reading pane, merged into ONE card with thin dividers rather than 3 separate floating cards (explicit anti-slop correction, §4-12 caption sweep applied here first).
- **Seed**: 13 mails across the 7 folders.
- **Security/governance surface**: per-mail sender-authentication panel (SPF/DKIM/DMARC pass/fail), TLS-in-transit + at-rest-encryption indicators, classification (대외비/민감/격리 quarantine), PBAC, retention + litigation-hold flags.
- **Attachment handling**: attachments route through ingest (→`DX-`) or evidence registration, not raw file storage — consistent with DESIGN §4-13 "파일=경계 포맷, 개체=1급" (files are boundary formats; objects are first-class — an attached file becomes a structured object via ingest, the raw file is a secondary provenance artifact).
- **Composer**: classification selector, DLP external-send warning (the egress gate from `03-systems.md` §13), mox SMTP send with DKIM signing shown as a status indicator.
- **Spam example**: a seeded DMARC-fail phishing email, used to demonstrate the security panel actually differentiating.
- **Object linking**: `mailTag`-equivalent — a mail can carry a linked-task tag chip (present already VERIFIED-IN-SNAPSHOT in the rail mail-read view per `00-shell.md`, so this is a continuity, not new).
- **Audit**: every read AND every send is logged (full-coverage, not sampled).

## 메신저 (Messenger, full view) — `screen:"msgr"`

Changelog 2026-07-08(7)(8)(8b)(9c). Benchmark: Slack/Teams parity, explicitly pursued in stages.
- **State sharing**: reuses the SAME `threads` state as the rail summary (DESIGN §4.8 rail↔main — clicking 메신저 in the sidebar nav promotes the rail's messenger section to a full 2-pane screen: thread list + conversation, and it disappears from the rail while active).
- **Stage 1 (7)**: 2-pane layout, bubble rendering, send (`msgrSend`), drag-drop reference attachment (reusing the object-drag payload from `dropToken`/`snapDrop`), `msgParts` real object-code+mention linking. Verified in a demo message: "WO-2643 배차 확인 부탁 @김성호" renders both the WO- code and the mention as live links.
- **Stage 2 (8)**: message grouping by consecutive-sender (`headOn`), an unread divider line (`msgrDiv`), conversation+in-thread content search (`msgrQ`), `@mention` → notification + audit (`msgrSend`), and a message→todo conversion action (hover button, `msgrTodo` → `addTodoToDay`, tying messenger directly into the Overview today/plan pane's todo list — VERIFIED-IN-SNAPSHOT `addTodoToDay` already exists as a generic day-todo mutator at line 4149, reused here).
- **Stage 3 (8b, Slack/Teams parity)**: sidebar channel(`#`)/direct-message sections + presence indicators (`PRESENCE`), acknowledgment toggle with a count chip (`msgrAck`), reply-quoting (`msgrQuote` → renders a quoted-block in the reply bubble), header object-code chip (auto-extracted from thread content → `objectLinkGo`), composer autocomplete unifying `@PEOPLE` + all known object codes across `items`+`egressDocs`+the graph (`msgrKnownCodes`, full arrow-key/Enter/Tab/Esc keyboard support).
- **Stage 4 mute (2026-07-09(33), item ⑥)**: Slack-style thread mute — header bell toggle + a bell-off icon on muted rows in the list + unread-badge/tab-total suppression for muted threads. Explicitly modeled as a personal-setting whitelisted for direct-save (see `03-systems.md` §7's save/apply whitelist — mute state is NOT lifecycle-governed).
- **Bugfix note** (9c): a crash where `tokenRender(...).map(...)` was called on a React-element return (not an array) took down the ENTIRE app's `renderVals()` on every render — fixed by having `msgParts` return a plain array. **This is a real gotcha for a carbon-copy React/TS implementation**: any shared render-helper used inside a `.map()` call site MUST return an array type, or one bad call site anywhere in the tree can crash the whole render pass. Also fixed: message-pane scroll landing (`_msgrScrollSync` in `componentDidUpdate`, lands on the unread-divider `[data-msgr-div]` element or bottom-of-thread on entry, always bottom on send — explicitly NOT using `scrollIntoView`, using manual `scrollTop` arithmetic instead, per an existing project convention).

## 알림 (Notifications, full view) — `screen:"notif"`

Changelog 2026-07-08(8b) mentions it was built in the same interrupted-work session as msgr/map/회의(meeting)-`MT-`; 2026-07-08(9) fixes the crash originating in `notifRows.segs`; 2026-07-08(15) adds row-click → `notifClick` with a code-fallback to `objectLinkGo`.
- Full-view promotion of the rail's notification section (same `notifs[]` state per rail↔main sharing).
- Row content renders through the same token-linking system as messenger (`notifRows.segs`, i.e. notification text bodies can embed live object-code/mention links, not just plain text).
- Row click → `notifClick(n)`, following `n.link` when present, else falling back to extracting an object code from the text and routing via `objectLinkGo`.

## 운영 지도 (Operations Map) — `screen:"map"`

Changelog 2026-07-08(15) [template built — the vals-only-no-template gap, same class of issue as `auto` in the snapshot, see `02-screens/auto.md`], (20) [authoring/right-click], (24) [client geo], (35) [Korea schematic terrain], and a nav rename from "전술 지도" (tactical map) to "운영 지도" (operations map) at (10).

- **Layout**: stat bar + 4 overlay types + pulsing site markers (selection ring) + unit-layer markers (FL-/기사(driver)/BUS — forklifts, drivers, buses) + a per-overlay queue side-panel (e.g. the dispatch overlay's queue panel carries a "처리" (process) CTA per row, tying the map directly into the dispatch pipeline — see `mapSel`/`mapOv` two-way binding with the dispatch screen: "배차 행 「지도에서 보기」" lets a dispatch-queue row open its location on the map, and selecting a map marker can drive the dispatch queue panel).
- **Authoring** (20): an 편집(edit) toggle enables marker drag-to-reposition (`mapPos`) and a "+ 현장" (add site) DRAFT-marker flow (dashed styling until confirmed) via canvas right-click; right-click also opens a context menu on existing markers (요약/이동/근태/배차/이슈 기안/[draft]개편결재 — summary/navigate/attendance/dispatch/issue-draft/org-restructure-draft) and on empty canvas (현장 추가/add site). Esc and outside-click close menus. Marker click alone (no modifier) selects it and opens a **현장 요약 카드** (site summary card) in the queue panel.
- **Terrain** (35): a simplified Korean-peninsula schematic (coastline path + Jeju island + a dotted DMZ line + a highlighted west coast) rendered from pure SVG/token-color paths — explicitly NO external map tile provider — with markers positioned to roughly match real coordinates ("좌표 declutter" = anti-overlap jitter for close-together markers).
- **Object codes involved**: FL- (forklift/equipment units), presumably WO- for dispatch overlay rows.

## 대시보드 (Dashboard) — `screen:"dashboard"`

Changelog 2026-07-08(1) [v1 — stat bar, contract profitability, 6-month labor-cost trend, site coverage, my-metrics, ALL numbers click-through to source objects, zero non-interactive decorative numbers per the analysis=drill invariant], extended 2026-07-08(11)(f) [5 auto-derived "인사이트" (insight) `AN-` objects, each with an evidence chain + a prescribed corrective action + graph membership], 2026-07-09(32) item ⑤ [scope×period matrix].

- **Scope × period matrix** (32⑤): PBAC-scoped segments (i.e. which entity/site slices a viewer is authorized to see) crossed with an as-of / time-period selector; named example data points KNL `C-311` and a "본사 빈 상태" (headquarters empty-state) case, implying the matrix must gracefully render zero-data cells per scope×period cell rather than erroring.
- **Every number is a drill target** (DESIGN §4.7.9 "분석=drill 불변식"): clicking any stat/bar/row on the dashboard navigates to the underlying source object(s) — this is a hard invariant across the whole app's analytics surfaces, not dashboard-specific, but the dashboard is its primary showcase.
- **Insight objects (`AN-`)**: 5 seeded derived-analysis objects, each carrying an explicit evidence chain (which source rows produced this insight) and a "처방 액션" (prescribed action, i.e. a suggested next step, presumably a pre-filled draft or workflow trigger) and appearing as regular nodes in the ontology graph (so an insight is drillable from Explore too, not just from Dashboard).

## 배차 (Dispatch) — `screen:"dispatch"`

Changelog 2026-07-08(14) [screen built, resolving a prior nav stub], 2026-07-09(32) item ③ [SLA lanes], (35) terrain map integration.

- **Layout**: WO- queue × candidate-driver picker × SLA countdown, with a processing panel reused from the existing dispatch-detail-panel pattern (VERIFIED-IN-SNAPSHOT precursor: the `modalDispatch` variant of the TASK DETAIL MODAL, `00-shell.md`, already implements driver-pick + confirm — this screen generalizes that into a dedicated full-screen queue view rather than only a modal/panel).
- **SLA lanes** (2026-07-09(32)③, described generically as "정비 SLA 큐 — 모듈 제네릭 lanes 칸반" i.e. built as part of the maintenance module's generic kanban-lanes feature, but the same lane primitive is implied to serve dispatch's SLA tracking too): a Kanban-style lane view bucketing work items by SLA status (e.g. on-track / at-risk / breached), reusable as a generic `MOD_SCREENS` display mode.
- **`runLog`** (2026-07-09(32)②, described under the automation/n8n-style execution-log feature, but relevant to dispatch since dispatch is workflow-triggered): an execution-log timeline (à la n8n) showing generated-object chips per run + error/retry states — applies to any workflow-triggered pipeline, dispatch's auto-created work orders included.
- **Map coupling**: bidirectional with `screen:"map"` via `mapSel`/`mapOv` (see above).

## 내 업무 (My Work) — `screen:"mywork"`

Changelog 2026-07-08(14) [built, folded former "개요" duplicate nav items into this + removed a redundant "개인" nav group], (17) [verification pass], (25) [critical data-scope leak fix], 2026-07-09(32)① [notification rows resolve to real object content], (33) real content continued.

- **Live-aggregated personal dashboard**: "내 차례" (my turn — pending approvals/dispatches awaiting THIS user specifically), in-progress submissions (상신 중), receipt-confirmations pending (수령확인 대기).
- **Persona-relative** (per `03-systems.md` §10 view-as): a non-admin persona (example given: 반장/foreman) sees "본인 상신+배차" (own submissions+dispatch) instead of the admin's global aggregate — a distinct "내 상신" (my submissions) sub-view branch exists specifically for this.
- **Data-scope leak fix (25)**: originally, switching to a non-admin persona still leaked the seeded superuser's OWN `apprMySubs`/`inboxDocs`/notification rows. Fixed by gating every "my X" list explicitly to the CURRENT viewer's ownership (v1 = strict owner-match, deny-by-omission). **Load-bearing lesson for the carbon copy**: any personal-data list (submitted-approvals, personal inbox, my-notifications, etc.) must filter by the authenticated principal server-side, not just client-render-conditionally — a frontend-only persona switch that still fetches/holds another user's full personal dataset in state is itself the vulnerability class this bug represents; a real backend must scope these queries by session identity, never trust a client-selected "viewer".
- **Notification-row real-content resolution (32①)**: previously notification rows may have shown only a generic label; the fix resolves the underlying object code to real content (건명/title, 요청자/requester, 마감/deadline, 증빙 kv/evidence fields) and routes click directly into the processing panel. A recursion/crash bug is noted as a build lesson: "MOD_SCREENS 내 lcKnown 재귀 크래시 수정 — 빌드 중 modObjOf 호출 금지" (calling `modObjOf` during a build/render pass inside `MOD_SCREENS`'s `lcKnown` check caused infinite recursion — avoid calling object-resolution helpers from within the same render pass that's still constructing the module registry they depend on).

## 모듈 서피스 10종 (10 generic module screens)

Changelog 2026-07-08(3) [built via `MOD_SCREENS()`, see `03-systems.md` §8 for the generic template], (24) [거래처/client object type], (26) [inventory quantity-bar + asset lifecycle-timeline display extensions], (30) [board progress-bar generic field], (33) [compliance control/evidence matrix].

| Module | Object code | Notes |
|---|---|---|
| finance (재무) | `VC-` (전표/voucher) | Linked to wf6 automation + payroll + AP- approvals |
| purchase (구매) | `PO-` | |
| inventory (재고) | `IV-` | Display: quantity-bar matrix (현재고/안전재고 tick marks / monthly consumption, shortage = danger tone) |
| asset (자산) | asset codes (e.g. `FL-`/GPU/BUS prefixes reused from map units) | Display: lifecycle timeline (event dots + dashed future events + code-row drill) |
| maintenance (정비) | `WO-` (reused directly from the VERIFIED-IN-SNAPSHOT work-order shape in `items[]`) | Has a processing panel; also hosts the generic SLA-lanes kanban feature |
| field (고객·현장) | — | Cross-references 현장×계약×SLA (site × contract × SLA); has 4 client-relationship (`CL-`) links |
| compliance (컴플라이언스) | `CP-` (의무/obligation) | Generic `ctl` (control) field + evidence-drill matrix (2026-07-09(33)⑧, benchmarked against Vanta); also hosts `FW-01~04` standard-framework objects (SOC2/ISO 27001/17/18/SSO-SCIM/tenancy-isolation/KMS/STRIDE/IR-800-61/OTel/SLO/SIEM control mappings, changelog 2026-07-08(19)) — principle stated explicitly: "문서가 아니라 작동 기능이 증거" (the working feature IS the evidence, not a document describing it) |
| laborcost (인건비) | — | Per-contract cost breakdown + forecast; feeds Dashboard's labor-cost trend |
| board (게시판·공지) | `NT-` | Receipt-confirmation progress bar (generic `prog` field: done/total → completion bar, ok if 100% else warn) |
| directory (주소록) | — | Dynamically built FROM the `PEOPLE` registry (VERIFIED-IN-SNAPSHOT data source, `03-systems.md`/`00-shell.md` personnel card) rather than separately seeded |

`거래처` (Client/CL-) is a persistent cross-module object (changelog (24)): 4 seeded clients joining the graph via transaction-chain + site edges, referenced from the field module and elsewhere; its type (`OT-12`) transitioned draft→active in this same slice.

## Evidence archiving (`EV-` objects) + in-console office editor shell — POST-SNAPSHOT (P3-P4 epic, UI contract only)

Changelog 2026-07-09(34). Not a nav screen — surfaces inside 문서·기록물 (docs) and object cards.
- **`EV-101~103`** evidence objects: a "증거" (evidence) filter on the docs screen; each evidence object's card shows SHA-256 hash + TSA (timestamp authority) proof, WORM-separated original-vs-derivative copies, a chain-of-custody history list, an "적격" (admissible/eligible) status chip, and a legal-hold gate blocking disposal.
- **Office editor shell** (demoed against `C-209`, a DOCX): an edit modal — a `contentEditable` document canvas with dirty-state audit tracking, a version rail (each save creates an immutable new version; restoring an old version is non-destructive, i.e. it creates a NEW version copying the old content rather than overwriting), a PBAC access matrix, DLP indicator chips, and a collaborators list. Entry point: an object card's "문서 편집" (edit document) action. This is explicitly a **UI contract only** — per `HANDOFF.md` §12 (referenced, not read in this pass) the real backend is meant to be a heavy AGPL fork of ONLYOFFICE DocumentServer with audit/PBAC/compliance/secrecy-protection integrated INSIDE the editor itself (host-owned versioning/rollback/approval-gated-publish/collaboration) — i.e. this modal is a frontend stand-in for a large, separately-chartered backend integration, not something a carbon-copy build should treat as "just wire up an API."

## Mobile shell (`<768px`) — POST-SNAPSHOT

Changelog 2026-07-08(27) [scope defined], (29) [separated into `Oyatie Mobile.dc.html`], (31) [doc sync], plus already covered in `00-shell.md`'s Responsive Breakpoints section.
- Distinct 7-screen employee app at `<768px`: 메신저·메일·알림·주소록·게시판·수신함·전자결재 (messenger/mail/notifications/directory/board/personal-inbox/approvals) ONLY — every other nav destination is disallowed and redirects to messenger (`MOBILE_SCR`/`mobileGuard`, triggered on mount AND on resize, so resizing an already-open desktop-only screen down past 768px live-redirects).
- Bottom tab bar: 5 tabs + a "더보기" (more) tab, badge-capable, 48px height, safe-area-inset aware.
- "더보기" opens a bottom sheet (not a drawer) listing: personal-inbox (with its badge), directory, board — backdrop + Esc to dismiss.
- Body gets 64px bottom padding to clear the fixed tab bar.
- Persona filtering composes with mobile screen filtering (the (27) entry notes "페르소나 필터 합성" — the mobile-allowed-screen-set intersects with whatever the active view-as persona is allowed to see, it's not an override).
- (2026-07-09(32)④) adds a 2-pane-collapsed-to-stack navigation pattern specifically for mobile messenger (list↔chat) and mail (folder-chips+list↔reading, with an explicit back button) — i.e. the same desktop 2-pane screens collapse to a single-pane-at-a-time stack navigation on mobile rather than being separately built mobile screens.
- Packaging: `Oyatie Mobile.dc.html` is a thin `ios-frame.jsx` device-chrome wrapper that iframes the SAME `Oyatie Console.dc.html` at a fixed 390px width — the console's own responsive logic (window-metrics-driven) is what produces the mobile mode; the mobile file itself contains no separate app logic. VERIFIED-IN-SNAPSHOT: this wrapper file structure was read directly (see `00-shell.md`) — only its CONTENTS (the 7-screen tab-bar shell it triggers) are the unverified, post-snapshot part.

## Other named-but-not-detailed additions (for completeness, not independently specced here)

- 게시판 (board) full view — mentioned as a remaining gap as of 2026-07-08(2) ("잔여: 게시판 풀뷰"), later gets its `NT-` progress-bar treatment (30) as part of the module-surface batch; whether a SEPARATE bespoke board full-view screen (distinct from the `directory`/module template) was ever built is not confirmed in the read changelog span — treat as folded into the module-surface `board` entry above unless contradicted by a later changelog entry not covered in this digest.
- Cedar policy no-code canvas (`policies`/`polBuilder`/`POL_BLOCKS`/`polRuleText`/`polSim`/`polSave`) — lives on the (VERIFIED-IN-SNAPSHOT-EXISTING) `policy` screen, not a new screen; the no-code canvas itself is a POST-SNAPSHOT addition to that screen (changelog 2026-07-08(4)). See `02-screens/docs-policy-inbox-audit.md` for the snapshot-era POLICY screen baseline this extends.
- Automation no-code block builder (`wfBuilder*`/`WF_BLOCKS`) + automation↔ontology bidirectional chips (`wfChainOf`) + automation CRUD (`schNew`/`schArchive`/`wfEditOpen`/`wfArchive`) — extends the (VERIFIED-IN-SNAPSHOT-EXISTING) `auto` screen (`02-screens/auto.md`), changelog 2026-07-08(1)(14)(16)(21).
