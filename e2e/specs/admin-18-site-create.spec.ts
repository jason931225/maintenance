import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-18 — direct customer/site registration (GitHub #13 slice 2).
 *
 * The admin "고객·현장 관리" page (/settings/sites) now has a "고객·현장 등록"
 * affordance that creates a customer (POST /api/v1/customers) and a site under it
 * (POST /api/v1/sites). After registration the new site must appear in the
 * 고객·현장 list (the by-location read that populates the site select).
 *
 * Cleaned up before each run so the spec is idempotent.
 */

const ORG_ID = TENANT_ORG_ID;
const CUSTOMER_NAME = "E2E직접등록고객";
const SITE_NAME = "E2E직접등록현장";

function clearCreated() {
  // Delete site first (FK), then customer, under the armed tenant org so RLS
  // permits the delete even as the superuser psql role honours the policy.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM registry_sites WHERE name = '${SITE_NAME}';
     DELETE FROM registry_customers WHERE name = '${CUSTOMER_NAME}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearCreated();
});

test.afterEach(() => {
  clearCreated();
});

test("ADMIN-18 admin registers a new customer + site and it appears in the list", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/settings/sites");

  await expect(
    page.getByRole("heading", { name: "고객·현장 관리" }),
  ).toBeVisible({ timeout: 8_000 });

  // Open the registration dialog.
  await page.getByRole("button", { name: "고객·현장 등록" }).click();
  const dialog = page.getByRole("dialog", { name: "고객·현장 등록" });
  await expect(dialog).toBeVisible();

  // Register a brand-new customer + site. When the org already has customers the
  // dialog defaults to "existing customer", so switch to "new customer" if the
  // toggle is present (it is hidden when there are no customers yet).
  const newCustomerRadio = dialog.getByRole("radio", { name: "새 고객 등록" });
  if (await newCustomerRadio.count()) {
    await newCustomerRadio.click();
  }
  await dialog.getByRole("textbox", { name: "고객명" }).fill(CUSTOMER_NAME);
  await dialog.getByRole("textbox", { name: "현장명" }).fill(SITE_NAME);
  await dialog.getByRole("button", { name: "등록", exact: true }).click();

  // Success: the dialog closes and the new site is selected/announced.
  await expect(
    page.getByText("현장을 등록했습니다.").first(),
  ).toBeVisible({ timeout: 10_000 });

  // The new site appears in the 고객·현장 list (the site select options).
  const select = page.getByRole("combobox", { name: "사업장 선택" });
  await expect(
    select.locator("option", { hasText: SITE_NAME }),
  ).toHaveCount(1, { timeout: 8_000 });
});
