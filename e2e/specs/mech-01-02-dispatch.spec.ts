import { execFileSync } from "node:child_process";

import { test, expect, sql } from "../fixtures/roles";

/**
 * MECH-01 — mechanic sees their assigned dispatch board.
 * MECH-02 — mechanic self-assigns a RECEIVED/unassigned work order.
 *
 * Prerequisites: seed-mech.sql seeds a RECEIVED work order (…f00001) with
 * request_no suffix -011. Both specs share the same login ceremony.
 */

const RECEIVED_WO_ID = "00000000-0000-0000-0000-000000f00001";
const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";

/** Reset the RECEIVED WO back to RECEIVED/unassigned before each spec. */
function resetReceivedWo() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE work_orders
       SET status = 'RECEIVED'
     WHERE id = '${RECEIVED_WO_ID}';
     DELETE FROM work_order_assignments
     WHERE work_order_id = '${RECEIVED_WO_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetReceivedWo();
});

test("MECH-01 mechanic sees dispatch board with work orders on /dispatch", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // Page title visible (the PageHeader h1; the board card repeats it as an h2).
  await expect(
    page.getByRole("heading", { name: /배차 보드/, level: 1 }),
  ).toBeVisible();

  // Work order list title visible
  await expect(
    page.getByRole("heading", { name: /작업지시 목록/ }),
  ).toBeVisible();

  // At least one work order appears (the seeded RECEIVED one, request_no ends in -011)
  await expect(page.getByText(/-011$/).first()).toBeVisible({ timeout: 8_000 });

  // The work order's site (E2E사업장) has a registered representative contact
  // (#13). WorkOrderList renders a "담당자: {name}" line (label is
  // ko.dispatch.siteContact = "담당자") followed by a clickable tel: phone link.
  // The contact value is NOT pinned here: the shared e2e DB is mutated by
  // ADMIN-17 (which PATCHes this same seeded site's contact to 김현장 /
  // 010-2625-0987), so a hardcoded seed value would be order-dependent. Assert
  // the rendered SHAPE instead — the 담당자 label and a tel: contact link.
  await expect(page.getByText(/담당자:/).first()).toBeVisible();
  const contactTel = page.locator('a[href^="tel:"]').first();
  await expect(contactTel).toBeVisible();
  await expect(contactTel).toHaveAttribute("href", /^tel:\+?[\d-]+$/);
  await page.screenshot({
    path: "e2e/.artifacts/dispatch-contact.png",
    fullPage: true,
  });

  // Board columns are rendered (접수, 배정, 진행, 검토, 보류, 완료)
  for (const col of ["접수", "배정", "진행", "검토", "보류", "완료"]) {
    await expect(
      page.getByRole("heading", { name: col, level: 3 }).first(),
    ).toBeVisible();
  }
});

test("MECH-02 mechanic self-assigns a RECEIVED work order", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // Wait for the RECEIVED work order's self-assign button to appear.
  // The button text is "{requestNo} 배정" (request_no followed by 배정).
  const assignBtn = page.getByRole("button", { name: /-011 배정/ });
  await expect(assignBtn).toBeVisible({ timeout: 8_000 });

  await assignBtn.click();

  // A mechanic cannot use the manager-only assignment endpoint (AssigneeManage is
  // denied to MECHANIC by the permission matrix). The authorized self-service
  // action is claim-and-start: the backend records the mechanic as the primary
  // assignee and transitions the order RECEIVED → IN_PROGRESS. The RECEIVED-only
  // self-assign button therefore disappears from the 접수 column…
  await expect(assignBtn).not.toBeVisible({ timeout: 10_000 });

  // …and the work order now appears in the 진행 (active / IN_PROGRESS) column.
  await expect(
    page.locator("section").filter({ hasText: /^진행/ }).getByText(/-011/),
  ).toBeVisible({ timeout: 8_000 });

  // The mechanic is now the primary assignee, so the claim-and-start action
  // surfaces this order in the mechanic's WorkOrderActions panel as IN_PROGRESS
  // (a 작업 보고 button is offered for it). This proves the self-claim persisted.
  await expect(
    page.getByRole("button", { name: /작업 보고/ }).first(),
  ).toBeVisible({ timeout: 8_000 });
});
