# Purchase module fidelity requirements — issue #333

Status: worker-ready requirements brief for the `[carbon-copy/P3-mod] purchase module screen (PO-)` slice.

## Scope

Build the Oyatie console `purchase` module screen as a P3 generic module surface. The screen is not a legacy `/financial` port. It is a carbon-copy console screen under `web/src/console/**`, rendered through the P0 generic module grammar: compact statbar, multi-attribute search, shared-track list, selected-row detail as key/value fields + link chips, and one domain primary action that is policy-gated and wired to real purchase-request APIs.

The business object is a Purchase Request (`PO-` display code; backend domain type `purchase_request`). It must cover purchase requests with SoD approval, quote/statement attachments, expenditure preparation, executive threshold routing, final execution, and ledger write-back.

## Sources consulted

1. GitHub issue #333, `[carbon-copy/P3-mod] purchase module screen (PO-)`:
   - Context: carbon-copy console; prototype/design authority; source files named for this extraction.
   - Scope: "Purchase requests (sod, attachments, execute) rendered through the P0 generic module template".
   - Conventions: `web/src/console/**` only; no Tailwind/shadcn/legacy imports; `var(--*)` tokens only; all strings in `web/src/i18n/ko.ts`; no explanatory UI; use `PolicyGated`; screenshot/fidelity gate; every number/row resolves to source object.

2. `.omc/plans/carbon-copy-charter.md`:
   - Lines 14-19: fidelity is product; fully wired or not shipped; grammar before screens; zero visual inheritance; ontology/PBAC/audit everywhere.
   - Lines 40-56: `/console` owns viewport, verbatim tokens, no AppShell/shadcn/Tailwind; deviation rule.
   - Lines 58-67: fidelity gate, grammar checklist, no-explanatory UI, no duplicated shapes, wired proof, post-snapshot axis-1 substitute.
   - Lines 69-76: P0 generic module template and P3 module order; purchase is one of the 10 module surfaces.
   - Lines 125-127: generic module template exact shape: statbar/search/shared-track list/detail kv+links+actions.

3. `docs/design/oyatie-console/SYNC-MANIFEST.md`:
   - Lines 16-18: desktop `Oyatie Console.dc.html` in this checkout is a Jul-4/stale large artifact; post-Jul-4 screens are documented in AGENTS/ROADMAP/TODO.
   - Lines 26-29: offline precedence: fresh markdowns first; for post-Jul-4 screens, AGENTS change log + DESIGN grammar are the spec.
   - Current checkout note: `docs/design/oyatie-console/Oyatie Console.dc.html` is not present in this worktree; only `Oyatie Mobile.dc.html` is present. Therefore this brief uses the documented post-snapshot substitute path from the charter instead of direct desktop-html line extraction.

4. `docs/design/oyatie-console/AGENTS.md`:
   - Lines 6-15: artifacts, inline/token-only style, `state.screen` includes 10 module surfaces including `purchase`, nav stubs = 0.
   - Lines 17-30: reusable grammar: window/pin, list, inbox/passkey, audit, token grammar; Korean-first conventions; status=chips; numeric/code=mono; no explanatory UI.
   - Lines 50-55: dashboard drill invariant and first module-surface rollout: `MOD_SCREENS()` one config + generic section; purchase = `PO-`; all links route through `modLinkGo`; module primary actions are domainized and policy-aware.
   - Lines 69-75: generic lifecycle/object-card/graph merge, all module rows become typed graph nodes, relation drawing and object card layers.
   - Lines 93-99: view-as deny-by-omission and personal-data scoping lesson.
   - Lines 101-105: generic field extension examples and caption sweep completion.
   - Lines 113-119: later module/gate requirements: n8n runLog is workflow, SLA lanes are generic, Slack/Gmail/Vanta extensions, §4-18 same-shape reuse and `TONE(t)` helper.

5. `docs/design/oyatie-console/ROADMAP.md`:
   - Lines 6-15: all-module DoD: no placeholders/filler; every noun object; correlation links; workflow gates; PBAC; grammar reuse; responsive/a11y; verification; lifecycle.
   - Lines 20-31: ontology includes Ledger/Voucher/Purchase/Asset/Inventory/Vendor and standard cross-object chains.
   - Lines 33-42: cross-system inheritance: PBAC, audit, pin/window, list grammar, token grammar, automation, no-code, token style.
   - Lines 67-80: purchase module status and benchmark: Coupa/SAP Ariba; core objects `Purchase`, `Vendor`, `PO`; P3 module.
   - Lines 100-105: P3 phase includes ERP/field-operation/document-depth surfaces; each module must connect a §5 signature correlation demo.
   - Lines 129-139: 10 module surfaces shipped as a single template, with object-chain drill and caption-sweep/component-reuse follow-ups.

6. `.omc/research/oyatie/prototype-anatomy/02-screens/post-snapshot-screens.md`:
   - Lines 1-4: post-Jul-4 screens are unverified against the snapshot; AGENTS + DESIGN grammar are the source.
   - Lines 89-106: 10 generic module screens; purchase object code `PO-`; all rows share typed graph/object-card semantics.

7. `.omc/research/oyatie/prototype-anatomy/03-systems.md`:
   - Lines 13-16: list/table grammar: J/K/Enter, multi-attribute search, shared-column track, end fade, column drag.
   - Lines 37-53: generic lifecycle engine, stage/chip/stepper, versioning, SoD, impact/gates, direct-save whitelist.
   - Lines 58-62: `MOD_SCREENS` generic module template: one config-driven layout, header statbar/search/primary-action, shared-track list, detail kv+links+actions; `modLinkGo` one dispatcher.
   - Lines 64-75: ontology graph/object card 3 layers and audited relation drawing.
   - Lines 76-82: persona/view-as gating and `TONE(t)` reuse discipline.
   - Lines 101-106: current carbon-copy token grammar directive: `@` mentions only, `#` channels, object references are bare-code auto-links; unauthorized codes stay inert.
   - Lines 107-117: guardrails: authz, self-check, peer review, SoD, egress/deploy gate, detection/audit.

8. `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md`:
   - Lines 192-207: purchase backend mapping exists as the `financial/purchase-requests` family; all 10 modules ride lifecycle/object-links/object-resolve/code-issuance substrate.
   - Lines 209-218: cross-cutting audit/lifecycle/token/PBAC backend expectations.

9. `.omc/research/oyatie/prototype-anatomy/05-post-snapshot-todo-digest.md`:
   - Lines 5-11: load-bearing object/lifecycle/PBAC hard bans, including no explanatory captions, no big-number KPI cards, no filler.
   - Lines 70-75: 10 module surfaces: all rows typed graph nodes, object card layers, relation drawing, governance CRUD; generic fields `stock`, `tl`, `lanes`, `prog`, `ctl` are config extensions, not new templates.
   - Lines 86-89: guardrail layers; fail-closed.

10. Current implementation/backend sources for data shape and policy gates:
   - `backend/openapi/openapi.yaml:4126-4378`: purchase request create/get/submit/admin-approve/prepare-expenditure/executive-approve/reject/restart/execute paths.
   - `backend/openapi/openapi.yaml:14505-14514`: purchase statuses.
   - `backend/openapi/openapi.yaml:14838-14963`: `CreatePurchaseRequest` and `PurchaseRequestSummary` fields.
   - `backend/openapi/openapi.yaml:17078-17195`: line, requester, attachment, policy summary fields.
   - `backend/crates/financial/domain/src/lib.rs:108-147` and `:273-354`: status enum and legal transition matrix.
   - `backend/crates/financial/rest/src/lib.rs:70-100`, `:471-938`, `:999-1106`: route constants, handlers, passkey step-up actions.
   - `web/src/features/financial/config.ts:14-42`: existing role mapping for create/approve/final-approve/execute/reject. Use as policy semantics, not as UI implementation.
   - `web/src/i18n/ko.ts:4336-4585`: existing Korean labels/status/action strings. Reuse only labels/chips/actions that fit no-explanatory console grammar; do not port the legacy explanatory paragraphs.
   - `web/src/console/policy/PolicyGated.tsx:29-46`: deny-by-omission render gate.
   - `web/scripts/check-console-purity.mjs:9-28`, `:100-147`: console import/className/token purity constraints.

## Expected screen composition

### 1. Route/screen identity

- Internal console screen id: `purchase`.
- Nav label: `구매` under the ERP/module group.
- Object prefix shown to users: `PO-`. Do not show raw UUIDs as the primary identifier. If backend only returns UUID today, the worker must use the object-resolve/code-issuance substrate or add the thin code/read model needed before declaring GO.
- The screen must be a `MOD_SCREENS` entry/config. No bespoke purchase-only list/detail/action shape.

### 2. Header and compact statbar

A single module header row should contain only operational labels/chips and one global primary affordance. No subtitle/caption paragraph.

Required statbar characteristics:

- Compact 1-row statbar, not big KPI cards.
- Each stat is clickable/drillable and filters the list to source rows.
- Candidate stat cells:
  - `전체` / all visible purchase requests.
  - `상신 대기` / `STATEMENT_ATTACHED` rows waiting for submission.
  - `관리자 승인` / `REQUEST_SUBMITTED` rows.
  - `임원 승인` / `EXECUTIVE_PENDING` rows.
  - `집행 대기` / `READY_TO_EXECUTE` rows.
  - `집행 완료` / `EXECUTED` rows or month-to-date executed amount.
- Every number must be derived from the same purchase source objects feeding the list. No decorative/independent numbers.

Header/global primary action:

- `구매요청 작성` if the viewer has `PurchaseRequestCreate`; absent otherwise via `PolicyGated`.
- It opens the generic module draft/create flow. If the generic module template does not yet support create, this action should route to a real draft-prefill/workflow object, not a placeholder.

### 3. Multi-attribute search

Search is not a one-id lookup. It must filter/search across at least:

- PO display code.
- Vendor name (`vendor_name`).
- Purchase type (`REGULAR`, `ONE_OFF`, `OTHER`, legacy/manual only if existing data requires it).
- Status.
- Requester display name.
- Equipment code/resolved equipment label when `equipment_id` is present.
- Work order code when `work_order_id` is present.
- Statement evidence code/label when `statement_evidence_id` is present.
- Quote attachment file name/role where present.
- Expenditure number.
- Amount range/string and created/updated date text.

The generic list keyboard contract applies: J/K changes selected row; Enter opens the row detail; focus inside inputs must not be hijacked.

### 4. Shared-track list

The list is a shared-column-track table/list generated from config. Rows must align on the same grid track; do not use per-row `max-content` or ad-hoc card stacks.

Minimum columns:

1. PO code / short identifier (mono).
2. Vendor.
3. Amount (mono/tabular, won formatting).
4. Status chip.
5. Requester.
6. Source chips summary (`WO-`, equipment/asset code, statement/evidence, quote count).
7. Updated/created timestamp (mono, compact).
8. Optional current-action chip (only if it is a real next action for this viewer).

Row behavior:

- Row click selects/open detail.
- Dragging the row as an object token should produce a purchase-object reference usable by relation drawing/composers where those surfaces accept object refs.
- End-of-list padding/fade and overscroll containment match the generic list grammar.
- If no rows are visible, render a terse empty state only (for example `구매요청 없음`). Do not explain the module.

### 5. Detail panel: key/value + link chips + actions

The selected purchase request detail uses the generic detail panel/card, not a purchase-specific page layout. It should contain:

Key/value grid:

- PO code.
- Status chip.
- Vendor.
- Amount.
- Purchase type.
- Requester.
- Branch/scope label.
- Ledger target (`장비 원가 원장` when equipment-linked, otherwise `AP 비용 원장`).
- Statement evidence code/label when present.
- Expenditure number when present.
- Rejection memo when present.
- Created/updated timestamps.
- Policy flags as chips: equipment required, statement evidence required, price anomaly, quote update required, submit blocked.

Line items:

- Render purchase lines within the same detail area as a configured nested field/table: item, quantity, unit supply price, VAT (manual chip if overridden), line total.
- This is still detail content; it must not become a second bespoke screen shape.

Link chips:

- Purchase request itself (`PO-...`) → object card/detail.
- Equipment/asset if `equipment_id` is present → object resolve/detail (`FL-` or actual equipment display code).
- Work order if `work_order_id` is present → `WO-` detail/processing panel.
- Statement evidence if `statement_evidence_id` is present → evidence/records detail, not just raw file preview.
- Quote attachments → attachment download or evidence/ingest object when promoted. Show as chips/rows with file name, role, size; do not make raw files first-class objects.
- Expenditure/cost ledger link after prepare/execute → cost ledger or AP expense ledger.
- Requester → person card if authorized.
- Vendor → vendor/client object when a real vendor object exists; otherwise plain label, not fake CL-/Vendor code.

Domain primary action:

Exactly one primary contextual action should be visually dominant for the selected row, chosen by status and policy:

- `STATEMENT_ATTACHED` → `결재 상신` (requires create/submit capability; disabled/blocked only for real `policy.submit_blocked`, otherwise absent if unauthorized).
- `REQUEST_SUBMITTED` → `관리자 승인` for admin approvers; secondary destructive `반려` if allowed.
- `ADMIN_APPROVED` → `지출결의 등록`; result routes to `READY_TO_EXECUTE` or `EXECUTIVE_PENDING` by threshold.
- `EXECUTIVE_PENDING` → `임원 최종 승인`; secondary `반려` if allowed.
- `READY_TO_EXECUTE` → `집행` (destructive/irreversible style; passkey step-up; ledger write-back).
- `REJECTED` → `재상신` for creators.
- `EXECUTED` → no mutation primary; only source/link/audit navigation.

Reject and execute confirmations should be compact action dialogs/sheets using token styling. They may state the consequence required for informed consent but must avoid prose blocks or duplicated policy explanations.

## Policy-gated affordances

All affordances must be wrapped in the console policy primitive or an equivalent module-level policy gate. Unauthorized controls are absent, not disabled with explanation.

Backend feature semantics to preserve:

- Create/submit/prepare-expenditure/restart: `PurchaseRequestCreate`; existing role mapping permits Receptionist/Admin/SuperAdmin.
- Admin approve: `PurchaseRequestApprove`; Admin/SuperAdmin.
- Executive final approve: `PurchaseFinalApprove`; Executive/SuperAdmin.
- Execute: `PurchaseExecute`; Receptionist/Admin/SuperAdmin.
- Reject: allowed to holders of `PurchaseRequestApprove` or `PurchaseFinalApprove`; Admin/Executive/SuperAdmin.
- Read: `PurchaseRequestRead` limited/read action.

Sensitive transitions requiring fresh passkey step-up:

- `purchase.admin.approve`.
- `purchase.expenditure.prepare`.
- `purchase.executive.approve`.
- `purchase.reject`.
- `purchase.execute`.

Do not trust client gating alone. The UI hides unauthorized actions, but the backend still re-checks feature + branch/org scope and returns 403/428/409 as applicable.

## Korean i18n requirements

All user-facing strings must live in `web/src/i18n/ko.ts`. The console screen may reuse existing Korean labels from `ko.financial.purchase` where they are labels/actions/chips, but should not port explanatory legacy strings.

Required visible Korean labels/actions/statuses:

- Screen/nav/title: `구매`.
- Global/create: `구매요청 작성`.
- Search placeholder: `PO·거래처·상태·요청자·원천 검색` or equivalent concise label.
- Column labels: `요청`, `거래처`, `금액`, `상태`, `요청자`, `원천`, `변경`.
- Detail labels: `거래처`, `금액`, `구매유형`, `요청자`, `원천 객체`, `거래명세표`, `견적서`, `지출결의 번호`, `반려 사유`, `작성`, `변경`.
- Status labels from existing `ko.financial.statuses`: `명세표 첨부`, `결재 상신`, `관리자 승인`, `임원 승인 대기`, `집행 대기`, `집행 완료`, `반려`.
- Actions: `결재 상신`, `관리자 승인`, `지출결의 등록`, `임원 최종 승인`, `집행`, `반려`, `재상신`.
- Confirm/dialog labels: `지출결의 등록`, `지출결의 번호`, `구매 집행`, `반려 사유`, `취소`.
- Policy chips: `서버 정책`, `패스키`, `견적 갱신`, `제출 차단`, `원장 반영`, `감사 기록` as chips only if tied to actual state/action.

Forbidden/avoid from existing legacy strings because they are explanatory UI in the console context:

- Long `description`, `command.scope`, `command.title`, `command.controls[*].value`, `listDescription`, `createHelp`, `policyEquipment`, `policyExpense`, `policyRegular`, `policyOptionalQuote`, `approvalFlow`, and similar prose blocks.
- Strings like `연동 예정`, `다음 단계 범위`, `DB 개인 설정 저장됨`, or any meta-notice explaining implementation state.

## Styling and implementation constraints

- Scope: `web/src/console/**` only for the screen and reusable module config/components.
- Do not import `web/src/features/financial/PurchaseRequestPanel.tsx`, `web/src/pages/*`, `web/src/components/ui/*`, shadcn, Tailwind utilities, `lucide-react`, or legacy AppShell components. That legacy financial panel uses Tailwind/shadcn and explanatory paragraphs; it is a data/flow reference only.
- Use tokenized inline styles with `var(--*)` from `web/src/console/tokens.css` only.
- Use/extend console primitives such as `PolicyGated` and `StatusChip`; if a second chip/tone/list/action shape appears, extract it once per §4-18.
- Use `StatusChip`/`TONE(t)`-style semantic tone mapping for status and policy chips. Do not hardcode hex colors.
- Run `node web/scripts/check-console-purity.mjs`; it rejects forbidden imports, non-console className usage, and undefined tokens.

## Data and source-object expectations

The screen must be backed by real purchase data. It cannot use fabricated `PO-` rows or session-only demo rows.

### Required source shape

Each row/detail needs a `PurchaseRequestSummary` plus a display-code/object-resolve layer:

- `id` (UUID transport; not primary display label).
- `object_code`/resolved display code (`PO-...`) from object/code issuance. If no such field exists, resolve via object registry or add the smallest backend read/code surface before GO.
- `branch_id` and authorized scope label.
- `equipment_id` nullable; resolve to equipment/asset code/label when present.
- `work_order_id` nullable; resolve to `WO-` when present.
- `statement_evidence_id` nullable; resolve to evidence/records label when present.
- `purchase_type` (`REGULAR`, `ONE_OFF`, `OTHER`; `LEGACY_MANUAL` only for existing legacy data).
- `vendor_name`.
- `amount_won`.
- `status`.
- `requester.user_id` + `requester.display_name`.
- `lines[]`: line number, item, quantity, unit supply price, VAT, manual-VAT flag, total.
- `quote_attachments[]`: id, file name, content type, size, role, created/download URL.
- `policy`: equipment_required, statement_evidence_required, price_anomaly, quote_update_required, submit_blocked, messages.
- `expenditure_no`, `rejection_memo`, `created_at`, `updated_at`.

### Read/list gap to check before implementation

Current OpenAPI shows `POST /api/v1/financial/purchase-requests` and `GET /api/v1/financial/purchase-requests/{purchaseRequestId}`, but no tenant-scoped list endpoint. A generic module list cannot be session-local like the legacy panel.

Worker must therefore choose one real source path and document it in the PR:

1. Add/use a tenant-scoped purchase list endpoint with query/filter support; or
2. Use the object registry/global object search once it can return authorized `purchase_request` objects with enough summary fields; or
3. If a newer main branch already has the list endpoint, use that and cite it.

No fabricated list rows, no local seed-only fallback, and no raw UUID lookup-only UI are acceptable.

### Mutation endpoints to wire

- Create: `POST /api/v1/financial/purchase-requests`.
- Quote attachment upload: `POST /api/v1/financial/purchase-requests/attachments/presign`, then S3 PUT, then `POST /api/v1/financial/purchase-requests/attachments/{attachmentId}/confirm`.
- Fetch one: `GET /api/v1/financial/purchase-requests/{purchaseRequestId}`.
- Download quote attachment: `GET /api/v1/financial/purchase-requests/{purchaseRequestId}/attachments/{attachmentId}/download`.
- Submit: `POST /api/v1/financial/purchase-requests/{purchaseRequestId}/submit`.
- Admin approve: `POST /api/v1/financial/purchase-requests/{purchaseRequestId}/approve-admin` with step-up.
- Prepare expenditure: `POST /api/v1/financial/purchase-requests/{purchaseRequestId}/prepare-expenditure` with `expenditure_no` and step-up.
- Executive approve: `POST /api/v1/financial/purchase-requests/{purchaseRequestId}/approve-executive` with step-up.
- Reject: `POST /api/v1/financial/purchase-requests/{purchaseRequestId}/reject` with memo and step-up.
- Restart: `POST /api/v1/financial/purchase-requests/{purchaseRequestId}/restart`.
- Execute: `POST /api/v1/financial/purchase-requests/{purchaseRequestId}/execute` with step-up; this writes to the equipment cost ledger for equipment-linked purchases or AP expense ledger semantics for non-equipment purchases.

### State transition requirements

Legal transition matrix from the domain:

- `STATEMENT_ATTACHED` → `REQUEST_SUBMITTED`: Receptionist/Admin/SuperAdmin.
- `REQUEST_SUBMITTED` → `ADMIN_APPROVED`: Admin/SuperAdmin.
- `ADMIN_APPROVED` → `READY_TO_EXECUTE`: amount <= executive threshold and Receptionist/Admin/SuperAdmin prepares expenditure.
- `ADMIN_APPROVED` → `EXECUTIVE_PENDING`: amount > executive threshold and Receptionist/Admin/SuperAdmin prepares expenditure.
- `EXECUTIVE_PENDING` → `READY_TO_EXECUTE`: Executive/SuperAdmin.
- `READY_TO_EXECUTE` → `EXECUTED`: Receptionist/Admin/SuperAdmin.
- `REQUEST_SUBMITTED`/`ADMIN_APPROVED`/`EXECUTIVE_PENDING` → `REJECTED`: Admin/Executive/SuperAdmin.
- `REJECTED` → `STATEMENT_ATTACHED`: Receptionist/Admin/SuperAdmin.

Policy errors/blocked transitions must render as chips or concise alerts tied to actual server state. Do not add explanatory policy prose.

### Audit/source-object proof

- Every mutation must produce an audit event through the backend financial audit path or a documented app-level audit event.
- Passkey-step-up failures are themselves audited/anomaly-recorded by the financial REST layer.
- Every stat/list row/detail chip must drill to a real source object or an authorized object resolve path.
- Attachments are boundary files/provenance. A raw file is not the source object; evidence/ingest/object links are the source objects.

## Forbidden patterns

- No Tailwind/shadcn/legacy component imports in `web/src/console/**`.
- No AppShell chrome, legacy `/financial` tab layout, or `PurchaseRequestPanel` JSX reuse.
- No explanatory subtitles, implementation notes, helper captions, protocol captions, or repeated chip-prose. Status is a chip; policy state is a chip; source links are chips.
- No big-number KPI cards. Use compact statbar only.
- No fake `PO-` codes, fake vendors, fake evidence IDs, fake ledger values, or fixture-only rows.
- No raw UUID as a user-facing primary label. UUIDs may remain transport ids only.
- No disabled unauthorized controls with "ask admin" explanations. Unauthorized affordances are omitted.
- No duplicated purchase-only list/detail/action shapes. If a shape exists in the module template, configure it; if it does not, extend the generic module template for all modules.
- No raw file-first attachment UI. Quote/evidence files must be tied to purchase/evidence/ingest objects.
- No direct-save side effects outside the lifecycle/direct-save whitelist. Mutations must be governed, audited, and policy-gated.

## Fidelity acceptance notes

Because the desktop `Oyatie Console.dc.html` is not available in this checkout and the 10 module surfaces are documented as post-Jul-4 screens, the first implementation should use the ratified post-snapshot fidelity substitute:

1. Assert the grammar checklist item-by-item against this brief, `AGENTS.md`, `ROADMAP.md`, and `03-systems.md`.
2. Capture build-side screenshots for the registered `purchase` module demo states:
   - Empty/no visible rows for an authorized viewer.
   - Normal list with at least 3 statuses.
   - Detail selected with link chips.
   - Policy-blocked/quote-update-required chip state.
   - Admin approval action available.
   - Executive pending action available.
   - Ready-to-execute destructive action + confirm.
   - Unauthorized viewer: action controls absent.
3. If a current desktop `Oyatie Console.dc.html` export later becomes available, re-run the full dual-capture visual verdict against the prototype surface.
4. Verification expected by issue #333/conventions:
   - `tsc -b` for affected workspace(s).
   - ESLint with max warnings 0.
   - `node web/scripts/check-console-purity.mjs`.
   - Focused Vitest/RTL tests for module config rendering, search/filter, keyboard navigation, link chips, policy gating, and action routing.
   - `check-ui-strings` / Korean i18n gate.
   - Persona/PBAC tests: create/admin/executive/execute/reject/read combinations; unauthorized controls absent.
   - Browser/fidelity capture using the local real-backend path or an explicit blocker note if the list endpoint/object search is not yet available.

## Worker handoff checklist

- [ ] Add/identify a real list/read source for purchase requests; do not build a session-only lookup screen.
- [ ] Add the `purchase` entry to the generic module config, not a bespoke page.
- [ ] Reuse/extend generic statbar/search/list/detail/link-chip/action primitives.
- [ ] Map all status labels/actions to Korean i18n keys.
- [ ] Wrap every affordance in `PolicyGated` or module-level equivalent; server calls still handle 403/428/409.
- [ ] Resolve and display PO/equipment/WO/evidence/vendor/person codes/labels through source objects; never fabricate codes.
- [ ] Wire passkey step-up for approve/prepare/executive/reject/execute.
- [ ] Assert audit event/source-object evidence for create/submit/approve/prepare/reject/restart/execute.
- [ ] Pass console purity and string gates.
- [ ] Attach build-side fidelity screenshots/evidence or record the exact prototype/list-endpoint blocker.
