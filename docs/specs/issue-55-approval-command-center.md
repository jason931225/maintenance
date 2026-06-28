# Spec: Issue #55 Approval Command Center slice

## Objective
Build the next issue #55 enterprise-collaboration slice by turning `/approvals` from a work-order-only queue plus separate target-change form into a role-aware Approval Command Center. The page must aggregate current real approval sources, preserve existing work-order approve/reject flows, surface daily-plan review work through source-object deep links, and keep target due-date review clearly represented without inventing fake list data.

## Tech Stack
- React + TypeScript web console under `web/src`.
- Existing generated OpenAPI client via `createConsoleApiClient` and `useAuth().api`.
- Existing production APIs only:
  - `GET /api/v1/work-orders?status=REPORT_SUBMITTED&status=ADMIN_REVIEW`.
  - `POST /api/work-orders/{workOrderId}/approve`.
  - `POST /api/v1/work-orders/{workOrderId}/reject`.
  - `GET /api/daily-work-plans`.
  - `POST /api/target-change-requests/{requestId}/review`.

## Commands
- Targeted unit/component tests: `npm --prefix web test -- ApprovalsPage.test.tsx ApprovalQueue.test.tsx WorkHubPage.test.tsx`
- Broader web route regression: `npm --prefix web test -- App.test.tsx`
- Lint: `npm --prefix web run lint`
- E2E smoke: `PATH="$PWD/.venv-e2e/bin:$PATH" bash e2e/run.sh e2e/specs/admin-07-approvals.spec.ts e2e/specs/admin-08-daily-plan.spec.ts e2e/specs/admin-19-stub-wiring.spec.ts e2e/specs/admin-21-work-hub.spec.ts`

## Project Structure
- `web/src/pages/ApprovalsPage.tsx` orchestrates API reads/writes and page state.
- `web/src/features/approvals/ApprovalCommandCenter.tsx` renders aggregate approval-source cards and pending daily-plan links.
- `web/src/features/approvals/ApprovalQueue.tsx` remains the source-specific work-order decision queue.
- `web/src/features/approvals/TargetChangeReviewQueue.tsx` remains the real target-change review form until the backend exposes a list endpoint.
- `web/src/pages/ApprovalsPage.test.tsx` covers the new command-center behavior.
- `docs/benchmarks/issue-55-collaboration-work-hub.md` tracks shipped slices and remaining valid gaps.

## Code Style
Use typed props, real source labels, and existing design-system primitives. Keep data fetching in the page, presentation in feature components.

```tsx
<ApprovalCommandCenter
  workOrders={workOrders}
  dailyPlans={dailyPlans}
  failures={failures}
/>
```

## Testing Strategy
- RED first: page test proves `/approvals` fetches both work-order approvals and daily plans, renders counts, deep-links requested daily plans, and preserves target-change review.
- Partial failure test: a failed daily-plan source must not blank the work-order approval queue.
- Existing `ApprovalQueue` tests continue proving evidence-before-decision and memo-scoped rejection.
- E2E must continue proving real approve/reject and target-change review flows.

## Boundaries
- Always: use existing APIs, render meaningful loading/error/empty states, use Korean i18n strings, preserve existing approve/reject handlers.
- Ask first: schema changes, new dependencies, new auth/passkey protocol, new backend endpoints.
- Never: mock approval sources in production UI, claim passkey step-up is enforced by this slice when it is not, bypass backend authorization/audit checks.

## Success Criteria
- `/approvals` shows an enterprise command-center summary across work-order reports, daily-plan review, and target-change review.
- Requested daily plans are visible on `/approvals` with deep links to `/daily-plan?planId=...`; non-requested plans are not counted as pending approvals.
- Work-order approve/reject flow and target-change review continue to use the existing backend endpoints.
- If one approval source fails, loaded sources remain visible with a retryable partial-error message.
- Targeted tests and lint/e2e smoke are run or explicit gaps are reported.

## Open Questions / Backlog
- Target-change requests currently have review-by-id only; a production-grade federated approval inbox needs a list endpoint with requester, work order, policy, due date, memo, and audit metadata.
- Passkey step-up for sensitive approval decisions is product-required but outside this no-schema UI slice; backend/session step-up support must be added before the UI can truthfully mark it enforced.
