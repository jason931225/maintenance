import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-19b — acquisition cost (#33), WRITE path + propagation.
 *
 * An admin records the master-level accounting facts acquisition_cost_won +
 * acquisition_date on an equipment (the edit-only fields in the
 * EquipmentManagementPanel), saves, and the value PROPAGATES to the asset
 * lifecycle-cost summary: the acquisition anchor flips from the vehicle-value
 * fallback to an EXPLICIT acquisition cost, so the assetCost tab now shows the
 * entered amount and DROPS the "차량가액으로 대체" fallback note.
 *
 * Target: the seeded 호기 E2E-001 equipment (…ee0003), which carries
 * vehicle_value=30,000,000 (so its lifecycle-cost read succeeds) and, by default,
 * NO acquisition_cost_won — so ADMIN-19 reads it via the VEHICLE_VALUE_FALLBACK
 * path. This spec writes the explicit acquisition fact and verifies the anchor
 * flips to EXPLICIT, then RESTORES the seed default (acquisition NULL) so the
 * ADMIN-19 read spec remains order-independent.
 *
 * Driven as the seeded SUPER_ADMIN (EquipmentManage + EquipmentCostLedgerRead).
 */

const ORG_ID = TENANT_ORG_ID;
const EQUIPMENT_ID = "00000000-0000-0000-0000-000000ee0003";
const EQUIPMENT_NO = "EEEEE-0001"; // …ee0003's equipment_no (seed-mech.sql)
const MANAGEMENT_NO = "E2E-001";
const ACQUISITION_COST = "27500000"; // 27,500,000원
const ACQUISITION_DATE = "2024-03-15";

/** Restore the seed default: no explicit acquisition fact on …ee0003. */
function resetAcquisition() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE registry_equipment
        SET acquisition_cost_won = NULL, acquisition_date = NULL
      WHERE id = '${EQUIPMENT_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetAcquisition();
});

test.afterEach(() => {
  resetAcquisition();
});

test("ADMIN-19b admin records acquisition cost/date and it propagates to the TCO summary", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");

  // ── Open the seed equipment's edit form via the manage panel search ──────────
  await page.goto("/equipment");
  await expect(
    page.getByRole("heading", { name: /장비 조회/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(
    page.getByRole("heading", { name: /장비 관리/ }),
  ).toBeVisible({ timeout: 8_000 });

  await page.locator("#equipment-search").fill(MANAGEMENT_NO);
  const editBtn = page.getByRole("button", { name: `${EQUIPMENT_NO} 수정` });
  await expect(editBtn).toBeVisible({ timeout: 8_000 });
  await editBtn.click();
  await expect(
    page.getByRole("heading", { name: /^수정$/ }),
  ).toBeVisible({ timeout: 5_000 });

  // ── Fill the acquisition accounting facts (edit-only fields) and save ────────
  await page.locator("#eq-acquisition-cost").fill(ACQUISITION_COST);
  await page.locator("#eq-acquisition-date").fill(ACQUISITION_DATE);
  await page.getByRole("button", { name: /^저장$/ }).click();
  await expect(page.getByText(/장비 정보를 수정했습니다\./)).toBeVisible({
    timeout: 8_000,
  });

  // ── Verify propagation via the assetCost tab ─────────────────────────────────
  await page.goto("/financial");
  await page.getByRole("tab", { name: "자산 비용" }).click();
  await expect(
    page.getByRole("heading", { name: /자산 생명주기 비용/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  await page.locator("#financial-equipment-lookup").fill(MANAGEMENT_NO);
  await page.getByRole("button", { name: /^호기 번호$/ }).click();
  await expect(page.getByText(/선택된 장비/).first()).toBeVisible({
    timeout: 8_000,
  });
  await page.getByRole("button", { name: /^비용 조회$/ }).click();

  // The acquisition cost now resolves EXPLICITLY: the panel shows the entered
  // amount under 취득원가, thousands-grouped + 원 unit.
  const acquisitionTerm = page
    .locator("dt")
    .filter({ hasText: /^취득원가$/ });
  await expect(acquisitionTerm.first()).toBeVisible({ timeout: 10_000 });
  const acquisitionValue = acquisitionTerm
    .first()
    .locator("xpath=following-sibling::dd[1]");
  await expect(acquisitionValue).toContainText("27,500,000");
  await expect(acquisitionValue).toContainText("원");

  // The acquisition date is shown as a secondary note under the figure.
  await expect(page.getByText(ACQUISITION_DATE).first()).toBeVisible({
    timeout: 8_000,
  });

  // With an explicit acquisition cost, the vehicle-value fallback note is ABSENT
  // (the anchor flipped from VEHICLE_VALUE_FALLBACK to EXPLICIT).
  await expect(
    page.getByText(/차량가액으로 대체했습니다/),
  ).toHaveCount(0);
});
