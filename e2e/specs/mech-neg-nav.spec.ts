import { test, expect } from "../fixtures/roles";

/**
 * MECHANIC NEGATIVE — admin-only nav items are hidden; direct visits to
 * admin-only routes redirect/403 back to /dispatch.
 *
 * Expected visible nav for MECHANIC (from web/src/components/shell/nav.test.ts):
 *   dispatch, intake, daily-plan, messenger, support, reporting,
 *   equipment, financial, profile, location
 *
 * Expected HIDDEN (admin-only):
 *   approvals, inspection, kpi, ops, users, org, security
 */

const ADMIN_ONLY_ROUTES = ["/settings/users", "/approvals"] as const;

const HIDDEN_NAV_LABELS = [
  "승인",        // approvals
  "정기 예방정비", // inspection
  "KPI 대시보드", // kpi
  "운영 대시보드", // ops
  "사용자 관리",  // users
  "지역·지점 관리", // org
  "보안 설정",   // security
] as const;

const VISIBLE_NAV_LABELS = [
  "배차",        // dispatch
  "접수",        // intake
  "계획업무",    // daily-plan
  "메신저",      // messenger
  "고객지원",    // support
  "보고서 출력", // reporting
  "장비 조회",   // equipment
  "내 프로필",   // profile
  "GPS 위치 동의", // location
] as const;

test("MECH-NEG admin-only nav items are hidden for MECHANIC", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // Visible nav items should appear in the shell nav.
  for (const label of VISIBLE_NAV_LABELS) {
    await expect(page.getByRole("link", { name: label }).first()).toBeVisible({
      timeout: 5_000,
    });
  }

  // Admin-only nav items must NOT be present in the nav.
  for (const label of HIDDEN_NAV_LABELS) {
    await expect(
      page.getByRole("link", { name: label }).first(),
    ).not.toBeVisible();
  }
});

test("MECH-NEG direct visit to /approvals redirects away from admin route", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // /approvals is gated by RequireAdminRoute → redirects to /dispatch.
  await page.goto("/approvals");
  // The app should NOT stay on /approvals; it redirects to /dispatch.
  await expect(page).not.toHaveURL(/\/approvals/, { timeout: 8_000 });
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 8_000 });
});

test("MECH-NEG direct visit to /settings/users redirects away from admin route", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // /settings/users is gated by RequireAdminRoute → redirects to /dispatch.
  await page.goto("/settings/users");
  await expect(page).not.toHaveURL(/\/settings\/users/, { timeout: 8_000 });
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 8_000 });
});
