import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { test, expect, loginAsLanding, querySql, resetRateLimits, sql, TENANT_ORG_ID } from "../fixtures/roles";
import { assertNoAxeViolations, assertNoRawI18nKeys, navigateByHref } from "../fixtures/ux";

/**
 * Clear the current session before switching actors (mirrors
 * hr-30-absence-exit-settlement.spec.ts's loginAs helper) — otherwise the
 * still-live prior refresh cookie races the new OTP redemption and the
 * /login controls detach mid-ceremony.
 */
async function logout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Transport": "cookie" },
      credentials: "include",
      body: "{}",
    });
  });
}

/**
 * PERSONA-PAYROLL — 급여 담당, ROADMAP.md §8 row 5.
 *
 * Design mirror top workflow: 근태 마감 게이트→회차 생성(예약작업)→예외 검토
 * (공제·대근비)→이체 승인→명세 배포(수신함). "전담 페르소나 미분리" per
 * ROADMAP (same v1 note as the dispatcher row) — driven as ADMIN/EXECUTIVE,
 * the two directory-tier roles hr-30-absence-exit-settlement.spec.ts already
 * proves this exact G009 SoD chain with (that spec runs only under the
 * dev-auth Playwright project). This spec ports the SAME real flow to the
 * throwaway-PG harness's real-WebAuthn role fixture (roles.ts) so it runs
 * under the default E2E project, and adds the payroll-readiness read-through.
 *
 * Real-app coverage: exit-case report → HR confirm (ADMIN) → HQ confirm
 * (EXECUTIVE, a DISTINCT seeded user — the backend's separation-of-duties
 * rule) → wage-source entry + severance draft calc (급여 담당's actual
 * mutation) → PayrollPage read-only display of the uncertified draft.
 *
 * Frictions recorded as test.fixme: payroll-RUN creation (예약작업), exception
 * review, transfer approval, and payslip distribution have NO UI — PayrollPage
 * is a read-only readiness dashboard by design (check:payroll-release-gate
 * forbids mutation calls there), and no PayrollRun-creation surface exists
 * anywhere else in the app.
 */

const ORG_ID = TENANT_ORG_ID;
const employeeId = randomUUID();
const alertId = randomUUID();
const employeeName = `e2e persona 정산대상 ${employeeId.slice(0, 8)}`;
const workDate = "2026-06-15";

function seedAbsenceAlert(): void {
  sql(`
    BEGIN;
    SELECT set_config('app.current_org', '${ORG_ID}', true);
    INSERT INTO employees (
      id, org_id, company, name,
      source_filename, source_sheet, source_row, source_key,
      hire_date, employment_status, identity_review_required
    ) VALUES (
      '${employeeId}', '${ORG_ID}', 'KNL', '${employeeName}',
      'e2e-persona-payroll.xlsx', 'e2e', 1, 'e2e-persona-payroll-${employeeId}',
      '2020-01-02', 'ACTIVE', false
    );
    INSERT INTO employee_absence_alerts (
      id, org_id, employee_id, work_date, status, source, severity
    ) VALUES (
      '${alertId}', '${ORG_ID}', '${employeeId}', '${workDate}',
      'OPEN', 'manual', 'WARNING'
    );
    COMMIT;
  `);
}

test.beforeAll(() => {
  seedAbsenceAlert();
});

test.beforeEach(() => {
  resetRateLimits();
});

test("PERSONA-PAYROLL 근태 마감 예외(퇴직정산) — HR→HQ 확인(SoD) → 원천 입력 → 급여 준비 반영, SQL-verified", async ({
  page,
}) => {
  // ── SUPER_ADMIN: reports the exit case + HR-confirms. ────────────────────
  await loginAsLanding(page, "SUPER_ADMIN");
  await navigateByHref(page, "/hr/insurance");
  await expect(
    page.getByRole("heading", { name: "보험신고 지원", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });

  const alertItem = page.getByRole("listitem").filter({ hasText: employeeName });
  await expect(alertItem).toBeVisible({ timeout: 10_000 });
  await alertItem.getByRole("button", { name: "퇴사 확인 케이스 생성" }).click();
  await expect(page.getByText("퇴사 확인 케이스를 생성했습니다.")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "사업장 HR 확인" }).click();
  await expect(
    page.getByText("퇴사 확인과 정산 패키지 생성을 반영했습니다."),
  ).toBeVisible({ timeout: 15_000 });

  // ── EXECUTIVE: the DISTINCT HQ confirmer the backend's SoD rule requires. ──
  await logout(page);
  await loginAsLanding(page, "EXECUTIVE");
  await navigateByHref(page, "/hr/insurance");
  await expect(
    page.getByRole("heading", { name: "보험신고 지원", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });
  // Scoped to THIS run's case: employeeName alone is ambiguous (it also
  // matches the still-open absence-alert list item), and the org-wide
  // HQ-confirm queue can carry other pending cases left by sibling persona
  // specs in the same DB session — chain both filters to pin the one row
  // that both names this employee AND offers the HQ-confirm action.
  const hqCaseItem = page
    .getByRole("listitem")
    .filter({ hasText: employeeName })
    .filter({ hasText: "HQ HR 확인" });
  await expect(hqCaseItem).toBeVisible({ timeout: 15_000 });
  const hqConfirm = hqCaseItem.getByRole("button", { name: "HQ HR 확인" });
  await expect(hqConfirm).toBeVisible({ timeout: 15_000 });
  await hqConfirm.click();
  await expect(
    page.getByText("퇴사 확인과 정산 패키지 생성을 반영했습니다."),
  ).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(
      () =>
        querySql<{ status: string; hq_confirmed_by: string | null }>(`
          SELECT status, hq_confirmed_by FROM employee_exit_cases
          WHERE org_id = '${ORG_ID}' AND employee_id = '${employeeId}'
          ORDER BY created_at DESC LIMIT 1
        `)[0] ?? null,
      { message: "HQ confirmation should commit", timeout: 10_000 },
    )
    .toEqual({ status: "HQ_CONFIRMED", hq_confirmed_by: expect.any(String) });

  // ── SUPER_ADMIN (급여 담당's real mutation): wage-source entry drives the
  // statutory severance draft calc — PayrollPage itself forbids mutations. ──
  await logout(page);
  await loginAsLanding(page, "SUPER_ADMIN");
  await navigateByHref(page, "/hr/insurance");
  await expect(
    page.getByRole("heading", { name: "보험신고 지원", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });

  const confirmationSection = page
    .locator("section")
    .filter({ hasText: "퇴사 확인 및 상실신고 준비" })
    .last();
  const settlementItem = confirmationSection
    .getByRole("listitem")
    .filter({ hasText: employeeName });
  await expect(settlementItem).toBeVisible({ timeout: 10_000 });
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "insurance-assist (wage-source entry)" });

  await settlementItem.getByLabel("산정 시작일").fill("2026-03-01");
  await settlementItem.getByLabel("산정 종료일").fill("2026-05-31");
  await settlementItem.getByLabel("산정 역일수").fill("92");
  await settlementItem.getByLabel("산정 기간 임금총액(원)").fill("9200000");
  await settlementItem.getByLabel("월 통상임금(원)").fill("3050000");
  await settlementItem.getByRole("button", { name: "정산 초안 산출" }).click();
  await expect(page.getByText("퇴직금 정산 초안을 산출했습니다.")).toBeVisible({
    timeout: 15_000,
  });

  await expect
    .poll(
      () =>
        querySql<{ status: string; average_wage_calendar_days: number | null }>(`
          SELECT status, average_wage_calendar_days
          FROM employee_exit_settlement_packages
          WHERE org_id = '${ORG_ID}' AND employee_id = '${employeeId}'
        `)[0] ?? null,
      { message: "settlement draft should persist", timeout: 10_000 },
    )
    .toEqual({ status: "APPROVAL_DRAFTED", average_wage_calendar_days: 92 });

  // ── The severance draft renders READ-ONLY on the payroll readiness page —
  // this IS "근태 마감 게이트/급여 준비" reflecting the settlement. ──────────
  await navigateByHref(page, "/payroll");
  await expect(
    page.getByRole("heading", { name: "급여 준비", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("퇴직금·상실신고 정산")).toBeVisible();

  const settlementCard = page.locator("section").filter({ hasText: employeeName }).last();
  await expect(settlementCard).toBeVisible({ timeout: 10_000 });
  await expect(settlementCard.getByText("퇴직금 산출액", { exact: true })).toBeVisible();
  await expect(settlementCard.getByText("산정 초안 — 노무사 검증 전")).toBeVisible();
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "payroll (settlement draft, read-only)" });
});

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): payroll-RUN creation (회차 생성/
  // 예약작업) has no UI anywhere — grep for payroll_run|PayrollRun|payroll-run
  // across web/src (excluding tests) finds exactly ONE hit, a read-only status
  // label on EmployeesPage.tsx:497 ("readinessSummary.payroll.latest_status").
  // PayrollPage.tsx is READ-ONLY by design (check:payroll-release-gate forbids
  // mutation API calls there, per hr-30-absence-exit-settlement.spec.ts's own
  // header comment). Fix lane: a payroll-run creation + scheduling surface
  // (ROADMAP §8 names "회차 생성(예약작업)" — likely the `scheduled`
  // console-nav screen, web/src/console/shell/nav.ts, which is itself unwired).
  "PERSONA-PAYROLL 급여 회차 생성(예약작업)",
  async () => {},
);

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): no exception-review (공제·대근비),
  // transfer-approval, or payslip-distribution (수신함 배포) UI exists — same
  // read-only PayrollPage constraint as above; there is no mutation surface to
  // drive for any of these three steps. Fix lane: build the exception-review +
  // transfer-approval + inbox-distribution surfaces the ROADMAP names.
  "PERSONA-PAYROLL 예외 검토(공제·대근비) → 이체 승인 → 명세 배포(수신함)",
  async () => {},
);
