import { test, expect, COLDSTART_OTP, redeemOtp, enrollPasskey } from "../fixtures/auth";

/**
 * AUTH-05 — logout revokes the session.
 *
 * After logout the refresh-token family is revoked and the cookie cleared, so a
 * subsequent hard reload (which can only recover via the cookie) must NOT restore
 * a session — the protected route bounces to /login.
 */
test("AUTH-05 logout revokes the session; protected route bounces to /login", async ({
  page,
}) => {
  await redeemOtp(page, COLDSTART_OTP);
  await enrollPasskey(page);
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });

  // Revoke the session (web cookie transport).
  await page.evaluate(async () => {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Transport": "cookie" },
      credentials: "include",
      body: "{}",
    });
  });

  // Navigate to a protected route after revocation. The in-memory token may still
  // exist, so also hard-reload to force the cookie-only recovery path, which now
  // fails (revoked family + cleared cookie) -> /login.
  await page.goto("/platform/tenants");
  await page.reload();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});
