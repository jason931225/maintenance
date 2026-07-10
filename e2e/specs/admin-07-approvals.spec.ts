import { test, expect, querySql, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-07 — admin approves and rejects a submitted completion on /approvals.
 *
 * seed-admin.sql seeds two REPORT_SUBMITTED work orders:
 *   - …f00007 (request_no -071) → approve
 *   - …f00008 (request_no -072) → reject (with a memo)
 *
 * Per-test resets restore both rows to REPORT_SUBMITTED so the spec is
 * order-independent. Selectors mirror ApprovalQueue's rendered Korean labels.
 */

const ORG_ID = TENANT_ORG_ID;
const WO_APPROVE = "00000000-0000-0000-0000-000000f00007";
const WO_REJECT = "00000000-0000-0000-0000-000000f00008";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";
const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";
const SADMIN_ID = "00000000-0000-0000-0000-0000000d0005";

function resetApprovalWos() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE work_orders
       SET status = 'REPORT_SUBMITTED', result_type = 'COMPLETED',
           diagnosis = '엔진 점검 완료', action_taken = '부품 교체 후 정상화',
           report_submitted_by = '${MECH_ID}', report_submitted_at = now()
     WHERE id = '${WO_APPROVE}';
     UPDATE work_orders
       SET status = 'REPORT_SUBMITTED', result_type = 'INCOMPLETE',
           diagnosis = '추가 점검 필요', action_taken = '임시 조치만 수행',
           report_submitted_by = '${MECH_ID}', report_submitted_at = now()
     WHERE id = '${WO_REJECT}';
     -- Restore approval lines for both target WOs. The production approval
     -- queue intentionally requires the pending step to be assigned to the
     -- logged-in approver; otherwise a user could approve a row that has no
     -- accountable approval line. Keep the E2E seed aligned with that contract.
     INSERT INTO work_order_approval_steps (
       work_order_id, step_order, role, approver_id, status,
       requested_at, approved_at, approved_by_id, org_id
     ) VALUES
       ('${WO_APPROVE}', 1, 'MECHANIC', '${MECH_ID}',  'APPROVED', now(), now(), '${MECH_ID}', '${ORG_ID}'),
       ('${WO_APPROVE}', 2, 'ADMIN',    '${ADMIN_ID}', 'PENDING',  now(), NULL, NULL,       '${ORG_ID}'),
       ('${WO_APPROVE}', 3, 'EXECUTIVE','${SADMIN_ID}','NOT_STARTED', NULL, NULL, NULL,     '${ORG_ID}'),
       ('${WO_REJECT}',  1, 'MECHANIC', '${MECH_ID}',  'APPROVED', now(), now(), '${MECH_ID}', '${ORG_ID}'),
       ('${WO_REJECT}',  2, 'ADMIN',    '${ADMIN_ID}', 'PENDING',  now(), NULL, NULL,       '${ORG_ID}'),
       ('${WO_REJECT}',  3, 'EXECUTIVE','${SADMIN_ID}','NOT_STARTED', NULL, NULL, NULL,     '${ORG_ID}')
     ON CONFLICT (work_order_id, step_order) DO UPDATE
       SET role = EXCLUDED.role,
           approver_id = EXCLUDED.approver_id,
           status = EXCLUDED.status,
           requested_at = EXCLUDED.requested_at,
           approved_at = EXCLUDED.approved_at,
           approved_by_id = EXCLUDED.approved_by_id,
           org_id = EXCLUDED.org_id;
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetApprovalWos();
});

test("ADMIN-07 admin approves a submitted completion", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/approvals");
  await expect(
    page.getByRole("heading", { name: /전자결재시스템 대기/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("region", { name: "전자결재시스템 액션 큐" })).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByText("Workflow + Approval")).not.toBeVisible();
  await expect(page.getByText("다음 결정")).toBeVisible();
  await expect(page.getByRole("link", { name: /결정하기/ }).first()).toBeVisible();

  // The seeded -071 work order's approve button has accessible name
  // "{requestNo} 승인" (the request_no lives in the aria-label, not the text).
  const approveBtn = page.getByRole("button", { name: /-071 승인/ });
  await expect(approveBtn).toBeVisible({ timeout: 8_000 });
  const approveAuditBefore = querySql<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM audit_events
      WHERE org_id = '${ORG_ID}'
        AND action = 'work_order.approve'
        AND target_id = '${WO_APPROVE}'`,
  )[0]?.count ?? 0;
  await approveBtn.click();

  const dialog = page.getByRole("dialog", { name: "작업지시 승인" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog
    .getByLabel("승인 의견")
    .fill("E2E 승인 의견: 증빙과 조치 내용을 확인했습니다.");
  await dialog.getByRole("button", { name: "승인", exact: true }).click();

  // Success status message confirms the approve transition committed.
  await expect(page.getByText(/승인을 처리했습니다\./)).toBeVisible({
    timeout: 10_000,
  });

  const approvalState = querySql<{
    work_order_status: string;
    admin_step_status: string;
    admin_decision_comment: string | null;
    admin_approved_by_id: string | null;
    executive_step_status: string;
    executive_approver_id: string | null;
  }>(
    `SELECT w.status AS work_order_status,
            admin_step.status AS admin_step_status,
            admin_step.decision_comment AS admin_decision_comment,
            admin_step.approved_by_id::text AS admin_approved_by_id,
            executive_step.status AS executive_step_status,
            executive_step.approver_id::text AS executive_approver_id
       FROM work_orders w
       JOIN work_order_approval_steps admin_step
         ON admin_step.work_order_id = w.id
        AND admin_step.step_order = 2
       JOIN work_order_approval_steps executive_step
         ON executive_step.work_order_id = w.id
        AND executive_step.step_order = 3
      WHERE w.id = '${WO_APPROVE}'`,
  )[0];
  expect(approvalState).toMatchObject({
    work_order_status: "ADMIN_REVIEW",
    admin_step_status: "APPROVED",
    admin_decision_comment: "E2E 승인 의견: 증빙과 조치 내용을 확인했습니다.",
    admin_approved_by_id: ADMIN_ID,
    executive_step_status: "PENDING",
    executive_approver_id: SADMIN_ID,
  });
  expect(
    querySql<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM audit_events
        WHERE org_id = '${ORG_ID}'
          AND action = 'work_order.approve'
          AND target_id = '${WO_APPROVE}'`,
    )[0]?.count,
  ).toBe(approveAuditBefore + 1);

  await page.reload();
  await expect(page.getByRole("button", { name: /-071 승인/ })).not.toBeVisible(
    { timeout: 8_000 },
  );
});

test("ADMIN-07 admin rejects a submitted completion with a memo", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/approvals");
  await expect(
    page.getByRole("heading", { name: /전자결재시스템 대기/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  const rejectBtn = page.getByRole("button", { name: /-072 반려/ });
  await expect(rejectBtn).toBeVisible({ timeout: 8_000 });
  const rejectAuditBefore = querySql<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM audit_events
      WHERE org_id = '${ORG_ID}'
        AND action = 'work_order.reject'
        AND target_id = '${WO_REJECT}'`,
  )[0]?.count ?? 0;
  await rejectBtn.click();

  const dialog = page.getByRole("dialog", { name: "작업지시 반려" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog
    .getByLabel("반려 메모")
    .fill("E2E 반려 사유: 추가 점검이 필요합니다.");
  await dialog.getByRole("button", { name: "반려", exact: true }).click();

  await expect(page.getByText(/반려를 처리했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
  const rejectionState = querySql<{
    work_order_status: string;
    step_status: string;
    decision_comment: string | null;
    approved_by_id: string | null;
  }>(
    `SELECT w.status AS work_order_status,
            s.status AS step_status,
            s.decision_comment,
            s.approved_by_id::text
       FROM work_orders w
       JOIN work_order_approval_steps s
         ON s.work_order_id = w.id
        AND s.step_order = 2
      WHERE w.id = '${WO_REJECT}'`,
  )[0];
  expect(rejectionState).toMatchObject({
    work_order_status: "REJECTED",
    step_status: "REJECTED",
    decision_comment: "E2E 반려 사유: 추가 점검이 필요합니다.",
    approved_by_id: ADMIN_ID,
  });
  expect(
    querySql<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM audit_events
        WHERE org_id = '${ORG_ID}'
          AND action = 'work_order.reject'
          AND target_id = '${WO_REJECT}'`,
    )[0]?.count,
  ).toBe(rejectAuditBefore + 1);

  // A rejected order transitions to REJECTED and leaves the pending queue.
  await expect(rejectBtn).not.toBeVisible({ timeout: 8_000 });
  await page.reload();
  await expect(page.getByRole("button", { name: /-072 반려/ })).not.toBeVisible(
    { timeout: 8_000 },
  );
});
