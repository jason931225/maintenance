import { test, expect } from "../fixtures/roles";

/**
 * ADMIN-00 — smoke test for the SUPER_ADMIN + ADMIN role login fixtures.
 *
 * Drives the real OTP→onboard→enroll ceremony for the seeded SUPER_ADMIN and
 * ADMIN and asserts each lands in the tenant app on /dispatch. Validates the
 * per-role login fixture before the ADMIN/SADMIN story specs build on it.
 */
test("ADMIN-00 SUPER_ADMIN logs in via the real ceremony and lands on /dispatch", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
});

test("ADMIN-00 ADMIN logs in via the real ceremony and lands on /dispatch", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
});
