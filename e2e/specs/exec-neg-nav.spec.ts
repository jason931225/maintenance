import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * EXECUTIVE NEGATIVE — the manager/admin-only surfaces are hidden from the
 * executive's nav AND unreachable by direct URL.
 *
 * Expected VISIBLE for EXECUTIVE (web/src/components/shell/nav.test.ts):
 *   dispatch, intake, messenger, support, kpi, reporting, equipment, financial,
 *   profile, location
 *
 * Expected HIDDEN:
 *   approvals, daily-plan, inspection, ops, users, org, security
 *
 * Direct-URL: approvals/inspection/ops/users/org/security are under
 * RequireAdminRoute; daily-plan is under RequireDailyPlanRoute (DailyPlanRequest
 * is `[D, A, A, D, A]` — executive denied). All redirect away to /dispatch — the
 * page is never rendered, matching the hidden-nav contract.
 */

const VISIBLE_NAV_LABELS = [
  "배차", // dispatch
  "접수", // intake
  "메신저", // messenger
  "고객지원", // support
  "KPI 대시보드", // kpi (executive HAS KpiRead)
  "보고서 출력", // reporting
  "장비 조회", // equipment
  "구매·정산", // financial
  "내 프로필", // profile
  "GPS 위치 동의", // location
] as const;

const HIDDEN_NAV_LABELS = [
  "승인", // approvals
  "계획업무", // daily-plan
  "정기 예방정비", // inspection
  "운영 대시보드", // ops
  "사용자 관리", // users
  "지역·지점 관리", // org
  "보안 설정", // security
] as const;

/** Routes whose guard must bounce an executive back to /dispatch. */
const GUARDED_ROUTES = [
  "/approvals",
  "/daily-plan",
  "/inspection",
  "/ops",
  "/settings/users",
  "/settings/org",
  "/settings/security",
] as const;

test("EXEC-NEG manager/admin nav items are hidden for EXECUTIVE", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("EXECUTIVE");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  for (const label of VISIBLE_NAV_LABELS) {
    await expect(page.getByRole("link", { name: label }).first()).toBeVisible({
      timeout: 5_000,
    });
  }

  for (const label of HIDDEN_NAV_LABELS) {
    await expect(
      page.getByRole("link", { name: label }).first(),
    ).not.toBeVisible();
  }

  // The shell itself must be clean for the executive (a11y + i18n + console).
  await auditPage(page, { context: "/dispatch (executive shell)", consoleGuard });
});

for (const route of GUARDED_ROUTES) {
  test(`EXEC-NEG direct visit to ${route} bounces to /dispatch`, async ({
    page,
    loginAs,
  }) => {
    await loginAs("EXECUTIVE");
    await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

    await page.goto(route);
    // The guard redirects away; the executive lands back on /dispatch.
    await expect(page).not.toHaveURL(new RegExp(route.replace(/\//g, "\\/")), {
      timeout: 8_000,
    });
    await expect(page).toHaveURL(/\/dispatch/, { timeout: 8_000 });
  });
}
