# Purchase Request UX Benchmark Guidance

Source: async benchmark subagent result, 2026-06-30.

## Patterns to emulate
- Ramp/Brex: compact spend-request intake, policy-aware pre-submit guidance, live approval route preview, clear missing-items checklist, fast approve/reject/request-changes from list/detail.
- Airbase: end-to-end request -> approval -> PO/vendor/quote -> receiving/invoice/payment lifecycle, strong attachment trail, sidebar audit timeline.
- Coupa/Ariba: enterprise controls for preferred vendors, catalogs, quote requirements, approval policies, budgets; emulate compliance depth without heavyweight multi-page SAP-style forms.
- Procurify: approachable PR submission, line-item table, budget visibility, approval status; hide enterprise controls until needed.
- QuickBooks/Xero: familiar vendor + line-item accounting grid, always-visible totals/tax/categories/attachments/drafts.
- Linear/Stripe: dense polished layouts, sticky headers/footers, split panes, saved views, keyboard-friendly tables, crisp spacing, strong empty/error/loading states.

## Anti-patterns to remove/avoid
- Giant multi-step forms where basics are below the fold.
- Oversized margins/padding that push line items, approvers, or submit actions off-screen.
- Line items as large cards on desktop; use compact editable grid instead.
- Invisible approval routing until after submit.
- Free-text-only exceptions; use structured type/reason/attachment/approver/status.
- Attachments hidden in tabs where approvers miss them.
- Duplicate vendor/category/department/cost-center/project fields.
- Workflow Studio/n8n changes for normal PR UX behavior.
- LocalStorage-only layout preferences; DB is source of truth.
- Preferences affecting approval/security/required-field logic.

## First-screen target layout
- Single-page compact intake with progressive disclosure.
- Sticky top bar: breadcrumb, Draft status, editable title, estimated total, policy status, Save draft, Submit.
- Main two-column layout: 65-70% main content, 30-35% right sidebar.
- Main column: basics, compact line-item grid immediately visible, notes/business justification.
- Sidebar: approval preview, policy checklist, budget impact, quote/attachment dropzone, exceptions/blockers.
- Above the fold: vendor, request name, needed-by date, department/cost center/project, purchase type, currency/total, first line item, attachment/quote dropzone, approval preview.
- Secondary fields such as shipping/tax/contract/renewal/vendor onboarding go behind progressive disclosure.

## Line-item editor
- Spreadsheet-like editable grid on desktop; stacked cards only on mobile.
- Columns: description, quantity, unit, unit price, amount, category/GL, department/cost center/project, optional SKU, tax, quote/reference, needed-by.
- Inline validation per cell; keyboard tab/enter/arrows; add/duplicate/delete row; paste/import if practical.
- Auto-calc subtotal/tax/shipping/discount/grand total; budget impact updates as rows change.
- Inline policy flags: missing category, over budget, quote required, inactive vendor.
- Row height target ~40-48px.

## Approval, exceptions, quote attachments
- Approval preview before submit: stages, approvers, why required, SLA if available, policy triggers.
- Exceptions are structured: type, required reason, required attachment when applicable, escalation approver, pending/approved/rejected/needs-changes status.
- Quote UX: first-screen drag/drop, request-level and line-level attachments, quote requirement counter, mark preferred quote, preview PDF/image, extracted vendor/amount/expiration when available, expired/mismatched warning.
- Approvers see attachments directly from approval view.
- Approval actions: approve, reject, request changes, ask question/comment, conditional approve if supported; all write immutable audit timeline.

## DB-backed personal workspace customization
- Persist presentation/defaults only: density compact/comfortable, sidebar collapse/width, line-item column visibility/order/width, default dept/cost center/project/currency/location/purchase type, saved list filters/sort/columns, attachment panel placement, collapsed optional sections, last-used vendor/category filters.
- Suggested model: user_id, workspace_id, feature_key='purchase_requests', preferences_json, schema_version, created_at, updated_at.
- Guardrails: allowlisted schema, schema versioning, reset to default, org defaults separate, preferences never affect approval routing/permissions/required fields/policy validation. LocalStorage may cache only.

## Spacing/ergonomics checklist
- Page margin 16-24px, card padding 12-16px, 8px vertical rhythm.
- Primary fields and first line item visible on common laptop screens.
- Sticky submit/footer actions and sticky approval/policy sidebar.
- Avoid nested modals inside drawers; prefer inline expansion.
- Submit button never lost at bottom of long form.
- Concise labels; helper text only for policy context.

## Verification checklist
- Requester can create normal PR from first screen without excessive scrolling.
- Approval route updates live with amount/vendor/category/department.
- Quote/attachment requirements visible before submit.
- Approvers see attachments without extra navigation.
- Totals/tax/grand total recalc correctly.
- Draft autosave/reload preserves lines/attachments.
- Exceptions block/route correctly with clear reasons.
- Preferences persist after reload/across sessions; reset works.
- Keyboard navigation works in grid; error summary focuses invalid field.
- Empty/loading/upload-failed/permission-denied states polished.
- Mobile/tablet usable.
- No Workflow Studio/n8n files/routes/behavior changed.
