import { test, expect } from "../fixtures/roles";

/**
 * ADMIN-17 — customer-site registration (GitHub #13 slice 1).
 *
 * The admin "고객·현장 관리" page (/settings/sites) lists the org's sites and
 * registers each one's representative contact (대표 담당자 연락처) — name / phone /
 * email — via PATCH /api/v1/sites/{id}, alongside the existing address/coords.
 */
test("ADMIN sites page registers a site's representative contact", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/settings/sites");

  // Page + management panel render.
  await expect(
    page.getByRole("heading", { name: "고객·현장 관리" }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(
    page.getByRole("heading", { name: "사업장 정보 관리" }),
  ).toBeVisible();

  // Selecting a seeded site reveals the contact section + fields.
  const select = page.getByRole("combobox");
  await expect(select).toBeVisible();
  await select.selectOption({ index: 1 });
  await expect(page.getByText("대표 담당자 연락처").first()).toBeVisible();

  await page.getByRole("textbox", { name: "담당자명" }).fill("김현장");
  await page.getByRole("textbox", { name: "연락처" }).fill("010-2625-0987");

  await page.screenshot({
    path: "e2e/.artifacts/sites-page.png",
    fullPage: true,
  });

  // Save → the contact PATCH succeeds.
  await page.getByRole("button", { name: "정보 저장" }).click();
  await expect(
    page.getByText("사업장 정보를 저장했습니다.").first(),
  ).toBeVisible({ timeout: 10_000 });
});
