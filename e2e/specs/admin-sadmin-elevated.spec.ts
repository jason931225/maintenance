import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * SADMIN — SUPER_ADMIN-only deltas, with an ADMIN NEGATIVE counterpart.
 *
 * The elevated-role grant (creating/promoting a user into EXECUTIVE/SUPER_ADMIN)
 * is gated by Feature::ElevatedRoleGrant, held ONLY by SUPER_ADMIN
 * (backend matrix `[D, D, D, D, A]`). The frontend renders the elevated-role
 * checkboxes to every admin, so the gate is enforced server-side: a plain ADMIN
 * granting an elevated role gets a 403 that surfaces as the create-failed error,
 * while a SUPER_ADMIN succeeds.
 *
 * This is the genuine UI behaviour — the control is not disabled client-side, it
 * is rejected by the backend — so the ADMIN negative asserts the create-failed
 * message rather than a disabled control.
 */

const ORG_ID = TENANT_ORG_ID;

function clearCreatedUsers() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM user_branches WHERE user_id IN (
       SELECT id FROM users WHERE display_name LIKE 'E2E임원%'
     );
     DELETE FROM auth_bootstrap_credentials WHERE user_id IN (
       SELECT id FROM users WHERE display_name LIKE 'E2E임원%'
     );
     DELETE FROM users WHERE display_name LIKE 'E2E임원%';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearCreatedUsers();
});

test("SADMIN SUPER_ADMIN grants an elevated (EXECUTIVE) role on user create", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/settings/users");
  await expect(
    page.getByRole("heading", { name: /사용자 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  await page.getByLabel("이름", { exact: true }).fill("E2E임원-수퍼생성");
  // Grant the elevated 임원(EXECUTIVE) role — allowed for SUPER_ADMIN.
  await page.getByLabel("임원").check();
  await page.getByLabel("E2E Branch").check();
  await page.getByRole("button", { name: "사용자 등록" }).click();

  // Success: the elevated grant is permitted for a SUPER_ADMIN.
  await expect(page.getByText(/사용자를 등록했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
  await expect(
    page.getByRole("cell", { name: "E2E임원-수퍼생성" }),
  ).toBeVisible({ timeout: 8_000 });
});

test("SADMIN-NEG plain ADMIN cannot grant an elevated (EXECUTIVE) role", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/settings/users");
  await expect(
    page.getByRole("heading", { name: /사용자 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  await page.getByLabel("이름", { exact: true }).fill("E2E임원-관리자거부");
  // A plain ADMIN attempts to grant the elevated 임원(EXECUTIVE) role.
  await page.getByLabel("임원").check();
  await page.getByLabel("E2E Branch").check();
  await page.getByRole("button", { name: "사용자 등록" }).click();

  // The backend rejects the elevated grant (403) → the create-failed error shows.
  await expect(
    page.getByText(/사용자를 등록하지 못했습니다\. 다시 시도하세요\./),
  ).toBeVisible({ timeout: 8_000 });
  // The user was NOT created — no matching row appears.
  await expect(
    page.getByRole("cell", { name: "E2E임원-관리자거부" }),
  ).toHaveCount(0);
});
