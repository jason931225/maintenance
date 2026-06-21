import { test, expect } from "../fixtures/auth";

/**
 * LANDING — the public marketing landing page (GitHub #10).
 *
 * Public + unauthenticated: renders the product, the feature showcase, and the
 * FAQ, with a login CTA that hands off to /login. The subscription + contact CTAs
 * route to the existing public inquiry form (/support/new) — the real customer
 * window — so no fabricated phone/email is published.
 */
test("LANDING public page renders product, features, FAQ, and CTAs", async ({
  page,
}) => {
  await page.goto("/landing");

  // Hero headline + the feature showcase + a feature group + the FAQ all render.
  await expect(
    page.getByRole("heading", {
      name: "접수부터 배차·현장 정비·정산·KPI까지, 하나의 콘솔로",
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "이 프로그램이 제공하는 기능", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "접수 · 배차" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "자주 묻는 질문", level: 2 }),
  ).toBeVisible();

  // Unauthenticated: the login CTA hands off to /login (no console CTA).
  await expect(page.getByRole("link", { name: "로그인" }).first()).toHaveAttribute(
    "href",
    "/login",
  );
  await expect(
    page.getByRole("link", { name: "콘솔로 이동" }),
  ).toHaveCount(0);

  // Subscription + contact CTAs route to the real public inquiry form.
  await expect(
    page.getByRole("link", { name: "구독 문의하기" }),
  ).toHaveAttribute("href", "/support/new");
  await expect(
    page.getByRole("link", { name: "문의 양식 작성" }),
  ).toHaveAttribute("href", "/support/new");

  await page.screenshot({
    path: "e2e/.artifacts/landing.png",
    fullPage: true,
  });
});

test("LANDING login CTA navigates to the login page", async ({ page }) => {
  await page.goto("/landing");
  await page.getByRole("link", { name: "로그인" }).first().click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});
