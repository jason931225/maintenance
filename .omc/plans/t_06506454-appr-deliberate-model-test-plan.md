# Deliberate-mode artifact — Issue #328 appr / 전자결재

Task: `t_06506454`
Issue: https://github.com/jason931225/maintenance/issues/328
Generated: 2026-07-09T23:36:57Z
Scope: frontend planning/model/test artifact only; no implementation code in this card.

## 0. Source status and precedence

Primary authority remains `docs/design/oyatie-console/Oyatie Console.dc.html`, but this checkout currently does not contain that desktop file. The local design directory contains `Oyatie Mobile.dc.html` and synced markdowns only. Therefore this artifact follows `docs/design/oyatie-console/SYNC-MANIFEST.md` offline precedence:

1. current repo `web/src/**` as implementation truth;
2. fresh design markdowns, especially `docs/design/oyatie-console/AGENTS.md` and `SYNC-MANIFEST.md`, as current design authority;
3. `.omc/research/oyatie/prototype-anatomy/**` as verified Jul-4 desktop prototype anatomy plus post-snapshot spec notes.

Concrete source anchors used:

- Issue #328 body: `[carbon-copy/P1] appr — 전자결재 결재함/상신함/기안 (deliberate mode)`.
- `.omc/plans/carbon-copy-charter.md:137-139`: P1.3 `appr` deliberate-mode slice and acceptance.
- `.omc/research/oyatie/prototype-anatomy/02-screens/appr-leave-benefit.md:9-139`: verified `appr` layout, state, handlers, seed shapes, render bindings, and prototype methods.
- `.omc/research/oyatie/prototype-anatomy/00-shell.md:31,73-77`: task/detail pin-panel grammar and approval modal shape.
- `.omc/research/oyatie/prototype-anatomy/01-window-engine.md:43-64`: pin/popout/minimize state machine and real space reservation.
- `.omc/research/oyatie/prototype-anatomy/03-systems.md:17-27,84-106`: passkey receipt, statutory notice push, audit backbone, and updated token-composer directive.
- `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md:55-72,102-117`: backend mapping for appr, docs archive, inbox/receipt, and audit.
- `.omc/handoffs/t_b01e38e6-issue-328-intake.md`: #328 is live/open; PR #205/#254/#269 are merged on `origin/main` but current local `HEAD` is stale; implementation must use a clean `origin/main` worktree.

Hard blocker note for downstream implementation: full fidelity screenshot acceptance cannot be closed until `docs/design/oyatie-console/Oyatie Console.dc.html` is restored or the issue records a precise post-snapshot/fidelity N/A. This planning artifact is still implementable from the verified anatomy and current markdown authority.

## 1. Product contract

Build the `appr` screen as the P1.3 carbon-copy console slice, not as a legacy `/approvals` reskin.

The user-visible screen is `전자결재` with three tabs:

- `결재함` — documents awaiting the current viewer's decision plus recently decided / finalize-waiting progress rows.
- `상신함` — documents initiated by the current viewer and their run timelines/actions.
- `기안` — submittable-definition gallery plus compose flow.

The screen must be fully wired to real backend APIs. No fabricated AP codes, no local-only gallery, no hardcoded approval line as final truth, no disabled controls with explanatory text. Missing authorization or policy means deny-by-omission through `PolicyGated`, not disabled buttons or helper prose.

All UI strings live in `web/src/i18n/ko.ts`. `web/src/console/**` must stay visually isolated: no AppShell chrome, no Tailwind utility visuals, no shadcn imports, tokens only from `web/src/console/tokens.css`, and shared console primitives (`StatusChip`, `PolicyGated`, list grammar, pin panel/window grammar) rather than duplicated shapes.

## 2. Frontend model

### 2.1 Domain entities

Use these as implementation-facing TypeScript model names; field names may adapt to the generated OpenAPI types, but the semantics should not drift.

```ts
type ApprTab = "inbox" | "outbox" | "draft";

type ApprovalCode = string; // display-only canonical AP-* code issued by backend/BE-OBJ

type ApprInboxTask = {
  taskId: string;
  runId: string;
  code: ApprovalCode;
  title: string;
  initiatorName: string;
  entityLabel: string;
  siteLabel?: string;
  amountLabel?: string;
  dueLabel?: string;
  dueTone: "neutral" | "warn" | "danger";
  line: ApprovalLineNode[];
  currentNodeId: string;
  objectLinks: ObjectLinkRef[];
  auditTarget: AuditTargetRef;
};

type ApprovalLineNode = {
  nodeId: string;
  label: string;
  actorLabel?: string;
  state: "pending" | "current" | "approved" | "returned" | "rejected" | "skipped";
  decidedAt?: string;
  commentRequired?: boolean;
};

type ApprSubmittedRun = {
  runId: string;
  code: ApprovalCode;
  title: string;
  templateLabel: string;
  status: "draft" | "running" | "approved" | "returned" | "rejected" | "finalize_pending" | "finalized" | "post_rejected" | "receipt_pending";
  submittedAtLabel: string;
  line: ApprovalLineNode[];
  canFinalize: boolean;
  canDelegateFinalize: boolean;
  canPostFinalizationReject: boolean;
  archiveVisibility: "pending" | "visible" | "blocked_records_archive";
};

type ApprTemplate = {
  definitionId: string;
  label: string;
  description?: string; // not rendered as explanatory card prose unless design authority explicitly shows it
  tone: "warn" | "info" | "accent" | "purple" | "ok" | "teal";
  reasonOptions: string[];
  requiredTargetKinds: string[];
  optionalTargetKinds: string[];
  attachmentPolicy?: "none" | "evidence_required" | "optional";
  previewLine: ApprovalLineNode[];
};

type ApprComposeDraft = {
  definitionId: string;
  title: string;
  reason: string | null;
  body: string; // token-composer enabled
  targets: ObjectLinkRef[];
  evidence: EvidenceRef[];
  previewLine: ApprovalLineNode[];
  validation: Partial<Record<"title" | "reason" | "targets" | "evidence" | "sod", string>>;
};

type ObjectLinkRef = {
  kind: string;
  id: string;
  code?: string;
  label: string;
  policyAction: string;
};

type AuditTargetRef = { targetType: string; targetId: string; traceId?: string };
type EvidenceRef = { id: string; label: string; code?: string };
```

### 2.2 Data sources and API binding

Use generated client types where available. Do not invent console-private REST shapes.

- `GET /api/v1/workflow-tasks?assignee=me` or equivalent generated-client call:
  - feeds `결재함` pending rows;
  - also supplies task ids for `claim`/`decide`/`finalize` actions.
- `POST /api/v1/workflow-tasks/{task_id}/claim`:
  - optional before decision if backend requires claim; UI should not show a separate explanatory step unless the backend/policy requires it.
- `POST /api/v1/workflow-tasks/{task_id}/decide`:
  - drives `승인`, `반려`, `거부` in the pin panel;
  - `반려` and `거부` require non-empty comment before the call;
  - keep current stricter behavior if backend/generated type requires a decision memo for `승인` too.
- `GET /api/v1/workflow-runs/mine`:
  - feeds `상신함` rows and counts;
  - must be scoped to current principal/persona, not global admin seed data.
- `GET /api/v1/workflow-runs/{run_id}`:
  - feeds progress timeline / line stepper;
  - source of truth for current node, terminal state, trace id, and generated canonical AP code.
- `POST /api/v1/workflow-tasks/{task_id}/finalize`:
  - `종결` by author, or `대행` when policy grants delegate finalization;
  - endpoint contract mentions Author|Delegate semantics; UI must not fake this as local state.
- `POST /api/v1/workflow-runs/{run_id}/post-finalization-rejection`:
  - `사후 반려`; original finalized record stays immutable;
  - backend response must identify the compensating AP/document object and notification trace.
- `GET /api/v1/workflow-studio/submittable-definitions`:
  - the only allowed source for the `기안` gallery;
  - if unavailable or unauthorized, render an empty/error state and block compose acceptance; never ship demo cards.
- `POST /api/v1/workflow-runs`:
  - submit compose draft; backend issues canonical AP code.
- Object links:
  - target picker uses backend object registry/search when available, and persists links through `POST /api/v1/object-links` after the run object exists;
  - `GET /api/objects/{kind}/{id}` can resolve known codes; global object/person search is still listed as a gap, so a downstream implementation may need to start with per-definition target endpoints or block target search explicitly rather than stubbing.
- Audit:
  - use `GET /api/audit` filters (`target_id`, `trace_id`, `target_type`, `actor`) as verification surface; this route exists in code but may need OpenAPI backfill.
- Docs archive:
  - records archive domain is currently a backend gap. Final acceptance requires a real docs-archive query surface, not `GET /api/audit` as a substitute. If the endpoint remains absent, implementation must leave the docs-archive bullet as a dependency blocker and provide the red-capable test spec.
- Notifications / InboxDoc:
  - compensating `사후 반려`, statutory notices, and receipt confirmations depend on notification and InboxDoc behavior. The receipt-confirm domain is still a gap in the backend contract; model it explicitly and do not mark acceptance complete without a real endpoint or a recorded waiver.

### 2.3 UI structure and labels

Copy the prototype layout grammar:

- Header:
  - `h1`: `전자결재`
  - dynamic compact header metric: `결재 대기 {n}건 · 내 상신 {m}건 진행`
- Tabs:
  - `결재함`, `상신함`, `기안`
  - active tab uses ink fill; count chip rendered only when count > 0.
- `결재함` main panel:
  - section label `내가 결재할 문서`
  - list rows: AP code chip, title, `기안자 · 법인/사업장`, optional amount, due chip;
  - empty state: `결재할 문서가 없습니다`.
  - subsection `내 결재 완료 · 종결 대기` with horizontal stepper rows.
- `상신함`:
  - section label `내가 올린 문서`
  - rows: AP code chip, title, template chip, status chip, stepper, action cluster.
- `기안`:
  - gallery header `양식 선택`;
  - compose fields: `제목`, `사유 유형`, `상세 내용`, `개체 연결`, `결재선`, buttons `상신`, `취소`.

Do not add explanatory subtitles such as “workflow engine backed” or “this action is audited”. Status, authorization, and error state must be communicated as chips, row state, labels, and action availability.

### 2.4 Approval pin panel

Default detail behavior for a clicked approval row is a pinned right panel or quadrant panel using the console pin grammar, not a centered legacy modal unless the shared shell lacks the renderer.

Panel content:

- Header: AP code chip, title, due/status chip, close/pin/tray controls from shared window grammar.
- Body:
  - approval line stepper with current node highlighted;
  - requester / entity / target object chips;
  - evidence/object links;
  - decision comment textarea shown when the selected action requires it;
  - audit target/trace chip only if it is already part of the shared audit grammar, not explanatory prose.
- Footer actions:
  - `승인` — visible through `PolicyGated(action="workflow_task_decide", resource={kind:"workflow_task", id: taskId})`;
  - `반려` — same gate plus non-empty comment requirement;
  - `거부` — same gate plus non-empty comment requirement;
  - `종결` / `대행` / `사후 반려` appear on `상신함` rows or detail panel only when status and policy allow.

Pin behavior invariants to preserve:

- header drag <= 54px creates popout or bottom sheet on narrow viewports;
- double-click header pins with real space reservation (`padding-right` / `padding-bottom`), not overlay underlap;
- interactive controls inside the header/body never start a drag;
- minimized panels go to tray and restore without losing decision draft state.

### 2.5 Compose flow

State machine:

1. `gallery` — definitions loaded from `submittable-definitions`; no local fallback cards.
2. `editing` — draft created for selected definition.
3. `invalid` — validation errors on title/reason/required targets/evidence/SoD line preview.
4. `submitting` — POST workflow run; duplicate submit disabled.
5. `submitted` — backend AP code returned; navigate to `상신함` and open the submitted row/timeline.

Validation:

- title required;
- reason required when definition provides reason enum;
- required target kinds must be linked as structured `ObjectLinkRef`s;
- evidence required for templates with evidence policy;
- current viewer must not appear as an approver on a line they initiate unless backend explicitly marks a non-decision informational node;
- backend self-approval rejection is still mandatory even if frontend preview catches it.

Token composer usage:

- Apply the shared composer to `상세 내용` and comments.
- Current design directive supersedes old `@/#/!` object grammar:
  - `@` = mentions only, may notify;
  - `#` = messenger channels, not object links;
  - `!` trigger removed;
  - object references are bare-code auto-recognition (`AP-3122`, `WO-2643`, `C-5`, etc.) and deny-by-omission if unauthorized/unregistered.
- Structured target selection is not free text: use `개체 연결` picker and object registry/search/known-code resolver. A bare AP/WO/C code inside body can auto-link visually, but it does not replace required target fields.

Approval line preview:

- Preview comes from the selected submittable definition and current targets/persona/scope.
- The preview must show exact approver labels/roles available to the viewer.
- If the backend cannot provide a complete line preview, show a fail-closed validation state and block `상신`; do not invent a local “전성진 상신 → 감사팀 → CEO” line as product truth.

### 2.6 Finalization, receipt, and records model

Author `종결` is not the same as recipient receipt confirmation.

- Final approval means all approver nodes are done.
- Author finalization (`종결`) closes the run and should create/mark the durable AP record as finalized.
- Legal receipt, where applicable, is a personal inbox/passkey act (`열람 = 수령 증빙`) with its own audit event and possible workflow tie-back.
- Docs archive visibility means a records/archive query can find the finalized AP document by code/target/author/type. It is not proven by an in-memory row or by audit events alone.
- `사후 반려` after finalization must create a compensating document/event linked to the original. It must not rewrite the original finalized record into an ordinary rejected state.
- `대행` is a delegated finalization action, policy-gated and audited with actor/delegation reason.

## 3. Policy gates

Every affordance is rendered through `PolicyGated`; unauthorized controls are absent.

Minimum action names/resources to standardize in the implementation:

| Surface | Action | Resource |
|---|---|---|
| screen/tab read | `workflow_task_read` / `workflow_run_read` | module/scope or task/run |
| task row open | `workflow_task_read` | `{kind:"workflow_task", id}` |
| claim | `workflow_task_claim` | `{kind:"workflow_task", id}` |
| decide approve/return/reject | `workflow_task_decide` | `{kind:"workflow_task", id}` |
| compose gallery | `workflow_run_start` | `{kind:"workflow_definition", id}` |
| target picker | `object_link_read` | `{kind, id}` or target kind |
| persist object link | `object_link_create` | source AP run + target object |
| author finalize | `workflow_run_finalize` | `{kind:"workflow_run", id}` |
| delegate finalize | `workflow_run_finalize_delegate` | `{kind:"workflow_run", id}` |
| post-finalization reject | `workflow_run_post_reject` | `{kind:"workflow_run", id}` |
| audit/drill | `audit_read` | target/trace |
| docs archive query | `records_archive_read` | finalized AP document |

Cedar shadow expectation: where legacy enforcement grants/denies, include test/audit evidence that Cedar shadow evaluation is present or explicitly unavailable. Do not render a “coming soon Cedar” chip.

## 4. Pre-mortem — finalization / receipt failure modes

1. Finalized-but-not-received ambiguity
   - Failure: `종결` marks the AP run done and UI implies legal receipt even though recipient passkey confirmation never happened.
   - Mitigation: model finalization and receipt as separate states (`finalized`, `receipt_pending`, `receipt_confirmed`) and require separate audit categories.
   - Test: E2E finalizes a run, then asserts docs archive shows finalized status while inbox receipt remains pending until passkey confirm.

2. 사후반려 corrupts the immutable original
   - Failure: post-finalization rejection mutates original AP row from `finalized` to `rejected`, destroying the legal chain.
   - Mitigation: endpoint creates compensating AP/document linked to original; original remains finalized with post-rejection link/status chip.
   - Test: integration asserts original code remains queryable as finalized, compensating doc has new canonical code, both share trace/link, notifications emitted.

3. Delegate finalization hides accountability
   - Failure: `대행` action closes the run with author identity or generic system actor.
   - Mitigation: policy gate requires delegate grant; payload includes delegate actor and reason; audit event category distinguishes delegate finalization.
   - Test: audit query by trace shows actor=delegate, target=AP code, decision=permit, reason/delegation marker.

4. Frontend-only SoD gives false safety
   - Failure: preview hides self-approval but crafted request still lets initiator approve.
   - Mitigation: backend SoD guard remains decisive; frontend only improves pre-submit feedback.
   - Test: backend/integration rejects initiator decision with 403/409 and emits no approved transition; UI surfaces row error as chip/state.

5. Missing records archive is papered over by audit
   - Failure: acceptance says “appears in docs archive” but implementation only proves audit row exists.
   - Mitigation: docs archive query is a distinct acceptance gate. If no endpoint exists, block that bullet or create the records domain; do not substitute audit.
   - Test: red-capable docs-archive query test exists and fails until real records endpoint/domain is present.

6. Client-generated AP code collision
   - Failure: compose uses `AP-${Date.now()}` or seed math, producing noncanonical/duplicate codes.
   - Mitigation: AP code is display-only from workflow/object backend response.
   - Test: unit/contract test fails if submit path sets code before backend response; integration asserts returned code renders in outbox/docs/audit.

7. Notifications silently missing
   - Failure: `사후반려`, receipt, or finalization updates the run but not involved actors.
   - Mitigation: notification emission is part of API response/audit trace expectations.
   - Test: integration/E2E verifies affected users see notification rows routed to the AP/compensating document.

## 5. Expanded test plan

### 5.1 Unit tests — FSM invariants

Target files:

- `web/src/console/appr/model.test.ts`
- `web/src/console/appr/composeModel.test.ts`
- `web/src/console/appr/policyVisibility.test.tsx`
- `web/src/console/appr/tokenUsage.test.ts`

Required cases:

1. Tab counts:
   - inbox count = current viewer pending tasks;
   - outbox count = current viewer nonterminal submitted runs;
   - draft count omitted/zero unless real draft domain exists.
2. Decision FSM:
   - pending task can be approved/returned/rejected only once;
   - `반려`/`거부` blank comment is blocked before API call;
   - terminal task cannot re-enter decide state;
   - optimistic UI rolls back on failed decide.
3. Run timeline selectors:
   - timeline nodes map backend node states into exact chip tones;
   - `canFinalize` true only after final approval and when actor is author;
   - `canDelegateFinalize` true only with delegate policy;
   - `canPostFinalizationReject` true only for finalized/approved states and audit/policy role.
4. Compose validation:
   - missing title/reason/required target/evidence blocks `상신`;
   - selected definition drives required target kinds and reason enum;
   - line preview cannot include the initiator as a deciding approver;
   - AP code remains undefined until backend response.
5. Token composer:
   - `@김성호` opens mention candidates and can notify;
   - `#운영` opens channel candidates, not object candidates;
   - `!AP-3122` remains plain text or invalid old syntax;
   - `AP-3122` bare code auto-links only if resolver says visible;
   - unauthorized code remains inert plain text.
6. Policy visibility:
   - every action cluster disappears under deny gate;
   - no disabled “권한 없음” explanatory controls;
   - `PolicyGated` wraps row open, decide, target link, finalize/delegate/post-reject, audit/docs links.

### 5.2 Component / integration tests with MSW

Target files:

- `web/src/console/appr/ApprovalConsoleScreen.test.tsx`
- `web/src/console/appr/ApprovalPinPanel.test.tsx`
- `web/src/console/appr/ApprovalCompose.test.tsx`
- `web/src/console/appr/ApprovalArchiveIntegration.test.tsx`

Required cases:

1. Renders the three prototype tabs and exact Korean section labels with no explanatory subtitles.
2. Loads inbox from workflow tasks and opens a row in the pinned approval detail panel.
3. Requires comment for `반려` and `거부`; sends exact task id + decision + memo.
4. `승인` advances the current task and refreshes run timeline from backend response, not local seed mutation.
5. Loads `상신함` from `workflow-runs/mine`; timeline nodes render from `workflow-runs/{run_id}`.
6. `종결` calls the real finalize endpoint and then queries docs/archive status or records a blocked state if endpoint is absent.
7. `대행` is absent without policy; present with delegate policy and sends delegate finalize payload.
8. `사후 반려` calls post-finalization rejection endpoint, renders compensating document code/link from response, and verifies notification handler calls.
9. `기안` gallery fails closed when `submittable-definitions` returns 403/404/empty; no fallback cards.
10. Compose submit calls workflow run start and object-link persistence only after the backend returns the run/AP identity.
11. Audit drill queries `GET /api/audit` with `target_id` or `trace_id` after submit/decide/finalize/post-reject.
12. Docs archive visibility test is explicitly red if records archive endpoint/domain is not implemented; do not count audit query as passing it.

### 5.3 Backend / engine integration tests

Use existing backend test conventions in `backend/` from a clean `origin/main` worktree, because current local `HEAD` is stale relative to PR #205/#254/#269.

Required behavioral assertions:

1. Engine template start:
   - all-employee submittable definition can start a run without workflow-manage permission;
   - start returns canonical AP code / object id;
   - required targets become object links or traceable refs.
2. Self-approval SoD:
   - initiator cannot approve their own deciding node;
   - response is fail-closed (403/409) and no transition/audit approve event is committed.
3. Decide transitions:
   - approve advances to next node;
   - return/reject require comment and persist reason;
   - final node approval produces author-finalize-eligible state.
4. Finalize:
   - author finalize closes run, emits audit, and creates/updates records archive visibility when records domain exists.
5. Delegate finalize:
   - authorized delegate can finalize with delegate actor/reason audit;
   - unauthorized delegate denied with no state mutation.
6. Post-finalization rejection:
   - creates compensating document/event, does not mutate original finalized document into ordinary rejected state;
   - notifications are generated for author, current/final approvers, and affected target users.
7. Audit expectations:
   - submit, approve, return/reject, finalize, delegate-finalize, post-reject, receipt-confirm each has actor/action/target/decision/trace and hash-chain/attestation coverage where available.

### 5.4 Browser E2E / real backend

Target specs:

- `e2e/specs/console-appr-deliberate.spec.ts`
- extend persona matrix if needed in `docs/benchmarks/browser-persona-e2e-matrix.json`
- fidelity capture once `e2e/fidelity/capture.mjs` and desktop `Oyatie Console.dc.html` are present.

Required user story:

1. Sign in as ordinary employee/persona with permission to draft and view own submissions.
2. Open `/console` and navigate to `전자결재`.
3. `기안` tab loads real submittable definitions.
4. Compose a valid draft:
   - choose definition;
   - enter title/reason/body;
   - select required object target through `개체 연결`;
   - include bare code in body and verify only authorized code auto-links;
   - verify auto 결재선 preview has no self-approval deciding node.
5. Submit and assert returned canonical AP code appears in `상신함`.
6. Sign in/switch to approver persona; `결재함` contains the AP code; open pinned panel; approve/return/reject path requires the correct comment behavior.
7. Drive line through final approval via real engine transitions.
8. Return to author; `상신함` shows `종결`; finalize.
9. Verify docs archive query finds the AP document. If records archive is absent, the test must fail/skip only behind a recorded blocker, not silently pass.
10. Trigger `사후 반려` with an authorized audit/delegate persona; verify compensating document code and notification rows.
11. Query audit feed by trace/AP code and assert submit/approve/finalize/post-reject/receipt events.
12. Run persona denial checks:
   - unrelated employee cannot see another user's outbox/inbox rows;
   - unauthorized post-reject/delegate actions are absent;
   - target object candidates are deny-by-omission.
13. Run UX gates:
   - no console errors;
   - axe critical/serious zero;
   - no raw i18n keys;
   - no explanatory subtitles/captions added to the `appr` screen.

### 5.5 Fidelity and visual gates

Minimum screenshots once the desktop prototype and capture rig exist:

| Case | Viewport | Assertions |
|---|---:|---|
| appr inbox | 1440x900 | header, tab row, pending list, progress subsection, side rail proportions match prototype/anatomy |
| approval pin panel | 1440x900 | row opens right-pinned panel with real reserved space; line/comment/actions match prototype grammar |
| outbox actions | 1440x900 | submitted rows, timeline, `종결`/`대행`/`사후 반려` action cluster with no extra prose |
| draft gallery | 1440x900 | definition cards from API, active tab, no stub/local cards |
| compose form | 1440x900 | title/reason/body/target/line/footer layout; target dropdown and token dropdown clamp/flip |
| narrow layout | 1024x832 | pin becomes bottom sheet or stacks without underlap/horizontal clipping |
| persona denied | 1440x900 | unauthorized actions absent, not disabled/explained |

Until `Oyatie Console.dc.html` is restored, use `.omc/research/oyatie/prototype-anatomy/02-screens/appr-leave-benefit.md` and `AGENTS.md` as the written fidelity checklist, but leave screenshot verdict as blocked.

## 6. Acceptance mapping

| Issue #328 / task bullet | Required proof |
|---|---|
| `결재함/상신함/기안 tabs` | Component test for exact tabs/counts/labels; E2E navigation to each tab |
| live engine instance REST | MSW/component tests assert workflow endpoints called; E2E real backend flow from submit to final approval |
| approval pin panel | Component + browser test opens row as pinned panel, checks line/comment/actions and space reservation |
| progress timelines | Unit selector + integration fetch of `workflow-runs/{run_id}`; no local seed-only stepper |
| compose flow | Component/E2E submit through `submittable-definitions` + `workflow-runs`; fail-closed if catalog absent |
| author `종결` | Integration/E2E finalize endpoint call; audit event; docs archive visibility gate |
| `대행` | Policy visibility test + authorized delegate finalize integration + audit actor proof |
| `사후반려` | Post-finalization rejection integration; compensating document code; notifications; immutable original |
| object-link target selection | Unit/component tests for required target kinds, picker, object resolver/link persistence; no free-text substitute |
| token composer usage | Unit tests for @ mentions, # channels, removed ! trigger, bare-code auto-link with deny-by-omission |
| auto 결재선 preview | Unit/component tests derive line from definition/preview and reject self-approval line |
| canonical codes | Test AP code appears only after backend response; no client-generated code path |
| policy gates | `PolicyGated` tests for every affordance; unauthorized = absent |
| self-approval rejected | Backend integration security regression plus UI/E2E denial path |
| compensating `사후반려` document + notifications | Integration/E2E assertions on new code/link + notification rows |
| all transitions audited | Audit query tests by target/trace for submit/decide/finalize/delegate/post-reject/receipt |
| docs-archive query visibility | Real records archive query test; if records domain absent, explicit blocker/red test, not audit substitute |
| fidelity/persona gates | screenshot/anatomy checklist, persona deny-by-omission E2E, axe/console/i18n checks |

## 7. Implementation handoff by child card

### For `t_aaee8a70` — implement appr tabs and approval action panel

Own:

- `web/src/console/appr/types.ts`
- `web/src/console/appr/api.ts`
- `web/src/console/appr/model.ts`
- `web/src/console/appr/ApprovalConsoleScreen.tsx`
- `web/src/console/appr/ApprovalPinPanel.tsx`
- `web/src/console/appr/ApprovalTimeline.tsx`
- `web/src/console/appr/index.ts`
- `web/src/i18n/ko.ts` additions under `ko.console.appr`
- focused tests for inbox/outbox/timeline/decision/policy gates

Do not own compose submit/finalization archive unless split differently by the board.

### For `t_75717c61` — implement compose, finalization, and archive flow

Own:

- `web/src/console/appr/ApprovalCompose.tsx`
- `web/src/console/appr/composeModel.ts`
- object target picker integration or explicit blocker if global search is absent
- `종결`, `대행`, `사후 반려` action wiring
- docs archive / records visibility integration or blocker
- notification/compensating document state rendering

### For `t_62d01724` — regression, fidelity, governance checks

Own:

- unit/integration tests listed above;
- E2E `console-appr-deliberate.spec.ts`;
- persona matrix updates;
- screenshot fidelity capture once the desktop prototype file/capture rig is restored;
- check commands:
  - `npm --workspace web run test -- web/src/console/appr`
  - `npm --workspace web run lint`
  - `npm --workspace web run build`
  - `npm run check:browser-persona-matrix`
  - focused Playwright spec for the real backend flow

## 8. Non-goals / blockers to preserve

- Do not implement from the dirty/stale `feat/cedar-activation` checkout as-is; use a clean worktree based on current `origin/main` for implementation.
- Do not stub the `기안` gallery; `submittable-definitions` is the source.
- Do not claim docs-archive acceptance until a real records archive query exists.
- Do not claim full screenshot fidelity until `Oyatie Console.dc.html` and the capture rig are available or a precise waiver is recorded.
- Do not use audit rows as a substitute for records archive rows.
- Do not reintroduce old object-token grammar (`#` object, `!CODE`) into new compose inputs.
- Do not add explanatory UI to compensate for backend or policy gaps.
