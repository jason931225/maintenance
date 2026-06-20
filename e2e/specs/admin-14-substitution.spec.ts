import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-14 — admin assigns a 대차 (substitute) to a down unit and returns it.
 *
 * seed-admin.sql seeds a 예비 (spare) equipment (…ee0006, 호기 E2E-SPARE) that is
 * specification/power/tonnage-compatible with the seed-mech source equipment
 * (…ee0003, 호기 E2E-001), so the candidate read ranks it as an exact-ton match.
 *
 * The substitution source dropdown is populated by the page's autocomplete search,
 * so we first search for the source 호기 to surface it. Any open assignment from a
 * prior run is cleared before each run.
 */

const ORG_ID = TENANT_ORG_ID;
const SOURCE_ID = "00000000-0000-0000-0000-000000ee0003";
const SPARE_ID = "00000000-0000-0000-0000-000000ee0006";

function clearAssignments() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM equipment_substitutions
     WHERE source_equipment_id = '${SOURCE_ID}' OR substitute_equipment_id = '${SPARE_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearAssignments();
});

test("ADMIN-14 admin assigns a 대차 substitute and returns it", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/equipment");
  await expect(
    page.getByRole("heading", { name: /장비 조회/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Surface the source equipment in the page search so the substitution source
  // dropdown can offer it.
  await page.locator("#equipment-search").fill("E2E-001");
  await expect(page.getByText(/E2E모델-15T/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Select the source equipment for the substitution lookup.
  const sourceDropdown = page.locator("#substitution-source");
  await expect(sourceDropdown).toBeVisible({ timeout: 5_000 });
  await sourceDropdown.selectOption(SOURCE_ID);

  // Find candidates — the seeded spare should rank as an exact-ton match.
  await page.getByRole("button", { name: /대차 후보 조회/ }).click();
  await expect(
    page.getByRole("heading", { name: /대차 후보/ }),
  ).toBeVisible({ timeout: 8_000 });
  // The spare's 정확 일치 (ExactTon) badge confirms a compatible candidate.
  await expect(page.getByText(/정확 일치/).first()).toBeVisible({
    timeout: 8_000,
  });

  // ── Assign ──────────────────────────────────────────────────────────────────
  await page.locator("#substitution-location").fill("본사 정비고");
  await page.getByRole("button", { name: /^대차 배정$/ }).click();
  await expect(page.getByText(/대차를 배정했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
  // The active assignment block renders with the placement location.
  await expect(
    page.getByRole("heading", { name: /배정된 대차/ }),
  ).toBeVisible({ timeout: 8_000 });

  // ── Return ──────────────────────────────────────────────────────────────────
  await page.locator("#substitution-return-note").fill("E2E 반납 완료");
  await page.getByRole("button", { name: /^반납$/ }).click();
  await expect(page.getByText(/대차를 반납했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
});
