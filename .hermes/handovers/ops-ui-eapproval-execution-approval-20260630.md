# Execution approval — 운영 UI / 전자결제 / 구매요청 / 그룹관리 1-11

User explicitly updated the instruction: complete requirements 1-11 end-to-end, not just plan.

Exact latest instruction summary:

> 1-11 까지 완료하고 e2e 확인해서 각자 atomic pr > review > fix > verify > merge > check e2e (live if possible/if not locally with playwright) simulating each user story and user path ensuring that the ui ux follows industry best practices and best in class benchmarks (which you may need to do additional research for)

Primary requirements file:

- Repo handoff: `.hermes/handovers/ops-ui-eapproval-planning-requirements-20260630.md`
- Active GJC worktree copy may also exist under its `.hermes/handovers/`.
- Kanban parent/planning card: `t_56d56e06`

## Execution rules

- This is now approved execution, but keep work atomic.
- Use GJC as coding coordinator.
- Use Hermes Kanban as durable board. Mention card ids in reports.
- Implement as separate atomic PRs where seams are sufficiently independent.
- For each atomic PR: sync from current `main`, create a dedicated branch, implement, local focused tests, review, fix, verify, open/update PR, wait CI, merge only when green, then re-sync main before next dependent PR.
- After each merge, run/check relevant E2E. If live production verification is possible without secrets or unsafe data, verify live. If live auth/test credentials are unavailable, run local Playwright/browser E2E simulating the user story and record the blocker for live.
- Do not manually edit release/version/changelog/tag files. Let Release Please handle release metadata after merges.
- Do not change secrets. Do not deploy manually unless explicitly approved. Live verification is allowed; production mutation/test data must be safe and approved by existing test paths.
- Workflow Studio/n8n areas remain off-limits.
- UI/UX must follow compact, accessible, modern enterprise SaaS best practices. Additional research is allowed/encouraged.

## Suggested atomic PR slices

These are suggestions; adjust after repo seam inspection if a different split reduces risk.

1. `fix(e-approval): show maintenance photos to approvers`
   - Req 1 plus tests proving actual approver-visible image preview.

2. `feat(dispatch): compact dispatch controls and date-only scheduling`
   - Req 2 and dispatch half of Req 7.
   - Add 전체 저장 without breaking existing individual actions.

3. `feat(workhub): compact personal dashboard and nav badges`
   - Req 3, 4, 5 and notification shell pieces that are not tightly tied to electronic approval counts.

4. `feat(e-approval): rename approvals and add document counts/notification bell`
   - Req 6. Coordinate carefully with shared shell/nav files from slice 3 to avoid conflicts.

5. `fix(intake-planning): simplify intake dates and planning work rows`
   - Req 7 intake half and Req 8.

6. `feat(financial): refine purchase request org/vendor/price-anomaly UX`
   - Req 9. This may be larger; split further if backend/API migrations are substantial.

7. `fix(groups): correct LSO slug and compact group list controls`
   - Req 10 and Req 11.

## Verification expectation

For every PR:

- Focused unit/component tests first where possible.
- Lint/typecheck/build relevant package.
- If backend/API changed: Rust tests, OpenAPI/client generation checks as appropriate.
- Browser E2E/user story verification with Playwright, local if live unavailable.
- Review pass/fix loop before merge.
- After merge: confirm merged PR and run/check post-merge E2E/live where applicable.

## Best-practice research themes

Use additional research where useful for:

- Field service / dispatch control density and grouped save patterns.
- Work hub / personal dashboard information architecture.
- Navigation badges, notification bell, unread counts.
- Electronic approval/document review with attachment/image evidence.
- Procurement/purchase request vendor autocomplete, line-item grids, price anomaly/quote update UX.
- Compact group/company admin list action design without label truncation.
