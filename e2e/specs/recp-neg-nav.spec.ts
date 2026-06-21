import { test, expect } from "../fixtures/roles";

/**
 * RECEPTIONIST NEGATIVE — daily-plan (and the other manager/admin surfaces) are
 * hidden from the receptionist's nav, and a direct visit to /daily-plan is
 * bounced back to /dispatch.
 *
 * Expected VISIBLE for RECEPTIONIST (web/src/components/shell/nav.test.ts):
 *   dispatch, intake, messenger, support, reporting, equipment, financial,
 *   profile, location
 *
 * Expected HIDDEN (note: kpi is hidden too, unlike EXECUTIVE):
 *   approvals, daily-plan, inspection, ops, kpi, users, org, security
 *
 * daily-plan: DailyPlanRequest is `[D, A, A, D, A]` (receptionist denied), so the
 * route is gated by RequireDailyPlanRoute and bounces to /dispatch.
 */

const VISIBLE_NAV_LABELS = [
  "배차", // dispatch
  "접수", // intake
  "메신저", // messenger
  "고객지원", // support
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
  "KPI 대시보드", // kpi (receptionist has NO KpiRead)
  "사용자 관리", // users
  "지역·지점 관리", // org
  "보안 설정", // security
] as const;

test("RECP-NEG manager/admin nav items (incl. daily-plan, kpi) are hidden", async ({
  page,
  loginAs,
}) => {
  await loginAs("RECEPTIONIST");
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
});

test("RECP-NEG direct visit to /daily-plan bounces to /dispatch", async ({
  page,
  loginAs,
}) => {
  await loginAs("RECEPTIONIST");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // /daily-plan is gated by RequireDailyPlanRoute → redirects to /dispatch.
  await page.goto("/daily-plan");
  await expect(page).not.toHaveURL(/\/daily-plan/, { timeout: 8_000 });
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 8_000 });
});

test("RECP-NEG direct visit to /kpi bounces to /dispatch", async ({
  page,
  loginAs,
}) => {
  await loginAs("RECEPTIONIST");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // /kpi is gated by RequireKpiRoute (KpiRead is `[D, D, A, A, A]`) → redirect.
  await page.goto("/kpi");
  await expect(page).not.toHaveURL(/\/kpi/, { timeout: 8_000 });
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 8_000 });
});
