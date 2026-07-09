import { test, expect } from "../fixtures/roles";

/**
 * AUTH-09 — rapid protected-route hard navigation.
 *
 * Browser dogfood caught a SUPER_ADMIN session getting bounced to
 * `/login?next=...` after many protected-route `page.goto()` visits because each
 * hard navigation loses the in-memory access token and relies on boot silent
 * refresh from the HttpOnly `mnt_refresh` cookie. That is a legitimate browser
 * pattern (reloads, bookmarked deep links, QA/dogfood crawls), so it must not trip
 * the refresh endpoint's ordinary auth-attempt cap.
 */
test("AUTH-09 rapid hard navigation does not rate-limit boot refresh", async ({
  page,
  loginAs,
}) => {
  const refresh429s: string[] = [];
  page.on("response", (response) => {
    if (
      response.status() === 429 &&
      new URL(response.url()).pathname === "/api/v1/auth/token/refresh"
    ) {
      refresh429s.push(`${response.request().method()} ${response.url()}`);
    }
  });

  await loginAs("SUPER_ADMIN");

  const protectedRoutes = [
    "/overview",
    "/dispatch",
    "/dispatch-map",
    "/intake",
    "/approvals",
    "/daily-plan",
    "/collaboration",
    "/inspection",
    "/messenger",
    "/mail",
    "/support",
    "/settings/profile",
  ] as const;

  for (const route of protectedRoutes) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("navigation", { name: /메인 내비게이션/ }),
      `${route} should still render the authenticated shell`,
    ).toBeVisible({ timeout: 15_000 });
    await expect(page, `${route} should not bounce to login`).not.toHaveURL(
      /\/login(?:\?|$)/,
    );
  }

  expect(refresh429s).toEqual([]);
});
