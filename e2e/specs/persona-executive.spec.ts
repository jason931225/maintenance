import { test, expect } from "../fixtures/roles";

/**
 * PERSONA-EXECUTIVE — production exposure boundary.
 *
 * The executive console inventory is mounted for development verification but
 * remains DARK until ADR-0025 evidence admits at least one screen. Production
 * E2E therefore locks the fail-closed route; mounted nav behavior stays covered
 * by component tests until a dedicated development-only shell harness exists.
 */
test("PERSONA-EXECUTIVE stays on the legacy overview while console inventory is DARK", async ({
  page,
  loginAs,
}) => {
  await loginAs("EXECUTIVE");
  await page.goto("/console");

  await expect(page).toHaveURL(/\/overview(?:$|[?#])/, { timeout: 15_000 });
  await expect(page.locator("[data-console-root]")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "메인 내비게이션" }),
  ).toBeVisible();
});
