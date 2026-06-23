import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-18 — sales catalog lifecycle (#6 SalesManage = ADMIN+).
 *
 * Drives the full "put assets up for sale" path against the real UI + API:
 *   1. SUPER_ADMIN logs in and opens /catalog (CatalogAdminPage).
 *   2. Creates a sales listing via the dialog (POST /api/v1/sales/listings) as a
 *      DRAFT — a DRAFT is NOT publicly visible.
 *   3. Publishes it by switching the row status select to 게시중 / PUBLISHED
 *      (PATCH /api/v1/sales/listings/{id} { status: "PUBLISHED" }).
 *   4. Asserts it now appears on the PUBLIC storefront /used page (which reads
 *      GET /api/v1/storefront/listings — published-only, no auth).
 *
 * Self-contained + order-independent: the listing carries a unique model name
 * and is deleted before each run. The sales catalog is the KNL org catalog.
 */

const ORG_ID = TENANT_ORG_ID;
// Distinctive model name so the row + the public card are unambiguous selectors.
const MODEL_NAME = "E2E매물-전동지게차-ZZ18";

function clearCreatedListing() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM sales_listings WHERE model_name = '${MODEL_NAME}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearCreatedListing();
});

test.afterAll(() => {
  clearCreatedListing();
});

test("ADMIN-18 admin creates a sales listing, publishes it, and it appears on the public storefront", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");

  // ── Open the sales catalog admin ────────────────────────────────────────────
  await page.goto("/catalog");
  await expect(
    page.getByRole("heading", { name: "판매·문의 관리", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  // The listings tab table heading renders for SalesManage holders.
  await expect(
    page.getByRole("heading", { name: "매물 목록" }),
  ).toBeVisible({ timeout: 8_000 });

  // ── Create a DRAFT listing (POST /api/v1/sales/listings) ────────────────────
  await page.getByRole("button", { name: "매물 등록" }).click();

  // The create dialog opens (createTitle == newButton text "매물 등록").
  const dialog = page.locator("form").filter({ hasText: "모델명" });
  await expect(
    page.getByRole("heading", { name: "매물 등록" }).last(),
  ).toBeVisible({ timeout: 5_000 });

  // model_name is the only required field; leave status as DRAFT (default).
  await dialog.getByLabel("모델명").fill(MODEL_NAME);
  // Give it a price so the public card renders a concrete value (not 가격 문의).
  await dialog.getByLabel("가격(원)").fill("18500000");
  // Submit the dialog form (form save button == "저장").
  await dialog.getByRole("button", { name: "저장" }).click();

  // The dialog closes and the new row appears in the listings table as DRAFT.
  const row = page.getByRole("row").filter({ hasText: MODEL_NAME });
  await expect(row).toBeVisible({ timeout: 8_000 });
  // The per-row status select reflects the DRAFT (임시저장) status.
  const statusSelect = row.getByRole("combobox");
  await expect(statusSelect).toHaveValue("DRAFT");

  // A DRAFT must NOT yet be on the public storefront.
  await page.goto("/used");
  await expect(
    page.getByRole("heading", { name: "검수된 중고 지게차를 조건별로 비교", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  // The inventory live-region settles; the draft model is absent.
  await expect(page.getByText(MODEL_NAME)).toHaveCount(0, { timeout: 8_000 });

  // ── Publish it (PATCH status PUBLISHED) via the row status select ───────────
  await page.goto("/catalog");
  const publishRow = page.getByRole("row").filter({ hasText: MODEL_NAME });
  await expect(publishRow).toBeVisible({ timeout: 8_000 });
  await publishRow.getByRole("combobox").selectOption("PUBLISHED");
  // The PATCH + reload settles with the row now PUBLISHED (게시중).
  await expect(publishRow.getByRole("combobox")).toHaveValue("PUBLISHED", {
    timeout: 8_000,
  });

  // ── Assert it now appears on the PUBLIC storefront /used page ───────────────
  await page.goto("/used");
  await expect(
    page.getByRole("heading", { name: "검수된 중고 지게차를 조건별로 비교", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  // The published listing renders as an equipment card (model_name is an h3).
  await expect(
    page.getByRole("heading", { name: MODEL_NAME, level: 3 }),
  ).toBeVisible({ timeout: 8_000 });

  await page.screenshot({
    path: "e2e/.artifacts/sales-storefront.png",
    fullPage: true,
  });
});
