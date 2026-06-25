import { test, expect } from "../fixtures/roles";

/**
 * ADMIN-19 — asset lifecycle cost (#33), READ path.
 *
 * The /financial page's 4th tab ("자산 비용", assetCost) renders the
 * AssetLifecycleCostPanel: resolve an equipment by 호기 번호, click 비용 조회, and
 * the panel computes a TCO summary (acquisition anchor + maintenance + residual)
 * and renders 취득원가 / 총소유비용(TCO) / 가동시간당 정비비.
 *
 * Driven as the seeded SUPER_ADMIN (holds EquipmentCostLedgerRead). The seed
 * equipment …ee0003 (호기 E2E-001) carries vehicle_value=30,000,000 but NO explicit
 * acquisition_cost_won, so the summary resolves the acquisition anchor via the
 * VEHICLE_VALUE_FALLBACK path — the panel shows the "취득원가가 없어 차량가액으로
 * 대체했습니다." note AND a populated TCO. This is the FIRST spec for #33, which
 * previously had ZERO browser coverage.
 */

const MANAGEMENT_NO = "E2E-001";

test("ADMIN-19 admin opens the asset-cost tab and sees the TCO summary render", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/financial");
  await expect(
    page.getByRole("heading", { name: /구매·정산/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Switch to the 자산 비용 (assetCost) tab — the 4th financial tab.
  await page.getByRole("tab", { name: "자산 비용" }).click();
  await expect(
    page.getByRole("heading", { name: /자산 생명주기 비용/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Resolve the equipment by 호기 번호 (shared EquipmentSelector).
  await page.locator("#financial-equipment-lookup").fill(MANAGEMENT_NO);
  await page.getByRole("button", { name: /^호기 번호$/ }).click();
  await expect(page.getByText(/선택된 장비/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Compute + render the lifecycle-cost summary.
  await page.getByRole("button", { name: /^비용 조회$/ }).click();

  // The summary renders the headline figures. 취득원가 anchors the TCO; with no
  // explicit acquisition cost the fallback note is shown.
  await expect(
    page.getByText(/취득원가가 없어 차량가액으로 대체했습니다\./),
  ).toBeVisible({ timeout: 10_000 });

  // The TCO total renders as a 원-denominated amount (definition-term + value).
  const tcoTerm = page.locator("dt").filter({ hasText: /^총소유비용 \(TCO\)$/ });
  await expect(tcoTerm.first()).toBeVisible({ timeout: 8_000 });
  const tcoValue = tcoTerm.first().locator("xpath=following-sibling::dd[1]");
  await expect(tcoValue).toContainText(/원/, { timeout: 8_000 });

  // 취득원가 + 가동시간당 정비비 terms render too (the three headline figures
  // the panel always surfaces).
  await expect(
    page.locator("dt").filter({ hasText: /^취득원가$/ }).first(),
  ).toBeVisible({ timeout: 8_000 });
  await expect(
    page.locator("dt").filter({ hasText: /^가동시간당 정비비$/ }).first(),
  ).toBeVisible({ timeout: 8_000 });
});
