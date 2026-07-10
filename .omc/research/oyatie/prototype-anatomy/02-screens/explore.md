# Oyatie Console — Spec for 객체 탐색 / OBJECT EXPLORER (screen id `"explore"`)

File: `docs/design/oyatie-console/Oyatie Console.dc.html` (Jul-4 09:04 mirror).

## ⚠ Verification status — read first

**This screen has NO code in the repo snapshot.** The change log records `screen:"explore"` completed+verified (AGENTS.md:40, entry 2026-07-04 (7); ROADMAP.md:110) later on Jul 4, after the 09:04 mirror. Verified absences in the snapshot:

- `grep 'ONTOLOGY_GRAPH\|exploreGo\|"explore"'` → 0 hits (no screen id, no graph builder, no traversal methods).
- Nav sidebar (dc.html 6163–6205) has no 객체 탐색 item (the entry AGENTS.md:40 says nav wiring came with the slice).
- All 17 worktree dc.html copies are byte-identical; per SYNC-MANIFEST.md:29, for post-Jul-4 screens "the change log + DESIGN §4.7 grammar catalog are the spec".

Everything below is **UNVERIFIED against code** — reconstructed from AGENTS.md/ROADMAP.md/DESIGN.md. Line cites go to those files.

---

## 1. Screen contract (changelog-level)

### 1.1 Data: `ONTOLOGY_GRAPH()` — 20-node typed graph (AGENTS.md:40; ROADMAP.md:110)

- **Shape**: "`ONTOLOGY_GRAPH()`(20노드 typed 개체+엣지)" — a builder returning 20 typed object nodes + edges. Node/edge field shapes are not recorded anywhere in the repo (UNVERIFIED); node ids follow object codes seen in the verified demo: `c207` (계약 C-207), `att_cho` (근태), `pay_cho` (급여).
- **Seeded chains** (ROADMAP.md:110): 계약→편성→공고→지원자 · 현장→팀→직원→근태→대근→인력풀 · 근태→급여→회차→수익성 환류 · 인제스트→계약 · 감사→직원. This is the DESIGN object chain (계약 C- → 포지션 → 공고 → 지원자 → 직원 → 근태 → 급여 → 분석 → 계약 수익성 환류) rendered as graph data.
- **Verified demo** (AGENTS.md:40): traverse `c207 → att_cho → pay_cho`, 20 nodes.

### 1.2 Layout anatomy (AGENTS.md:40; ROADMAP.md:110)

- **Radial graph**: "방사형 그래프(SVG 엣지+절대배치 노드칩)" — SVG layer draws the edges; nodes are **absolutely-positioned chip elements** (HTML chips over the SVG, not SVG nodes) arranged radially around the centered focus object.
- **Center object card**: the focused object's card at the center ("중심 개체 카드").
- **Upstream/downstream link panels**: side panels listing the focus object's 상류/하류 linked objects ("상류/하류 링크 패널").
- **Legend(범례)**: object-type legend.
- **Trail**: breadcrumb of visited nodes ("재중심·트레일") backing `exploreBack`.

### 1.3 Interactive affordances

| Affordance | Handler (named in changelog) | Effect |
|---|---|---|
| Node chip click | `exploreGo` | **re-center** the graph on that object; push previous focus onto the trail (AGENTS.md:40 "재중심·트레일") |
| Trail / back | `exploreBack` | pop the trail, re-center on the previous object |
| Up/downstream panel row | (unnamed) | navigate to that linked object (re-center) |
| Nav 「객체 탐색」 | nav item | `setState({screen:"explore"})` (AGENTS.md:40 "nav 「객체 탐색」 배선") |

Consistent with the verified screen idiom (`scrWrapOf2(scr)` visibility at dc.html 5955-era grammar), `explore` would be a sibling top-level screen div — UNVERIFIED.

### 1.4 State read / written (inferred, UNVERIFIED)

- Focus object id (re-centered by `exploreGo`), trail stack (popped by `exploreBack`). Names of the state keys are not recorded in the repo.

## 2. Post-Jul-4 deltas touching this screen (also UNVERIFIED — changelog cites)

- **Automation↔ontology bidirectional** (AGENTS.md:50, 2026-07-08 (3)): wf detail "개체 체인" chips → explore re-center (`wfChainOf`/`WF_TYPE_NODE`); explore panel gains **「작용 자동화」** (acting-automation) rules chips → rule selection in the auto screen. Palantir dynamics layer, 1-click both ways (DESIGN.md:158 makes this an invariant).
- **Caption sweep** (AGENTS.md:50, (4)): explore footer caption prose deleted (§4-12 no-explanatory-UI).
- **Lifecycle chip** (AGENTS.md:69, (10)): explore center object gains 「생애주기 · 단계·vN」 chip → lifecycle modal.
- **Graph merge** (AGENTS.md:71, (11b)): `_ogBuild` merges all module rows (VC/PO/IV/FL/WO/ST/CP/RG/NT/FC) as typed nodes; kv·link codes = auto edges; series (SR-) + insight (AN-) nodes join; `objLinks` overlay for manual edges.
- **Schema-as-object legend** (AGENTS.md:73, (12)): legend chips become type-card entry points — `ontTypes` registry of 13 types (OT-01~13), chip click → `lcOpen(OT-)` type card (definition · owner · active-instance count computed from the live graph · lifecycle stepper · archive gate = instance migration + rebinding); 「+ 타입 제안」 inline input.
- **Graph AUTHORING** (AGENTS.md:75, 2026-07-08 (13) — **explicitly post-snapshot, UNVERIFIED**): ① 「+ 새 개체」 side-panel affordance (active-type select + name Enter) → `nodeCreate` OB- draft (+audit, card open), joins graph via `userNodes` overlay (non-destructive); ② 「시리즈 승격」 on instance-type objects → `seriesCreate` SR-21x user series + `seriesAttach` (code input · drag-drop enrollment, `_ogBase` rebuild, trend recompute); ③ new relations: center-object drop zone = `objLinkAdd`, graph node chips = drag sources sharing the `[코드]` reference-token payload (droppable into composer/todos too); `onLink` routes to series-enroll on series cards, edge elsewhere.
- **Object search** (AGENTS.md:77, (14)): full-graph search (name·code·type) placed where the §4-12 caption used to be; Esc closes cards; drop highlight `exDropHot`.

## 3. Cross-references

- Audit correlation (ROADMAP.md:96): AuditEvent → 「개체로 이동」/「연관 이벤트」 target the explore graph.
- Ingest commits create the typed nodes this screen traverses (see `ingest.md`; 인제스트→계약 chain, ROADMAP.md:110).
- To verify against real code: export a current prototype copy from the claude.ai design project (SYNC-MANIFEST.md:18 — manual export; the 698KB file exceeds the DesignSync read cap).
