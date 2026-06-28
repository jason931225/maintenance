import { test, expect, loginAsLanding } from "../fixtures/roles";

test("ADMIN-23 equipment detail renders lifecycle ribbon and relationship graph", async ({
  page,
}) => {
  await loginAsLanding(page, "ADMIN");
  await expect(page).toHaveURL(/\/work-hub/, { timeout: 15_000 });

  await page.getByRole("link", { name: "장비 조회" }).click();
  await expect(page).toHaveURL(/\/equipment$/, { timeout: 10_000 });
  await expect(
    page.getByRole("heading", { name: "장비 조회", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });

  const detailLink = page.getByRole("link", { name: /^(보기|수정):/ }).first();
  await expect(detailLink).toBeVisible({ timeout: 10_000 });

  const lensResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.startsWith("/api/v1/equipment/") &&
      url.pathname.endsWith("/timeline-graph") &&
      response.status() === 200
    );
  });

  await detailLink.click();
  await lensResponse;

  await expect(page).toHaveURL(/\/equipment\/[0-9a-f-]+$/, {
    timeout: 10_000,
  });
  await expect(
    page.getByRole("heading", { name: "장비 상세", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("heading", { name: "생애주기 리본", level: 2 }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("heading", {
      name: "고객-현장-장비-작업 그래프",
      level: 2,
    }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/최근 작업지시 \d+건/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("현장-장비", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole("heading", { name: "실행 가능한 작업", level: 2 }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("장비 정보 수정", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("패스키 확인 필요", { exact: true })).toBeVisible(
    {
      timeout: 10_000,
    },
  );
});
