import { test, expect } from "../fixtures/auth";

/**
 * STOREFRONT — the public KNL marketing surface (#6).
 *
 * `/landing` (and `/`, `/home`) now render the redesigned StorefrontHomePage
 * inside PublicLayout — this supersedes the removed #10 LandingPage. The page is
 * public + unauthenticated: a one-stop hero with a 정비 접수 CTA into the public
 * intake (/support/new), a fenced FSM-platform nav link (/platform-fsm), and a
 * staff 로그인 link that on dev/preview stays same-origin (/login).
 *
 * The previous spec asserted the old #10 LandingPage (the "하나의 콘솔로" hero,
 * 자주 묻는 질문 FAQ, 구독 문의하기 CTA) at /landing — none of which render there
 * anymore. This rewrite asserts the CURRENT storefront the product actually
 * ships, plus the /platform-fsm showcase the FSM nav link points to.
 */
test("STOREFRONT home renders the one-stop hero, FSM-platform nav, login, and intake CTA", async ({
  page,
}) => {
  await page.goto("/landing");

  // One-stop hero headline (StorefrontHomePage h1 / ko.storefront.home.hero.titleOneStop).
  await expect(
    page.getByRole("heading", {
      name: "물류장비 렌탈부터 정비·운영까지, 하나로 잇는 원스탑 솔루션",
      level: 1,
    }),
  ).toBeVisible();

  // The PublicLayout header carries the fenced FSM 플랫폼 nav link → /platform-fsm.
  await expect(
    page.getByRole("link", { name: "FSM 플랫폼" }).first(),
  ).toHaveAttribute("href", "/platform-fsm");

  // The staff 로그인 link hands off to the console login. consoleHref() resolves
  // to the same-origin relative /login on the e2e preview origin (localhost).
  await expect(
    page.getByRole("link", { name: "로그인" }).first(),
  ).toHaveAttribute("href", "/login");

  // The dominant amber CTA — 정비 접수 — routes to the public intake form.
  await expect(
    page.getByRole("link", { name: "정비 접수" }).first(),
  ).toHaveAttribute("href", "/support/new");

  await page.screenshot({
    path: "e2e/.artifacts/storefront-home.png",
    fullPage: true,
  });
});

test("STOREFRONT FSM-platform nav navigates to the public /platform-fsm showcase", async ({
  page,
}) => {
  await page.goto("/landing");

  await page.getByRole("link", { name: "FSM 플랫폼" }).first().click();
  await expect(page).toHaveURL(/\/platform-fsm/, { timeout: 15_000 });

  // The PlatformFsmPage hero h1 (ko.landing.hero.title) renders.
  await expect(
    page.getByRole("heading", {
      name: "접수부터 배차·현장 정비·정산·KPI까지, 하나의 콘솔로",
      level: 1,
    }),
  ).toBeVisible({ timeout: 8_000 });
});

test("STOREFRONT 정비 접수 CTA navigates to the public intake form", async ({
  page,
}) => {
  await page.goto("/landing");

  await page.getByRole("link", { name: "정비 접수" }).first().click();
  await expect(page).toHaveURL(/\/support\/new/, { timeout: 15_000 });
});
