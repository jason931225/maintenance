import { test, expect } from "../fixtures/roles";
import type { TenantRole } from "../fixtures/roles";

/**
 * NEG-NAV-CATALOG — the sales-listing & inquiry admin page (`/catalog`,
 * "판매·문의 관리") is ADMIN/SUPER_ADMIN only.
 *
 * Two layers must agree, and this spec checks BOTH in the browser:
 *   (a) nav gate: the catalog nav item is gated to ADMIN_ROLES in
 *       `web/src/components/shell/nav.ts`, so it is HIDDEN from MECHANIC /
 *       RECEPTIONIST / EXECUTIVE shells.
 *   (b) route guard: `/catalog` is under `RequireAdminRoute`, so a direct-URL
 *       visit by a non-admin is bounced to `/work-hub` and the CatalogAdminPage
 *       never renders.
 *
 * This extends the existing per-role hidden-nav contracts (mech/recp/exec
 * neg-nav specs) with the catalog item, which those arrays predate.
 */

const CATALOG_NAV_LABEL = "판매·문의 관리"; // nav.catalog
const NON_ADMIN_ROLES: readonly TenantRole[] = [
  "MECHANIC",
  "RECEPTIONIST",
  "EXECUTIVE",
];

for (const role of NON_ADMIN_ROLES) {
  test(`NEG-NAV-CATALOG catalog nav item is hidden for ${role}`, async ({
    page,
    loginAs,
  }) => {
    await loginAs(role);
    await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

    // The catalog nav link must not appear in this role's shell.
    await expect(
      page.getByRole("link", { name: CATALOG_NAV_LABEL }).first(),
    ).not.toBeVisible();
  });

  test(`NEG-NAV-CATALOG direct visit to /catalog bounces ${role} to /work-hub`, async ({
    page,
    loginAs,
  }) => {
    await loginAs(role);
    await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

    // /catalog is gated by RequireAdminRoute → redirect to /work-hub; the
    // CatalogAdminPage heading must never render for a non-admin.
    await page.goto("/catalog");
    await expect(page).not.toHaveURL(/\/catalog/, { timeout: 8_000 });
    await expect(page).toHaveURL(/\/work-hub/, { timeout: 8_000 });
    await expect(
      page.getByRole("heading", { name: /판매·문의 관리/, level: 1 }),
    ).toHaveCount(0);
  });
}

test("NEG-NAV-CATALOG catalog nav + page ARE available to SUPER_ADMIN (control)", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // The catalog nav link is visible for an admin role…
  await expect(
    page.getByRole("link", { name: CATALOG_NAV_LABEL }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // …and the route renders the CatalogAdminPage rather than bouncing.
  await page.goto("/catalog");
  await expect(page).toHaveURL(/\/catalog/, { timeout: 8_000 });
  await expect(
    page.getByRole("heading", { name: /판매·문의 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
});
