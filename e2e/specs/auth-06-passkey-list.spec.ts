import { test, expect, TENANT_ADMIN_OTP, redeemOtp, enrollPasskey } from "../fixtures/auth";

/**
 * AUTH-06 — passkey list + last-passkey revoke guard.
 *
 * Driven as a TENANT ADMIN session (the /api/v1/passkeys management routes are
 * tenant-tier; a platform token is rejected with WrongTokenTier). After enrolling
 * exactly one passkey, GET /api/v1/passkeys lists that single credential, and
 * DELETE-ing it (the last one) is refused with a 409 + the lockout-guard message.
 *
 * The seeded tenant admin has no security UI wired for this harness, so the
 * passkey-management API is exercised directly from the authenticated browser
 * context (same-origin, real session cookie + bearer).
 */
test("AUTH-06 passkey list shows the enrolled credential; last-passkey revoke is 409", async ({
  page,
}) => {
  await redeemOtp(page, TENANT_ADMIN_OTP);
  await enrollPasskey(page);
  // A tenant admin lands in the tenant app (default /dispatch).
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // Capture the in-memory access token via a cookie refresh.
  const token = await page.evaluate(async () => {
    const res = await fetch("/api/v1/auth/token/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Transport": "cookie" },
      credentials: "include",
      body: "{}",
    });
    const json = (await res.json()) as { access_token: string };
    return json.access_token;
  });
  expect(token).toBeTruthy();

  // GET /api/v1/passkeys -> exactly the one enrolled credential.
  const list = await page.evaluate(async (bearer: string) => {
    const res = await fetch("/api/v1/passkeys", {
      headers: { Authorization: `Bearer ${bearer}`, "X-Auth-Transport": "cookie" },
      credentials: "include",
    });
    return {
      status: res.status,
      body: (await res.json()) as Array<{ id: string }>,
    };
  }, token);
  expect(list.status).toBe(200);
  expect(list.body.length).toBe(1);
  const passkeyId = list.body[0]!.id;

  // DELETE the last (only) passkey -> 409 + lockout-guard message.
  const revoke = await page.evaluate(
    async ({ bearer, id }: { bearer: string; id: string }) => {
      const res = await fetch(`/api/v1/passkeys/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearer}`, "X-Auth-Transport": "cookie" },
        credentials: "include",
      });
      return { status: res.status, body: await res.text() };
    },
    { bearer: token, id: passkeyId },
  );
  expect(revoke.status).toBe(409);
  expect(revoke.body).toContain("cannot delete your last passkey");
});
