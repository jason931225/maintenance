import {
  test,
  expect,
  redeemOtp,
  enrollPasskey,
  submitSignup,
  readSignupOtpFromLog,
} from "../fixtures/auth";

/**
 * AUTH-07 — open self-service signup (#38).
 *
 * The full open-signup chain against a real headless Chromium + CDP virtual
 * authenticator: a brand-new visitor signs up with an email, the backend creates
 * a lowest-privilege MEMBER account and "emails" a one-time code (the stub email
 * sender logs it, since MNT_EMAIL_* is unset in e2e), the visitor redeems that
 * code, is forced through passkey onboarding, enrolls a discoverable passkey, and
 * lands in the role-gated console showing only the MEMBER minimal surface.
 *
 * This proves the real end-to-end signup path (no stubs in the app flow itself —
 * only the email transport is the stub, which is the sanctioned dev/e2e sender).
 */
test("AUTH-07 open signup: email -> stub OTP -> redeem -> enroll -> MEMBER minimal console", async ({
  page,
  authenticator,
}) => {
  const email = `e2e-signup-${Date.now().toString(36)}@example.com`;

  // 1) Sign up with an email. The page confirms a code was sent.
  await submitSignup(page, email);

  // 2) Read the one-time code the stub email sender logged, then redeem it.
  const otp = readSignupOtpFromLog(email);
  await redeemOtp(page, otp);

  // 3) A first OTP sign-in always needs a passkey: forced into onboarding.
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
  await enrollPasskey(page);

  // 4) A freshly self-registered MEMBER is a tenant session: after onboarding the
  // route guard lands it on the default tenant route, NOT the platform console.
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/platform/);

  // The virtual authenticator now holds exactly one resident credential.
  const { credentials } = await authenticator.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: authenticator.authenticatorId,
  });
  expect(credentials.length).toBe(1);
  expect(credentials[0]?.isResidentCredential).toBe(true);

  // 5) Role-gated console: MEMBER sees the minimal surface. Every admin/role-gated
  // nav item (approvals, KPI, users, org, sites, catalog, ops, ...) is hidden; a
  // MEMBER is denied everything but Login until an admin elevates it.
  await expect(
    page.getByRole("link", { name: /승인|결재/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: /KPI/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /사용자/ })).toHaveCount(0);

  // 6) Hard-guard: navigating to an admin-only route bounces a MEMBER back to the
  // default tenant route (RequireAdminRoute redirects to /dispatch).
  await page.goto("/settings/users");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
});
