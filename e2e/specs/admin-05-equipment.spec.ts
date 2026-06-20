import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-05 — admin creates an equipment row and edits it (EquipmentManage).
 *
 * Driven against /equipment as the seeded SUPER_ADMIN. The EquipmentManagementPanel
 * renders only for EquipmentManage holders (ADMIN/EXECUTIVE/SUPER_ADMIN). Its
 * editable list is populated by the page's autocomplete search, so after creating
 * the row we search for its 관리 번호 to surface the edit control.
 *
 * Selectors mirror EquipmentManagementPanel.test.tsx (id-based fields, Korean
 * status options). The created equipment is cleaned up before each run.
 */

const ORG_ID = TENANT_ORG_ID;
const EQUIPMENT_NO = "ZZZZZ-9001";
const MANAGEMENT_NO = "E2E-ADMIN-05";

function clearCreatedEquipment() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM registry_equipment
     WHERE equipment_no = '${EQUIPMENT_NO}' OR management_no = '${MANAGEMENT_NO}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearCreatedEquipment();
});

test("ADMIN-05 admin creates + edits an equipment row", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/equipment");
  await expect(
    page.getByRole("heading", { name: /장비 조회/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The manage panel renders for SUPER_ADMIN.
  await expect(
    page.getByRole("heading", { name: /장비 관리/ }),
  ).toBeVisible({ timeout: 8_000 });

  // ── Create ─────────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "장비 등록" }).click();

  // The create form opens with id-based fields.
  await page.locator("#eq-equipment-no").fill(EQUIPMENT_NO);
  await page.locator("#eq-customer-name").fill("E2E고객사");
  await page.locator("#eq-site-name").fill("E2E사업장");
  await page.locator("#eq-status").selectOption("spare");
  await page.locator("#eq-specification").fill("3t/3m");
  await page.locator("#eq-ton-text").fill("3t");
  await page.locator("#eq-management-no").fill(MANAGEMENT_NO);
  await page.locator("#eq-model").fill("E2E생성모델-3T");

  // Submit (the form's 저장 button).
  await page.getByRole("button", { name: /^저장$/ }).click();
  await expect(page.getByText(/장비를 등록했습니다\./)).toBeVisible({
    timeout: 8_000,
  });

  // ── Surface the new row via the page search, then edit it ────────────────────
  await page.locator("#equipment-search").fill(MANAGEMENT_NO);
  // After the 300ms debounce + autocomplete, the row appears with an edit button
  // whose aria-label is "{equipment_no} 수정".
  const editBtn = page.getByRole("button", {
    name: `${EQUIPMENT_NO} 수정`,
  });
  await expect(editBtn).toBeVisible({ timeout: 8_000 });
  await editBtn.click();

  // Edit form: change the status to 임대 (rented), save.
  await expect(
    page.getByRole("heading", { name: /^수정$/ }),
  ).toBeVisible({ timeout: 5_000 });
  await page.locator("#eq-status").selectOption("rented");
  await page.getByRole("button", { name: /^저장$/ }).click();
  await expect(page.getByText(/장비 정보를 수정했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
});
