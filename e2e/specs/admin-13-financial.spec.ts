import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-13 — financial: rental quote create + cost-ledger view + purchase approve.
 *
 * Driven against /financial as the seeded SUPER_ADMIN (RentalQuoteManage,
 * EquipmentCostLedgerRead, PurchaseRequestCreate + PurchaseRequestApprove).
 *
 * Prereqs (seed-admin.sql):
 *   - the seed-mech equipment (호기 E2E-001, …ee0003) for lookups
 *   - a manual cost-ledger entry (…0cd001) so the ledger view renders a row
 *   - an evidence_media row (…0ed001) so a purchase request can be created in-spec
 *
 * The cost-ledger view also exercises the timestamp serde fix: entry_at is
 * rendered as a formatted date-time, so an array-shaped timestamp would fail the
 * stable date-time selector instead of slipping through.
 */

const ORG_ID = TENANT_ORG_ID;
const EVIDENCE_ID = "00000000-0000-0000-0000-0000000ed001";
const MANAGEMENT_NO = "E2E-001";

/** Remove any purchase requests created by this spec so creates don't accumulate. */
function clearPurchaseRequests() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM financial_purchase_history WHERE purchase_request_id IN (
       SELECT id FROM financial_purchase_requests WHERE vendor_name = 'E2E거래처'
     );
     DELETE FROM financial_purchase_requests WHERE vendor_name = 'E2E거래처';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearPurchaseRequests();
});

test("ADMIN-13 admin creates a rental quote for an equipment", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/financial");
  await expect(
    page.getByRole("heading", { name: /구매·정산/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Switch to the 임대 견적 tab.
  await page.getByRole("tab", { name: "임대 견적" }).click();
  await expect(
    page.getByRole("heading", { name: /임대 견적/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Resolve the equipment by 호기 번호 (the shared EquipmentSelector).
  await page.locator("#financial-equipment-lookup").fill(MANAGEMENT_NO);
  await page.getByRole("button", { name: /^호기 번호$/ }).click();
  // The selected-equipment dl renders the resolved 호기.
  await expect(page.getByText(/선택된 장비/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Generate the quote.
  await page.getByRole("button", { name: /견적 생성/ }).click();
  await expect(page.getByText(/견적을 생성했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
  // The quote detail renders the monthly-rental heading.
  await expect(
    page.getByRole("heading", { name: /월 임대료/ }),
  ).toBeVisible({ timeout: 8_000 });
});

test("ADMIN-13 admin views an equipment cost ledger (renders formatted entry_at)", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/financial");
  await page.getByRole("tab", { name: "원가 원장" }).click();
  await expect(
    page.getByRole("heading", { name: /장비 원가·비용 원장/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  await page.locator("#financial-equipment-lookup").fill(MANAGEMENT_NO);
  await page.getByRole("button", { name: /^호기 번호$/ }).click();
  await expect(page.getByText(/선택된 장비/).first()).toBeVisible({
    timeout: 8_000,
  });

  await page.getByRole("button", { name: /원장 조회/ }).click();

  // The seeded ledger entry renders its memo.
  await expect(page.getByText("E2E 원장 항목")).toBeVisible({ timeout: 8_000 });

  // The UI renders entry_at through formatKoreanDateTime: a stable KST
  // "YYYY-MM-DD HH:mm" value, NOT a serde array like "2026,171,...".
  const entryAtValue = page
    .locator("dd")
    .filter({ hasText: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/ });
  await expect(entryAtValue.first()).toBeVisible({ timeout: 8_000 });
});

test("ADMIN-13 admin creates → submits → approves a purchase request", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/financial");
  await expect(
    page.getByRole("heading", { name: /구매·정산/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The 구매요청 tab is the default. Open the create form.
  await page.getByRole("button", { name: /구매요청서 작성/ }).first().click();

  // Resolve equipment, then fill the create form.
  await page.locator("#financial-equipment-lookup").fill(MANAGEMENT_NO);
  await page.getByRole("button", { name: /^호기 번호$/ }).click();
  await expect(page.getByText(/선택된 장비/).first()).toBeVisible({
    timeout: 8_000,
  });

  await page.locator("#pr-vendor").fill("E2E거래처");
  await page.locator("#pr-amount").fill("1500000");
  await page.locator("#pr-evidence").fill(EVIDENCE_ID);
  await page.locator("#pr-memo").fill("E2E 구매 사유");

  // Save (작성).
  await page.getByRole("button", { name: /^작성$/ }).click();
  await expect(page.getByText(/구매요청서를 작성했습니다\./)).toBeVisible({
    timeout: 10_000,
  });

  // The new request is STATEMENT_ATTACHED → the 결재 상신 action is offered.
  await page.getByRole("button", { name: /결재 상신/ }).click();
  // After submit it becomes REQUEST_SUBMITTED (결재 상신 badge) → 관리자 승인 offered.
  const approveBtn = page.getByRole("button", { name: /관리자 승인/ });
  await expect(approveBtn).toBeVisible({ timeout: 8_000 });
  await approveBtn.click();

  // Approved → the status badge shows 관리자 승인.
  await expect(page.getByText(/관리자 승인/).first()).toBeVisible({
    timeout: 8_000,
  });
});
