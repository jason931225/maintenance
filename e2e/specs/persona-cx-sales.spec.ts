import { test, expect } from "../fixtures/roles";

/**
 * PERSONA-CX-SALES — production exposure boundary.
 *
 * ADMIN remains the nearest current proxy for this persona, but no proxy may
 * enter development console inventory before ADR-0025 evidence admits it.
 * Production E2E locks the fail-closed legacy fallback until that promotion.
 */
test("PERSONA-CX-SALES stays on the legacy overview while console inventory is DARK", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/console");

  await expect(page).toHaveURL(/\/overview(?:$|[?#])/, { timeout: 15_000 });
  await expect(page.locator("[data-console-root]")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "메인 내비게이션" }),
  ).toBeVisible();
});
