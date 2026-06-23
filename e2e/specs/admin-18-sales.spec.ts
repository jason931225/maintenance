import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-18 — sales catalog lifecycle (#6 / #27 SalesManage = ADMIN+).
 *
 * Drives the full "put assets up for sale" path against the real UI + API:
 *   1. SUPER_ADMIN logs in and opens /catalog (CatalogAdminPage).
 *   2. Creates a 중고 (USED) sales listing via the dialog as a DRAFT — a DRAFT is
 *      NOT publicly visible.
 *   3. Publishes it by switching the row status select to 게시중 / PUBLISHED.
 *   4. Asserts it now appears on the PUBLIC storefront /used (판매) page.
 *   5. Creates + publishes a 신차 (NEW) listing, then asserts the storefront's
 *      신차 sub-category tab shows it while the 중고 tab shows the used one and
 *      hides the new one — proving the 중고/신차 condition filter end-to-end.
 *
 * Self-contained + order-independent: the listings carry unique model names and
 * are deleted before each run. The sales catalog is the KNL org catalog.
 */

const ORG_ID = TENANT_ORG_ID;
// Distinctive model names so rows + public cards are unambiguous selectors.
// Deliberately avoid the substrings 중고/신차 so a text assertion on the 판매
// 구분 column never collides with the model name in the same row.
const MODEL_NAME = "E2E매물-전동지게차-ZZ18";
const NEW_MODEL_NAME = "E2E매물-디젤지게차-ZZ27";

function clearCreatedListing() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM sales_listings WHERE model_name IN ('${MODEL_NAME}', '${NEW_MODEL_NAME}');
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

  // ── Still on /catalog: publish the 중고 listing via its row status select ────
  await page.goto("/catalog");
  const publishRow = page.getByRole("row").filter({ hasText: MODEL_NAME });
  await expect(publishRow).toBeVisible({ timeout: 8_000 });
  await publishRow.getByRole("combobox").selectOption("PUBLISHED");
  // The PATCH + reload settles with the row now PUBLISHED (게시중).
  await expect(publishRow.getByRole("combobox")).toHaveValue("PUBLISHED", {
    timeout: 8_000,
  });

  // ── Same /catalog session: create + publish a 신차 (NEW) listing ─────────────
  // Done in this one admin session (no extra round-trips) so the 중고/신차 split
  // is exercised with a single later storefront visit.
  await page.getByRole("button", { name: "매물 등록" }).click();
  const newDialog = page.locator("form").filter({ hasText: "모델명" });
  await expect(
    page.getByRole("heading", { name: "매물 등록" }).last(),
  ).toBeVisible({ timeout: 5_000 });
  await newDialog.getByLabel("모델명").fill(NEW_MODEL_NAME);
  await newDialog.getByLabel("가격(원)").fill("39000000");
  // Set the 판매 구분 control to 신차 — the real new-condition capability.
  await newDialog.getByLabel("판매 구분").selectOption("NEW");
  await newDialog.getByRole("button", { name: "저장" }).click();

  const newRow = page.getByRole("row").filter({ hasText: NEW_MODEL_NAME });
  await expect(newRow).toBeVisible({ timeout: 8_000 });
  // The 판매 구분 column cell renders exactly 신차 for the new listing.
  await expect(
    newRow.getByRole("cell", { name: "신차", exact: true }),
  ).toBeVisible({ timeout: 8_000 });
  await newRow.getByRole("combobox").selectOption("PUBLISHED");
  await expect(newRow.getByRole("combobox")).toHaveValue("PUBLISHED", {
    timeout: 8_000,
  });

  // ── One PUBLIC storefront visit exercises the whole 중고/신차 split ──────────
  await page.goto("/used");
  await expect(
    page.getByRole("heading", { name: "검수된 중고 지게차를 조건별로 비교", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  // Default (전체) shows BOTH the published 중고 and 신차 cards.
  await expect(
    page.getByRole("heading", { name: MODEL_NAME, level: 3 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(
    page.getByRole("heading", { name: NEW_MODEL_NAME, level: 3 }),
  ).toBeVisible({ timeout: 8_000 });

  // 신차 tab → the new listing is present, the used one is gone.
  await page.getByRole("button", { name: "신차", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: NEW_MODEL_NAME, level: 3 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(MODEL_NAME)).toHaveCount(0, { timeout: 8_000 });

  // 중고 tab → the used listing is present, the 신차 one is gone.
  await page.getByRole("button", { name: "중고", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: MODEL_NAME, level: 3 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(NEW_MODEL_NAME)).toHaveCount(0, {
    timeout: 8_000,
  });

  await page.screenshot({
    path: "e2e/.artifacts/sales-storefront.png",
    fullPage: true,
  });
});
