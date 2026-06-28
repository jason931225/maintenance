import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * ADMIN-21 — Work Hub is the enterprise action inbox for issue #55.
 *
 * This verifies the Slack/SAP/ServiceNow-style landing surface in a real browser:
 * existing work, approval, daily-plan, messenger, support, and mail-admin modules
 * are promoted as one workflow hub with no route-error fallback.
 */
test("ADMIN-21 admin opens the Work Hub action inbox", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);
  await loginAs("ADMIN");

  await page.goto("/work-hub");
  await expect(
    page.getByRole("heading", { name: "업무 허브", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("업무 객체 중심 실행 흐름")).toBeVisible();
  await expect(page.getByRole("button", { name: "승인" })).toBeVisible();
  await expect(page.getByRole("link", { name: "작업·배차 모듈 열기" })).toBeVisible();
  const approvalLink = page.getByRole("link", { name: "승인센터에서 검토" }).first();
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
