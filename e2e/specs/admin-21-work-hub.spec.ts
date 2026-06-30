import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";
const WORK_ORDER_ID = "00000000-0000-0000-0000-000000f00009";
const TARGET_CHANGE_ID = "00000000-0000-0000-0000-0000000cc021";

/**
 * ADMIN-21 — Work Hub is the enterprise action inbox for issue #55.
 *
 * This verifies the Slack/SAP/ServiceNow-style landing surface in a real browser:
 * existing work, approval, daily-plan, messenger, support, and platform-operated mailbox modules
 * are promoted as one workflow hub with no route-error fallback.
 */
test("ADMIN-21 admin opens the Work Hub action inbox", async ({
  page,
  loginAs,
}) => {
  // Own the target-change fixture here: ADMIN-19 also exercises and mutates the
  // approval queue, so this story must restore the item it expects when the full
  // browser suite runs in order.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${TENANT_ORG_ID}', true);
     INSERT INTO target_change_requests (
       id, work_order_id, requested_by, requested_target_due_at, reason,
       status, reviewed_by, reviewed_at, review_memo, org_id
     ) VALUES (
       '${TARGET_CHANGE_ID}', '${WORK_ORDER_ID}', '${ADMIN_ID}',
       now() - interval '1 minute', 'E2E Work Hub 일정 변경 검토 대상',
       'REQUESTED', NULL, NULL, NULL, '${TENANT_ORG_ID}'
     )
     ON CONFLICT (id) DO UPDATE
       SET work_order_id = EXCLUDED.work_order_id,
           requested_by = EXCLUDED.requested_by,
           requested_target_due_at = EXCLUDED.requested_target_due_at,
           reason = EXCLUDED.reason,
           status = 'REQUESTED',
           reviewed_by = NULL,
           reviewed_at = NULL,
           review_memo = NULL,
           org_id = EXCLUDED.org_id;
     COMMIT;`,
  );

  const consoleGuard = attachConsoleGuard(page);
  await loginAs("ADMIN");

  const federatedApprovals = page.waitForResponse((response) =>
    response.url().includes("/api/approval-items") &&
    response.request().method() === "GET" &&
    response.status() === 200,
  );
  await page.goto("/work-hub");
  await federatedApprovals;
  await expect(
    page.getByRole("heading", { name: "업무 허브", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("region", { name: "우선순위 액션 큐" })).toBeVisible();
  await expect(page.getByText("업무 객체 중심 실행 흐름")).not.toBeVisible();
  await expect(page.getByText("팀·그룹 범위", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /승인·검토 .*건 보기/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "승인", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "업무·운영 모듈 열기" })).toBeVisible();
  await expect(
    page.locator(`a[href="/approvals#target-change-${TARGET_CHANGE_ID}"]`),
  ).toBeVisible();
  const approvalLink = page
    .locator('a[href^="/approvals?source=work-order&focus="]')
    .filter({ hasText: "승인센터에서 검토" })
    .first();
  await expect(approvalLink).toHaveAttribute(
    "href",
    /\/approvals\?source=work-order&focus=/,
  );
  await approvalLink.click();
  await expect(page).toHaveURL(/\/approvals\?source=work-order&focus=/);
  await expect(page.getByText("업무 허브에서 연결된 승인 건을 강조했습니다.")).toBeVisible();
  await expect(page.locator('[aria-current="true"]')).toBeVisible();
  await expect(page.getByText("이 화면을 표시하지 못했습니다.")).not.toBeVisible();

  await auditPage(page, { context: "/work-hub-to-approvals", consoleGuard });
});
