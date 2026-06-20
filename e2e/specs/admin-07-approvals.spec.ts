import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

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
     -- Restore the approval line for the approve-target WO so the admin step is
     -- PENDING again (an earlier approve in a prior run would have approved it).
     UPDATE work_order_approval_steps
       SET status = 'APPROVED', approved_at = now(), approved_by_id = '${MECH_ID}'
     WHERE work_order_id = '${WO_APPROVE}' AND role = 'MECHANIC';
     UPDATE work_order_approval_steps
       SET status = 'PENDING', approved_at = NULL, approved_by_id = NULL
     WHERE work_order_id = '${WO_APPROVE}' AND role = 'ADMIN';
     UPDATE work_order_approval_steps
       SET status = 'NOT_STARTED', approved_at = NULL, approved_by_id = NULL
     WHERE work_order_id = '${WO_APPROVE}' AND role = 'EXECUTIVE';
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
    page.getByRole("heading", { name: /승인 대기/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The seeded -071 work order's approve button has accessible name
  // "{requestNo} 승인" (the request_no lives in the aria-label, not the text).
  const approveBtn = page.getByRole("button", { name: /-071 승인/ });
  await expect(approveBtn).toBeVisible({ timeout: 8_000 });
  await approveBtn.click();

  // Success status message confirms the approve transition committed.
  await expect(page.getByText(/승인을 처리했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
});

test("ADMIN-07 admin rejects a submitted completion with a memo", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/approvals");
  await expect(
    page.getByRole("heading", { name: /승인 대기/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // A reject requires a memo — fill the shared 검토 메모 textarea first.
  await page.locator("#approval-memo").fill("E2E 반려 사유: 추가 점검이 필요합니다.");

  const rejectBtn = page.getByRole("button", { name: /-072 반려/ });
  await expect(rejectBtn).toBeVisible({ timeout: 8_000 });
  await rejectBtn.click();

  await expect(page.getByText(/반려를 처리했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
  // A rejected order transitions to REJECTED and leaves the pending queue.
  await expect(rejectBtn).not.toBeVisible({ timeout: 8_000 });
});
