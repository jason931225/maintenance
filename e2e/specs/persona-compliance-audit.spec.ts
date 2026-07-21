import { test, expect } from "../fixtures/roles";

/**
 * PERSONA-COMPLIANCE-AUDIT — production exposure boundary.
 *
 * Both governance roles must remain on the working legacy surface while the
 * ADR-0025 evidence manifest is empty. Role-specific mounted-nav assertions
 * belong in the later development-only shell harness, not production E2E.
 */
for (const role of ["SUPER_ADMIN", "ADMIN"] as const) {
  test(`PERSONA-COMPLIANCE-AUDIT ${role} stays on the legacy overview while console inventory is DARK`, async ({
    page,
    loginAs,
  }) => {
    await loginAs(role);
    await page.goto("/console");

    await expect(page).toHaveURL(/\/overview(?:$|[?#])/, { timeout: 15_000 });
    await expect(page.locator("[data-console-root]")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "메인 내비게이션" }),
    ).toBeVisible();
  });
}
