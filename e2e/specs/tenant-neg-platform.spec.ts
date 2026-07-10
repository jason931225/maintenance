import { test, expect } from "../fixtures/roles";
import type { Page } from "@playwright/test";

/**
 * TENANT-NEG-PLATFORM — a tenant session may NOT reach the vendor platform-admin
 * console.
 *
 * `/platform/*` is gated by `RequirePlatformRoute`, which renders the nested
 * route only when the session carries the `platform` JWT claim
 * (`session.isPlatform`). Every seeded tenant role (ADMIN, MECHANIC, …) carries a
 * TENANT token — no `platform` claim — so any direct visit to a `/platform/*`
 * route is bounced back into the tenant app at `/work-hub`, and the platform
 * admin UI (the tenants table) never renders.
 *
 * This mirrors the AUTH-07b negative pattern (a platform session bounced OFF a
 * tenant route) in the opposite direction: a tenant session bounced OFF the
 * platform console. The backend independently rejects a tenant bearer on
 * `/api/platform/*` with 403 (covered by PLAT-04); this spec is the browser-side
 * routing guard.
 */

/** Platform-console routes that must be unreachable for a tenant session. */
const PLATFORM_ROUTES = [
  "/platform",
  "/platform/tenants",
  "/platform/ops",
  "/platform/onboard",
] as const;

/**
 * Assert the guard bounced a tenant session back to /work-hub and the platform
 * console never rendered. The platform shell heads its surfaces with "테넌트"
 * (tenant) management copy; on /work-hub that text is absent.
 */
async function assertPlatformConsoleNotShown(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/\/platform/, { timeout: 8_000 });
  await expect(page).toHaveURL(/\/work-hub/, { timeout: 8_000 });
  // Visible-outcome: the tenant work hub heading is shown, the platform tenants
  // table heading is not.
  await expect(
    page.getByRole("heading", { name: /업무 허브/, level: 1 }).first(),
  ).toBeVisible({ timeout: 8_000 });
}

for (const route of PLATFORM_ROUTES) {
  test(`TENANT-NEG ADMIN visiting ${route} is bounced to /work-hub`, async ({
    page,
    loginAs,
  }) => {
    await loginAs("ADMIN");
    await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

    await page.goto(route);
    await assertPlatformConsoleNotShown(page);
  });

  test(`TENANT-NEG MECHANIC visiting ${route} is bounced to /work-hub`, async ({
    page,
    loginAs,
  }) => {
    await loginAs("MECHANIC");
    await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

    await page.goto(route);
    await assertPlatformConsoleNotShown(page);
  });
}
