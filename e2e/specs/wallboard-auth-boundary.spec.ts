import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard } from "../fixtures/ux";

function trackProtectedWallboardCalls(page: import("@playwright/test").Page) {
  const calls: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/work-orders" || url.pathname === "/api/v1/kpi") {
      calls.push(`${request.method()} ${url.pathname}`);
    }
  });
  return calls;
}

test("WALLBOARD-AUTH unauthenticated /wallboard redirects before protected data calls", async ({
  page,
}) => {
  const consoleGuard = attachConsoleGuard(page);
  const protectedCalls = trackProtectedWallboardCalls(page);

  await page.goto("/wallboard");

  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "로그인", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "일일현황 월보드" }),
  ).toHaveCount(0);
  expect(protectedCalls).toEqual([]);
  consoleGuard.assertClean();
});

test("WALLBOARD-AUTH authenticated /wallboard loads shell-less KPI data", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  const consoleGuard = attachConsoleGuard(page);
  const workOrdersLoaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/work-orders" && response.status() === 200;
  });
  const kpiLoaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/kpi" && response.status() === 200;
  });

  await page.goto("/wallboard");

  await expect(
    page.getByRole("heading", { name: "일일현황 월보드", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
  await Promise.all([workOrdersLoaded, kpiLoaded]);
  await expect(
    page.getByRole("navigation", { name: "월보드 관련 화면" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "메인 내비게이션" }),
  ).toHaveCount(0);
  consoleGuard.assertClean();
});
