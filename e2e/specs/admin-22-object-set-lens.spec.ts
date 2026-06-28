import { test, expect, loginAsLanding } from "../fixtures/roles";

test("ADMIN-22 ops object-set lens drills into the dispatch query", async ({
  page,
}) => {
  await loginAsLanding(page, "ADMIN");
  await expect(page).toHaveURL(/\/work-hub/, { timeout: 15_000 });

  await page.getByRole("link", { name: "운영 대시보드" }).click();
  await expect(page).toHaveURL(/\/ops/, { timeout: 10_000 });

  await expect(
    page.getByRole("heading", { name: "작업지시 오브젝트 렌즈", level: 2 }),
  ).toBeVisible({ timeout: 10_000 });

  const p1LensTile = page.getByRole("link", { name: /P1 긴급/ });
  await expect(p1LensTile).toHaveAttribute("href", "/dispatch?priority=P1");

  const filteredRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/v1/work-orders" &&
      url.searchParams.get("priority") === "P1"
    );
  });

  await p1LensTile.click();

  await filteredRequest;
  await expect(page).toHaveURL(/\/dispatch\?priority=P1/, { timeout: 10_000 });
  await expect(
    page.getByText("오브젝트 렌즈 필터가 적용되었습니다."),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("heading", { name: "작업지시 목록", level: 2 }),
  ).toBeVisible({ timeout: 10_000 });

  const aroundLink = page.getByRole("link", { name: "주변 검색" }).first();
  await expect(aroundLink).toHaveAttribute(
    "href",
    /\/dispatch\?around_work_order_id=[0-9a-f-]+/,
  );

  const aroundRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/v1/work-orders" &&
      Boolean(url.searchParams.get("around_work_order_id"))
    );
  });

  await aroundLink.click();

  await aroundRequest;
  await expect(page).toHaveURL(/\/dispatch\?around_work_order_id=[0-9a-f-]+/, {
    timeout: 10_000,
  });
  await expect(
    page.getByText("오브젝트 렌즈 필터가 적용되었습니다."),
  ).toBeVisible({ timeout: 10_000 });
});
