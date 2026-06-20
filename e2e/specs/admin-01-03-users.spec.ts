import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-01 — admin creates a user (roles + branches + team) → appears in list.
 * ADMIN-02 — admin issues a one-time sign-in code for a user (shows OTP).
 * ADMIN-03 — admin edits + deactivates a user.
 *
 * Driven against the real /settings/users page as the seeded SUPER_ADMIN. The
 * created users are cleaned up before each run so the suite is order-independent.
 * Selectors mirror UsersPage.test.tsx (Korean labels; no test-ids).
 */

const ORG_ID = TENANT_ORG_ID;

/** Delete any E2E-created users (by display-name prefix) so creates don't collide. */
function clearCreatedUsers() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM user_branches WHERE user_id IN (
       SELECT id FROM users WHERE display_name LIKE 'E2E생성%'
     );
     DELETE FROM auth_bootstrap_credentials WHERE user_id IN (
       SELECT id FROM users WHERE display_name LIKE 'E2E생성%'
     );
     DELETE FROM users WHERE display_name LIKE 'E2E생성%';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearCreatedUsers();
});

test("ADMIN-01 admin creates a user with roles + branches + team → appears in list", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/settings/users");
  await expect(
    page.getByRole("heading", { name: /사용자 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Fill the create form (left form panel). Team defaults to 정비(MAINTENANCE).
  await page.getByLabel("이름", { exact: true }).fill("E2E생성-정비사");

  // Pick the MECHANIC role (정비사) and the seeded E2E Branch.
  await page.getByLabel("정비사").check();
  await page.getByLabel("E2E Branch").check();

  // Submit. The create button label is "사용자 등록".
  await page.getByRole("button", { name: "사용자 등록" }).click();

  // Success feedback + the new row appears in the user table.
  await expect(page.getByText(/사용자를 등록했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
  await expect(
    page.getByRole("cell", { name: "E2E생성-정비사" }),
  ).toBeVisible({ timeout: 8_000 });

  // The brand-new user has no credential yet → the "로그인 불가" badge shows.
  const row = page.getByRole("row", { name: /E2E생성-정비사/ });
  await expect(row.getByText(/로그인 불가/)).toBeVisible();
});

test("ADMIN-02 admin issues a one-time sign-in code for a user (shows OTP)", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/settings/users");
  await expect(
    page.getByRole("heading", { name: /사용자 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Create a user first so we have a fresh target with a branch.
  await page.getByLabel("이름", { exact: true }).fill("E2E생성-코드대상");
  await page.getByLabel("접수담당").check();
  await page.getByLabel("E2E Branch").check();
  await page.getByRole("button", { name: "사용자 등록" }).click();
  await expect(page.getByText(/사용자를 등록했습니다\./)).toBeVisible({
    timeout: 8_000,
  });

  // Open the issue-OTP dialog from the new user's row.
  const row = page.getByRole("row", { name: /E2E생성-코드대상/ });
  await row.getByRole("button", { name: "일회용 코드 발급" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Issue the code inside the dialog.
  await dialog.getByRole("button", { name: "일회용 코드 발급" }).click();

  // The issued code block renders ("발급된 코드") with a non-empty <code> value.
  await expect(dialog.getByText(/발급된 코드/)).toBeVisible({ timeout: 8_000 });
  const issuedCode = dialog.locator("code");
  await expect(issuedCode).toBeVisible();
  await expect(issuedCode).not.toBeEmpty();
});

test("ADMIN-03 admin edits + deactivates a user", async ({ page, loginAs }) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/settings/users");
  await expect(
    page.getByRole("heading", { name: /사용자 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Create the target user.
  await page.getByLabel("이름", { exact: true }).fill("E2E생성-수정대상");
  await page.getByLabel("정비사").check();
  await page.getByLabel("E2E Branch").check();
  await page.getByRole("button", { name: "사용자 등록" }).click();
  await expect(page.getByText(/사용자를 등록했습니다\./)).toBeVisible({
    timeout: 8_000,
  });

  // ── Edit ──────────────────────────────────────────────────────────────────
  const row = page.getByRole("row", { name: /E2E생성-수정대상/ });
  await row.getByRole("button", { name: "수정" }).click();

  // The form switches to edit mode ("사용자 수정"). Change the phone, save.
  await expect(page.getByRole("heading", { name: /사용자 수정/ })).toBeVisible({
    timeout: 5_000,
  });
  await page.locator("#user-phone").fill("010-1234-5678");
  await page.getByRole("button", { name: "변경 저장" }).click();
  await expect(page.getByText(/변경 사항을 저장했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
  // The new phone shows in the row.
  await expect(
    page.getByRole("row", { name: /E2E생성-수정대상/ }).getByText("010-1234-5678"),
  ).toBeVisible({ timeout: 8_000 });

  // ── Deactivate ──────────────────────────────────────────────────────────────
  // window.confirm is auto-accepted.
  page.on("dialog", (d) => void d.accept());
  await page
    .getByRole("row", { name: /E2E생성-수정대상/ })
    .getByRole("button", { name: "비활성화" })
    .click();
  await expect(page.getByText(/사용자를 비활성화했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
});
