import { test, expect } from "../fixtures/auth";

/**
 * STOREFRONT — the public KNL marketing surface (#6).
 *
 * `/landing` (and `/`, `/home`) now render the redesigned StorefrontHomePage
 * inside PublicLayout — this supersedes the removed #10 LandingPage. The page is
 * public + unauthenticated: a one-stop hero with a 정비 접수 CTA into the public
 * intake (/support/new), a fenced console nav link (/platform-fsm), and a
 * staff 로그인 link that on dev/preview stays same-origin (/login).
 *
 * The previous spec asserted the old #10 LandingPage (the "하나의 콘솔로" hero,
 * 자주 묻는 질문 FAQ, 구독 문의하기 CTA) at /landing — none of which render there
 * anymore. This rewrite asserts the CURRENT storefront the product actually
 * ships, plus the /platform-fsm showcase the FSM nav link points to.
 */
test("STOREFRONT home renders the current hero, console nav, login, intake CTA, and footer", async ({
  page,
}) => {
  await page.goto("/landing");

  // Current StorefrontHomePage hero headline.
  await expect(
    page.getByRole("heading", {
      name: "지게차 렌탈·정비·운영을 하나로",
      level: 1,
    }),
  ).toBeVisible();

  // The PublicLayout header carries the fenced 콘솔 nav link → /platform-fsm.
  await expect(
    page.getByRole("link", { name: /콘솔 — 지게차 임대·정비 운영 플랫폼 소개/ }).first(),
  ).toHaveAttribute("href", "/platform-fsm");

  // The staff 로그인 link hands off to the console login. consoleHref() resolves
  // to the same-origin relative /login on the e2e preview origin (localhost).
  await expect(
    page.getByRole("link", { name: "로그인" }).first(),
  ).toHaveAttribute("href", "/login");

  // Both the header request link and hero CTA route to the public intake form.
  await expect(
    page.getByRole("link", { name: "정비 접수" }).first(),
  ).toHaveAttribute("href", "/support/new");
  await expect(
    page.getByRole("link", { name: "정비·수리 접수하기" }).first(),
  ).toHaveAttribute("href", "/support/new");

  // Current footer and cookie notice surfaces stay public and same-page.
  await expect(
    page.getByRole("navigation", { name: "패밀리 사이트" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "COSS" })).toHaveAttribute(
    "href",
    "https://www.cossok.com/",
  );
  await expect(page.getByLabel("쿠키 안내")).toContainText("필수 쿠키 안내");
  await expect(page.getByText(/© \d{4} KNL\. 모든 권리 보유\./)).toBeVisible();

  await page.screenshot({
    path: "e2e/.artifacts/storefront-home.png",
    fullPage: true,
  });
});

test("STOREFRONT console nav navigates to the public /platform-fsm showcase", async ({
  page,
}) => {
  await page.goto("/landing");

  await page
    .getByRole("link", { name: /콘솔 — 지게차 임대·정비 운영 플랫폼 소개/ })
    .first()
    .click();
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
