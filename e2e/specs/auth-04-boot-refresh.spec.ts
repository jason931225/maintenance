import { test, expect, COLDSTART_OTP, redeemOtp, enrollPasskey } from "../fixtures/auth";

/**
 * AUTH-04 — boot silent refresh.
 *
 * After a successful first sign-in + enrollment the session lives only in memory
 * (access token) plus the HttpOnly `mnt_refresh` cookie. A hard page reload drops
 * the in-memory token; the app must silently refresh from the cookie on boot and
 * restore the authenticated session rather than bounce to /login.
 */
test("AUTH-04 hard reload restores the session via the mnt_refresh cookie", async ({
  page,
}) => {
  await redeemOtp(page, COLDSTART_OTP);
  await enrollPasskey(page);
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });

  // Hard reload: in-memory access token is gone; only the HttpOnly cookie remains.
  await page.reload();

  // Silent boot refresh restores the session: we stay on /platform, NOT /login.
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/login/);
});
