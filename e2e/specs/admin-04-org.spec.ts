import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-04 — admin creates a region, creates a branch under it, then edits the
 * branch. Driven against /settings/org as the seeded SUPER_ADMIN.
 *
 * Selectors mirror OrgPage.test.tsx (Korean labels). Created rows are cleaned up
 * before each run so creates are order-independent.
 */

const ORG_ID = TENANT_ORG_ID;

function clearCreatedOrg() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM branches WHERE name LIKE 'E2E생성지점%';
     DELETE FROM regions WHERE name LIKE 'E2E생성지역%';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearCreatedOrg();
});

test("ADMIN-04 admin creates a region + branch and edits the branch", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/settings/org");
  await expect(
    page.getByRole("heading", { name: /지역·지점 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // ── Create a region ─────────────────────────────────────────────────────────
  await page.getByLabel("지역명").fill("E2E생성지역");
  await page.getByRole("button", { name: "지역 등록" }).click();
  await expect(page.getByText(/지역을 등록했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
  // The region appears in the region list.
  await expect(page.getByText("E2E생성지역").first()).toBeVisible({
    timeout: 8_000,
  });

  // ── Create a branch under that region ───────────────────────────────────────
  await page.getByLabel("지점명").fill("E2E생성지점");
  // The region <select> is labelled "지역"; pick the just-created region by label.
  await page
    .locator("#branch-region")
    .selectOption({ label: "E2E생성지역" });
  await page.getByRole("button", { name: "지점 등록" }).click();
  await expect(page.getByText(/지점을 등록했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByText("E2E생성지점").first()).toBeVisible({
    timeout: 8_000,
  });

  // ── Edit the branch (rename) ────────────────────────────────────────────────
  // Click 수정 on the row for the created branch. Once in edit mode the row swaps
  // to the BranchEditRow form (the branch name moves from text into an <input>),
  // so target the edit input globally by its aria-label rather than by row text.
  await page
    .getByRole("listitem")
    .filter({ hasText: "E2E생성지점" })
    .getByRole("button", { name: "수정" })
    .click();

  // The edit form lives inside the branch list <li> (now showing a 저장 button).
  // Scope to that <li> to disambiguate the edit "지점명" input from the create one.
  const editRow = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: /^저장$/ }) });
  const nameEdit = editRow.getByLabel("지점명");
  await expect(nameEdit).toBeVisible({ timeout: 5_000 });
  await nameEdit.fill("E2E생성지점-수정");
  await editRow.getByRole("button", { name: /^저장$/ }).click();
  await expect(page.getByText(/지점을 수정했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByText("E2E생성지점-수정").first()).toBeVisible({
    timeout: 8_000,
  });
});
