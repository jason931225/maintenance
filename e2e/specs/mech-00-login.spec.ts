import { test, expect } from "../fixtures/roles";

/**
 * MECH-00 — smoke test for the per-role login fixture.
 *
 * Drives the real OTP→onboard→enroll ceremony for the seeded MECHANIC and asserts
 * the session lands in the tenant app on /dispatch. Validates DELIVERABLE 1 before
 * the story specs build on it.
 */
test("MECH-00 mechanic logs in via the real ceremony and lands on /dispatch", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
});
