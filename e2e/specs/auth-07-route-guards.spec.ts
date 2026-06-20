import { test, expect, COLDSTART_OTP, redeemOtp, enrollPasskey } from "../fixtures/auth";

/**
 * AUTH-07 — route guards.
 *
 * (a) An unauthenticated visit to a protected route bounces to /login (with a
 *     `next` param preserving the destination).
 * (b) A platform (vendor) session is bounced off tenant routes into the /platform
 *     console by ProtectedRoute.
 */
test("AUTH-07a unauthenticated visit to a protected route bounces to /login", async ({
  page,
}) => {
  await page.goto("/dispatch");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  // The destination is preserved for post-login redirect.
  await expect(page).toHaveURL(/next=/);
});

test("AUTH-07b platform session is bounced off a tenant route to /platform", async ({
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
