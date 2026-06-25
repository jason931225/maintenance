import { test, expect, COLDSTART_OTP, redeemOtp, enrollPasskey } from "../fixtures/auth";

/**
 * AUTH-01 — cold-start passkey login.
 *
 * The full first-run chain against a real headless Chromium + CDP virtual
 * authenticator: redeem the boot-seeded cold-start OTP, get forced through
 * passkey onboarding, enroll a discoverable passkey, land in the app, log out,
 * then sign back in with a discoverable (usernameless, empty-allowCredentials)
 * passkey assertion.
 *
 * The cold-start admin is a PLATFORM (vendor) session, so after enrollment the
 * route guard lands it on the /platform console rather than a tenant route.
 */
test("AUTH-01 cold-start: OTP redeem -> onboard -> enroll passkey -> logout -> passkey login", async ({
  page,
  authenticator,
}) => {
  // 1) Redeem the cold-start OTP and get forced into passkey onboarding.
  await redeemOtp(page, COLDSTART_OTP);
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });

  // 2) Enroll a discoverable passkey on the virtual authenticator.
  await enrollPasskey(page);

  // A platform session lands on the /platform console after onboarding.
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });

  // The virtual authenticator now holds exactly one resident credential.
  const { credentials } = await authenticator.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: authenticator.authenticatorId,
  });
  expect(credentials.length).toBe(1);
  expect(credentials[0]?.isResidentCredential).toBe(true);

  // 3) Log out -> bounced to /login.
  await page.evaluate(async () => {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Transport": "cookie" },
      body: "{}",
    });
  });
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login/);

  // 4) Discoverable passkey login: empty allowCredentials, virtual authenticator
  // asserts automatically. Lands back on the /platform console.
  await page.getByRole("button", { name: /패스키로 로그인/ }).click();
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });
});
