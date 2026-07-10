# Automation / Policy Console Fidelity Spec

Status: implementation-facing fidelity spec for screenshot review.
Scope: `auto` workflow studio, Cedar policy no-code canvas, four-eyes publish controls, and workflow `runLog` timeline.

## Source basis and limitation

Primary task source requested `docs/design/oyatie-console/Oyatie Console.dc.html`, but that file is not present in this checkout. `SYNC-MANIFEST.md` says the desktop console file is a 698 KB Jul-4 mirror that exceeded the DesignSync read cap and should be kept locally, while the current directory only contains `Oyatie Mobile.dc.html` plus the synced markdowns. Therefore this spec uses the declared offline precedence:

1. `web/src/**` as current implementation truth.
2. `docs/design/oyatie-console/AGENTS.md` and `ROADMAP.md` as current design authority.
3. `.omc/research/oyatie/prototype-anatomy/**` as verified/inferred prototype anatomy.

Anything below marked `verified snapshot` comes from anatomy files that cite direct reads of the Jul-4 desktop HTML. Anything marked `post-snapshot spec` comes from the current AGENTS/ROADMAP changelog and must be treated as the design target, not as a bit-exact transcription from the missing desktop HTML.

## Global pixel grammar to preserve

These dimensions are hard screenshot anchors and should be shared by the auto/policy surfaces.

| Element | Expected measurement | Source |
|---|---:|---|
| App shell height | `100dvh`, single `.console` root | `.omc/research/oyatie/prototype-anatomy/00-shell.md:7-25` |
| Left sidebar open / collapsed | `236px` / `62px` | `00-shell.md:33-39` |
| Topbar height | `56px` | `00-shell.md:41-47` |
| Comms rail open / compact / collapsed | `336px` at wide, `300px` under 1560px, `54px` collapsed | `00-shell.md:48-60` |
| Quadrant grid gap | `2px` | `00-shell.md:27-31` |
| Card pinned side panel | width clamped `360-620px`; bottom sheet `42vh` under 1024px | `.omc/research/oyatie/prototype-anatomy/01-window-engine.md:43-64` |
| Header drag band | `<=54px` from card top; interactive controls must not start drag | `01-window-engine.md:51-64` |
| Typography tokens | h1 `17px`, card title `14px`, body `13px`, value `15px`, large value `20px`, sm `11.5px`, xs `10px`, micro `9.5px` | `web/src/console/tokens.css:35-44` |
| Radius tokens | chip `5px`, small `7px`, base `8px`, medium `9px`, card `11px`, pill `999px` | `web/src/console/tokens.css:51-63` |
| Required token colors | `--canvas`, `--surface`, `--muted`, `--border`, `--ink`, `--steel`, `--faint`, `--signal`, `--teal`, semantic tone triplets | `web/src/console/tokens.css:2-34` |
| Local AA divergence | `--faint` must remain `#5f6d7e`, not upstream `#8b98a7` | `docs/design/oyatie-console/SYNC-MANIFEST.md:31-32` |

Screenshot tolerances:

- Desktop layout boxes: maximum `4px` absolute drift per major region, `2px` per chip/button/node interior.
- Text baselines: maximum `2px` y drift for h1/card-title/body rows.
- Token colors: exact computed CSS variable value, except browser antialiasing on text.
- Radius/shadow: exact token use; do not substitute Tailwind defaults where console tokens exist.
- Copy: Korean labels are part of visual fidelity. Do not replace them with English or explanatory captions.

## Auto screen layout (`state.screen === "auto"`)

### Design target

The Jul-4 snapshot has real `auto` state/methods but no verified template block; the post-snapshot design completes it as a workflow block builder. The implementation target is therefore a screen that visibly combines the verified master/detail shape with the later no-code canvas.

Expected desktop layout at 1440x900 when sidebar and rail are open:

1. Page header row inside `dashArea`:
   - Left: h1 `자동화` or `워크플로 스튜디오`, 17px token h1.
   - Adjacent tab chips: `워크플로 스튜디오`, `예약 작업`; active chip uses `--signal`/accent treatment; inactive uses muted surface.
   - Active counts match `workflows[].active` and `schedules[].active`.
   - No prose subtitle. If status context is needed, use chips or counts.
2. Body grid:
   - Left rail/list column: 320-360px target width, minimum 300px.
   - Center canvas: flexible `minmax(560px, 1fr)` at desktop; if an inspector is present, it remains the largest region.
   - Right inspector/run rail: 320-360px target width; may collapse below 1280px.
   - Gaps follow the token scale (`8-12px`), not large marketing-card spacing.
3. Workflow/schedule list:
   - Rows are full-row buttons with object code/name, active status chip, last result tone, last run timestamp, and run count.
   - J/K/Enter navigation is expected for list focus, inheriting the list grammar in the anatomy docs.
4. Detail/canvas area:
   - Selected workflow renders as no-code blocks, not raw JSON as the primary UI.
   - Selected schedule renders cron label, real cron expression, next/last run, active state, and history/runLog timeline.

Verified data shape to preserve:

- `workflows[]`: `{ id, name, active, runs, lastRun, lastResult, trigger:{label,icon}, when:[{label}], then:[{label,icon}] }`.
- `schedules[]`: `{ id, name, cronLabel, cron, next, last, active, lastResult, history:[{t,result,note}] }`.
- Methods: `autoSetTab`, `autoSelWf`, `autoSelSch`, `wfToggle`, `wfRun`, `wfSimulate`, `schToggle`, `schRun`, `schEditOpen`, `schEditSave`.

### Current implementation deviations

Current `web/src/pages/WorkflowStudioPage.tsx` is useful backend CRUD, but it is not visually faithful to the prototype target:

- It renders a conventional `PageHeader` with a description (`WorkflowStudioPage.tsx:510-523`), while the prototype grammar rejects explanatory caption UI in favor of state chips/counts.
- Main content is a definitions table plus JSON authoring form (`WorkflowStudioPage.tsx:542-588`, `WorkflowStudioPage.tsx:936-972`), not a no-code block canvas.
- Workflow definition is edited through textareas (`WorkflowStudioPage.tsx:1013-1023`), so trigger/condition/action/branch blocks are not visible.
- Connector cards and definition change history are present (`WorkflowStudioPage.tsx:591-645`), but this is not the n8n-style execution runLog timeline.
- Publish has passkey step-up and line prerequisites (`WorkflowStudioPage.tsx:291-307`, `WorkflowStudioPage.tsx:1072-1079`), but the visible four-eyes reviewer/self-check/pending-revision UI is not present.

## No-code canvas block rendering

### Workflow canvas block anatomy

The canvas must show the workflow as typed blocks bound to business-object kinds. Required visible block families:

1. Trigger node
   - Label examples: `근태 이벤트`, `결재 이벤트`, `예약 트리거 · 매년 7/1 09:00`, `새 인제스트 레코드`.
   - Size: width 220-280px, min height 64px.
   - Icon tile: 24x24px, left aligned; tile radius 7-8px.
   - Tone: info/accent token family, not arbitrary blue.
2. Condition node
   - Label examples: `무단결근 3회`, `연차 소진율 < 20%`, `7/1`, `정책 시뮬레이션 ready`.
   - Size: width 220-280px, min height 72px because conditions often carry secondary operands.
   - Shows operator chips (`<`, `=`, `AND`, `OR`) as 5px-radius chips, 10-11.5px text.
3. Branch node
   - Explicit split with at least two labeled outputs: `참/거짓`, `허용/차단`, or `정상/예외`.
   - The branch card is visually centered where the connector splits; outgoing paths must be labelled on-canvas, not explained in prose elsewhere.
   - Connector lines: 2px stroke; branch split radius/turns should be consistent across all branch nodes.
4. Action node
   - Label examples: `인사 알림`, `소명 기안(AP-) 자동 생성`, `촉진 1차 자동발송`, `근태·급여 자동반영`, `감사 로그 append`.
   - Shows generated object code family (`AP-`, `DX-`, `WO-`, etc.) as a mono chip.
   - Tone: ok/teal for successful action, warn/danger for blocked action.

Canvas rules:

- Canvas background uses `--canvas`; block cards use `--surface` and `--border` with card radius `11px`.
- The builder palette may sit left or top, but the primary representation must be block cards and connectors.
- Raw JSON is allowed only as collapsed advanced/debug view; it cannot be the default or only authoring surface.
- Blocks are business objects. Block labels should match the object grammar in AGENTS/ROADMAP: trigger -> condition -> action, with workflow/schedule/policy chips linking to ontology where applicable.
- Saving an active workflow must create a pending revision (`개정 대기 v+1 · 현행 유지`), not mutate the active workflow inline.

### Cedar policy canvas anatomy

The Cedar no-code policy canvas lives on the policy screen, extending the verified policy catalog. It must render a policy as block grammar, not as a role/permission matrix.

Required block sequence:

1. Principal block (`누가`): role/job/persona/scope. Examples: `직책 · 팀장`, `직무 · 인사`, `본인`, `전 직원`.
2. Resource block (`무엇을`): object category plus scope. Examples: `소속 팀원 근태`, `타 법인 급여 상세`, `민감 인사 정보`, `장비 EQ-BOILER-17`.
3. Action block: `열람`, `편집`, `반려`, `export`, `maintenance:StartWorkOrder`.
4. Effect block: `허용` or `금지`, using ok/danger token triplets.
5. Condition strip/toggles: location/site/branch/device posture/purpose/sensitive action, using compact chips.
6. Natural language rule line: auto-generated Korean sentence from the blocks, e.g. `경비팀 팀장은 소속 팀원의 근태를 열람할 수 있다`.
7. Simulation panel: principal sample -> decision -> reason -> audit preview, with deny-by-omission for unauthorized choices.

Current `web/src/pages/PolicyStudioPage.tsx` deviations:

- It manages roles/features/assignments (`PolicyStudioPage.tsx:535-824`) rather than Cedar principal/action/resource/effect rule blocks.
- Conditions are form rows with select/input fields (`PolicyStudioPage.tsx:1156-1256`), not visual no-code condition blocks.
- Assignment impact preview is a role-grant decision path (`PolicyStudioPage.tsx:1535-1742`), not the policy simulator described in the prototype.
- It has audit timeline rows (`PolicyStudioPage.tsx:867-920`) and passkey-protected status changes (`PolicyStudioPage.tsx:453-498`), but no visible Cedar rule preview, effect block, or simulator output.

## Four-eyes publish UI

### Required UX

Four-eyes publish is a visible governance flow, not just a backend status endpoint.

Required panel layout for publishing workflow/policy revisions:

1. Pending revision banner
   - Text: `개정 대기 v+1 · 현행 유지` for active object edits.
   - Tone: warn token family.
   - Includes `적용 승인` and `철회` actions.
2. Self-checklist
   - Four explicit items for contract/workflow/policy risk. For the reference guardrail implementation this is the `GUARD_SELF_CK` pattern.
   - Submit remains fail-closed until all required checks are acknowledged.
3. Four-eyes reviewer picker
   - Reviewer cannot be the initiator.
   - Picker visually shows exclusion of the initiator and selected reviewer identity/role.
4. SoD / approval chain
   - Visible chain chips; approver cannot be the maker where SoD applies.
   - Required line gaps are shown as blockers before passkey step-up.
5. Passkey step-up
   - Passkey is the final confirmation action after self-check/reviewer/SoD are satisfied, not a substitute for those controls.
6. Audit preview
   - Shows the event that will be appended: actor, action, target code, version, decision, trace/hash placeholder or backend trace id.

Screenshot acceptance:

- A single-click `게시` button that immediately opens platform passkey without visible self-check and reviewer picker fails fidelity.
- `window.confirm` is not an acceptable visual four-eyes surface.
- Missing reviewer exclusion fails fidelity even if the backend later enforces it.
- Missing pending-revision banner fails for edits to ACTIVE objects.

## `runLog` execution timeline

The post-snapshot design adds an n8n-style execution log timeline. This is not the same as definition version history.

Required timeline anatomy:

1. Location
   - Right inspector column on desktop or below canvas on narrow screens.
   - Header label: `실행 로그` or `runLog`; count/status chip adjacent.
2. Row structure
   - Vertical 2px timeline rail.
   - Dot per event: 10-12px diameter; ok/warn/danger token solid colors.
   - Mono timestamp, actor (`자동화 엔진`, `예약 작업`, user), run id/code if available.
   - Summary label and generated-object chips (`AP-`, `DX-`, `WO-`, `IN-`, etc.).
3. States
   - Success: ok dot and generated object chip link.
   - Warning: warn dot plus finding text.
   - Error: danger dot, retry CTA, and retry count/last error.
   - Dry-run/simulation: info or muted dot and clearly non-mutating label.
4. Interactions
   - Generated object chip routes to object card/explore.
   - Retry CTA is visible only for retryable errors.
   - Filter by selected workflow/schedule; no unrelated global history in the runLog panel.

Current `WorkflowStudioPage.tsx` history card deviation:

- The current right-side history card (`WorkflowStudioPage.tsx:609-645`) lists definition change events with version badges. That is useful audit history, but screenshot comparison must not count it as `runLog` unless it also shows execution runs, generated object chips, error/retry states, and workflow/schedule filtering.

## Screenshot comparison matrix

Minimum screenshots to approve fidelity:

| Case | Viewport | Route/surface | Required assertions |
|---|---:|---|---|
| Auto desktop builder | 1440x900 | workflow studio auto screen | sidebar/topbar/rail dimensions match; tabs/list/canvas/inspector present; trigger-condition-branch-action blocks visible; no primary JSON textarea |
| Auto schedule | 1440x900 | auto screen, `예약 작업` tab | schedule list, cron label/expression, next/last, history/runLog visible |
| Workflow publish pending revision | 1440x900 | edit ACTIVE workflow | warn pending-revision banner, self-checklist, reviewer picker, SoD chain, passkey final CTA |
| Workflow runLog errors | 1440x900 | selected workflow with failed run | vertical timeline, danger dot, retry CTA, generated-object chips for successful steps |
| Cedar policy canvas | 1440x900 | policy screen | principal/resource/action/effect blocks, conditions, natural-language rule, simulation result |
| Cedar policy publish | 1440x900 | edit ACTIVE policy | same four-eyes controls as workflow, policy-specific audit preview |
| Narrow desktop | 1024x832 | auto/policy | card/panel layout stacks; pinned card becomes bottom sheet; no horizontal clipping |
| Collapsed chrome | 1280x832 | auto/policy | sidebar/rail may collapse to 62px/54px; content retains 2px quadrant gap and no underlap |
| Mobile wrapper smoke | 390x844 | `Oyatie Mobile.dc.html` iframe | mobile file is only a wrapper; disallowed desktop-only auto/policy screens should redirect/guard according to mobile 7-screen scope |

Automated screenshot gates should check:

- Region bounding boxes for sidebar, topbar, rail, tab row, list column, canvas, inspector/runLog.
- Presence and count of block node roles/types: at least one trigger, one condition, one branch, one action.
- Absence of raw JSON textarea as the primary visible authoring surface in the default builder view.
- Color token conformance via computed CSS variables, especially `--faint: #5f6d7e`.
- Copy conformance for the governance controls: `개정 대기 v+1 · 현행 유지`, `적용 승인`, `철회`, `실행 로그`, `시뮬레이션`, `허용`, `금지`.

## Summary verdict for current web implementation

Current `/settings/workflows` and `/settings/policy` have backend-real management functionality and useful tests, but they are not yet prototype-fidelity console surfaces for this slice. The largest fidelity gaps are:

1. Raw table/JSON authoring instead of no-code canvas blocks.
2. Missing visible branch-node and connector rendering.
3. Definition change history substituting for execution `runLog`.
4. Passkey-backed publish without the full visible four-eyes/self-check/reviewer/pending-revision ceremony.
5. Policy role/feature management substituting for Cedar principal/action/resource/effect canvas and simulator.

Until these are fixed, screenshot comparison should classify the current surfaces as functionally useful but visually/design-fidelity incomplete for the imported prototype.