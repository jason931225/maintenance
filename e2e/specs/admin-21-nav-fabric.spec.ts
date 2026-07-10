import { test, expect, loginAsLanding } from "../fixtures/roles";

test("ADMIN-21 command palette and equipment object link work in browser", async ({
  page,
}) => {
  await loginAsLanding(page, "ADMIN");
  await expect(page).toHaveURL(/\/overview/, { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "통합 개요", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "명령 팔레트" });
  await expect(palette).toBeVisible({ timeout: 5_000 });

  await palette.getByLabel("명령 검색").fill("장비");
  await palette.getByRole("button", { name: /장비 조회/ }).click();

  await expect(page).toHaveURL(/\/equipment$/, { timeout: 10_000 });
  // Location is the page <h1> now — the redundant breadcrumb strip was removed in
  // the shell rebuild (see components/shell/AppShell.test.tsx).
  await expect(
    page.getByRole("heading", { name: "장비 조회", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });

  const detailLink = page
    .getByRole("link", { name: /^(보기|수정):/ })
    .first();
  await expect(detailLink).toBeVisible({ timeout: 10_000 });
  await detailLink.focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/equipment\/[0-9a-f-]+$/, {
    timeout: 10_000,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
