import {
  test,
  expect,
  COLDSTART_OTP,
  redeemOtp,
  enrollPasskey,
} from "../fixtures/auth";

/**
 * PLAT-04 NEGATIVE — a PLATFORM session is rejected on tenant /api/* routes.
 *
 * The two tiers are strictly separated: a PLATFORM token is rejected on the
 * tenant `/api/*` routes (and a tenant token on `/api/platform/*`). The platform
 * extractor bounces the wrong tier with 403 BEFORE any handler runs.
 *
 * We capture the live platform bearer from an outgoing `/api/platform/*` request,
 * then replay it against a tenant API route and assert a 403. The UI-level bounce
 * (a platform session visiting a tenant page is sent back to /platform) is also
 * asserted, mirroring AUTH-07b but from the platform side.
 */

test("PLAT-04 platform bearer is rejected (403) on a tenant /api route", async ({
  page,
}) => {
  await redeemOtp(page, COLDSTART_OTP);
  await enrollPasskey(page);
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });

  // Capture the platform access token from a real platform request's auth header.
  const bearer = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("no /platform/* request captured")),
      15_000,
    );
    page.on("request", (request) => {
      if (!request.url().includes("/platform/")) return;
      const auth = request.headers()["authorization"];
      if (auth?.startsWith("Bearer ")) {
        clearTimeout(timer);
        resolve(auth.slice("Bearer ".length));
      }
    });
    // Trigger a platform request (the tenant list reload).
    void page.goto("/platform/tenants");
  });

  expect(bearer.length).toBeGreaterThan(0);

  // Replay the platform bearer against a TENANT /api route → must be 403 (wrong
  // token tier), never 200. A 401 would mean the token didn't authenticate at
  // all; we specifically assert the tier rejection (403).
  const response = await page.request.get("/api/v1/work-orders", {
    headers: { Authorization: `Bearer ${bearer}` },
    failOnStatusCode: false,
  });
  expect(response.status()).toBe(403);
});

test("PLAT-04 platform session visiting a tenant page is bounced to /platform", async ({
  page,
}) => {
  await redeemOtp(page, COLDSTART_OTP);
  await enrollPasskey(page);
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });

  // A platform admin landing on a tenant route is bounced into the platform console.
  await page.goto("/dispatch");
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/dispatch/);
});
