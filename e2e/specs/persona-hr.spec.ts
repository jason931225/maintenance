import { randomUUID } from "node:crypto";

import {
  test,
  expect,
  loginAsLanding,
  querySql,
  resetRateLimits,
  sql,
  TENANT_BRANCH_ID,
  TENANT_ORG_ID,
} from "../fixtures/roles";
import { assertNoAxeViolations, assertNoRawI18nKeys, navigateByHref } from "../fixtures/ux";

/**
 * PERSONA-HR — HR 담당(design mirror 김성아), ROADMAP.md §8 row 1.
 *
 * Design mirror top workflow: 채용 파이프라인→입사확정→근로계약(수신함 passkey)
 * →온보딩 체크→인사카드 · 예외: 무단결근 소명·촉진 발송.
 *
 * Real-app coverage (throwaway-PG harness, real WebAuthn SUPER_ADMIN session
 * — /hr/* routes are RequireEmployeeDirectoryRoute-gated and the seeded
 * ADMIN test user does not hold employee_directory_read; SUPER_ADMIN does,
 * matching admin-24-hr-core.spec.ts / hr-30-absence-exit-settlement.spec.ts):
 *   (1) 인사카드 — employee directory read (/settings/employees), 1 click from
 *       the authenticated landing route.
 *   (2) 무단결근 소명 — an absence alert surfaces an exit-case report + HR
 *       confirmation on /hr/insurance (G009), SQL-verified.
 *
 * Frictions recorded as test.fixme (see bottom):
 *   - 촉진 발송 (leave promotion) is UNREACHABLE for every role right now: the
 *     Cedar policy set has no rule for the console.leave.* action namespace,
 *     so every PolicyGated leave-console section (self/queue/promotion/
 *     ledger) denies-by-omission for SUPER_ADMIN too, even though the data
 *     layer (GET /api/v1/leave/balances|requests) is fully real-wired. See the
 *     fixme for the live POST /api/v1/policy/authorize/bulk evidence.
 *   - 채용 파이프라인→입사확정→근로계약(수신함 passkey) has NO route in
 *     AppRouter.tsx as of 2026-07-10 (grep for recruit/Posting/Applicant
 *     returns zero hits) — the ROADMAP's ontology (§2) promises them but the
 *     console module registry (web/src/console/modules/moduleScreens.ts
 *     MOD_SCREENS) only wires `finance` and `asset`, and the /console/*
 *     carbon-copy shell (web/src/console/shell/ConsoleShell.tsx) still
 *     renders an empty P0.1 screen-body canvas — no HR/recruit screen
 *     composes in yet.
 */

const ORG_ID = TENANT_ORG_ID;
const SOURCE_FILENAME = "e2e-persona-hr.xlsx";

const promoEmployeeId = randomUUID();
const promoEmployeeName = `e2e 촉진대상 ${promoEmployeeId.slice(0, 8)}`;

const alertId = randomUUID();
const absenceEmployeeId = randomUUID();
const absenceEmployeeName = `e2e 결근대상 ${absenceEmployeeId.slice(0, 8)}`;
const workDate = "2026-07-01";

/** SUPER_ADMIN test user (roles.ts ROLE_CONFIG) — a real FK target for requester_user_id. */
const REQUESTER_USER_ID = "00000000-0000-0000-0000-0000000d0005";

function seedPromotionTarget(): void {
  // balance_tone (backend/crates/leave/adapter-postgres/src/lib.rs): grant>0 &&
  // used/grant < 0.5 => Promote. 15 accrued / 5 used qualifies (5/15 = 0.33).
  // The "1차 발송" button additionally requires a REAL linked leave_requests row
  // (promotionCandidate in LeaveConsole.tsx — the backend only ever pushes a
  // statutory notice to a requester_user_id it can re-verify against a real
  // filed request, never a guessed employee->account mapping).
  sql(`
    BEGIN;
    SELECT set_config('app.current_org', '${ORG_ID}', true);
    DELETE FROM leave_requests
      WHERE subject_employee_id IN (
        SELECT id FROM employees
        WHERE org_id = '${ORG_ID}' AND source_filename = '${SOURCE_FILENAME}'
      );
    DELETE FROM employees
      WHERE org_id = '${ORG_ID}' AND source_filename = '${SOURCE_FILENAME}';
    INSERT INTO employees (
      id, org_id, company, name, source_filename, source_sheet, source_row,
      source_key, hire_date, employment_status,
      leave_accrued, leave_used, leave_remaining
    ) VALUES (
      '${promoEmployeeId}', '${ORG_ID}', 'KNL', '${promoEmployeeName}',
      '${SOURCE_FILENAME}', 'e2e', 1, 'e2e-persona-hr-${promoEmployeeId}',
      '2022-01-02', 'ACTIVE', 15, 5, 10
    );
    INSERT INTO leave_requests (
      id, org_id, branch_id, requester_user_id, subject_employee_id,
      leave_type, days, start_date, end_date, reason, status
    ) VALUES (
      gen_random_uuid(), '${ORG_ID}', '${TENANT_BRANCH_ID}', '${REQUESTER_USER_ID}',
      '${promoEmployeeId}', 'annual', 1, '2026-08-01', '2026-08-01',
      'E2E persona 촉진 대상 연차 신청', 'pending'
    );
    COMMIT;
  `);
}

function seedAbsenceAlert(): void {
  sql(`
    BEGIN;
    SELECT set_config('app.current_org', '${ORG_ID}', true);
    DELETE FROM employee_absence_alerts WHERE id = '${alertId}';
    DELETE FROM employees WHERE id = '${absenceEmployeeId}';
    INSERT INTO employees (
      id, org_id, company, name,
      source_filename, source_sheet, source_row, source_key,
      hire_date, employment_status, identity_review_required
    ) VALUES (
      '${absenceEmployeeId}', '${ORG_ID}', 'KNL', '${absenceEmployeeName}',
      '${SOURCE_FILENAME}', 'e2e', 2, 'e2e-persona-hr-absence-${absenceEmployeeId}',
      '2020-01-02', 'ACTIVE', false
    );
    INSERT INTO employee_absence_alerts (
      id, org_id, employee_id, work_date, status, source, severity
    ) VALUES (
      '${alertId}', '${ORG_ID}', '${absenceEmployeeId}', '${workDate}',
      'OPEN', 'manual', 'WARNING'
    );
    COMMIT;
  `);
}

test.beforeEach(() => {
  resetRateLimits();
  seedPromotionTarget();
  seedAbsenceAlert();
});

test("PERSONA-HR 인사카드 열람 — 1 click from landing", async ({ page }) => {
  await loginAsLanding(page, "SUPER_ADMIN");

  // click 1/1: nav → employee directory.
  await navigateByHref(page, "/settings/employees");
  await expect(
    page.getByRole("heading", { name: "인사·조직 관리", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(promoEmployeeName).first()).toBeVisible({
    timeout: 10_000,
  });
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "employee directory (인사카드)" });
});

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): EVERY console.leave.* PolicyGated
  // section (본인/팀장/HR전담/관리자 — self, queue, promotion, ledger — i.e.
  // ALL of LeaveConsole below the stats bar) is invisible for EVERY role,
  // including SUPER_ADMIN, right now. Root cause confirmed live: seed a
  // qualifying employee (grant 15/used 5 → tone=promote, GET /api/v1/leave/
  // balances confirmed 200 with the right row) + a linked leave_requests row,
  // then load /hr/leave-management as SUPER_ADMIN — GET /api/v1/employees,
  // GET /api/v1/leave/balances, GET /api/v1/leave/requests ALL return 200 with
  // correct data (data layer is fully real-wired, verdict-R1), but
  // POST /api/v1/policy/authorize/bulk denies EVERY console.leave.* action
  // with reason "action \"console.leave.X\" is not authorizable;
  // deny-by-omission" for all 8 actions (selfView/requestCreate/queueView/
  // requestDecide/promotionView/promotionManage/ledgerView/objectRead) — the
  // Cedar policy set has no rule registered for this action namespace at all,
  // so BulkPolicyGateProvider (web/src/pages/LeaveManagementPage.tsx) denies
  // by omission for every principal, not just non-privileged ones. The design
  // mirror's own claim ("leave 촉진 도달 3클릭 내") is therefore FALSE against
  // the real app as of 2026-07-10: the ROADMAP's ✓-audit only reflects the
  // OLD client-state-only mock (main branch feat/cedar-activation), not this
  // worktree's newer verdict-R1 real-wired LeaveConsole. Fix lane: register
  // Cedar policies for the console.leave.* action namespace (mirror the
  // console.hr.*/console.dispatch.* policies that DO authorize, since
  // /settings/employees and /hr/insurance both render fine for SUPER_ADMIN in
  // this same spec file).
  "PERSONA-HR 촉진 발송 reached in 3 clicks: nav → filter → 1차 발송 (Cedar console.leave.* 미등록 — deny-by-omission)",
  async () => {},
);

test("PERSONA-HR 무단결근 소명 — absence alert → exit case → HR confirm (SQL-verified)", async ({
  page,
}) => {
  await loginAsLanding(page, "SUPER_ADMIN");
  await navigateByHref(page, "/hr/insurance");
  await expect(
    page.getByRole("heading", { name: "보험신고 지원", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });

  const alertItem = page.getByRole("listitem").filter({ hasText: absenceEmployeeName });
  await expect(alertItem).toBeVisible({ timeout: 10_000 });
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "insurance-assist (absence alert)" });

  await alertItem.getByRole("button", { name: "퇴사 확인 케이스 생성" }).click();
  await expect(page.getByText("퇴사 확인 케이스를 생성했습니다.")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "사업장 HR 확인" }).click();
  await expect(
    page.getByText("퇴사 확인과 정산 패키지 생성을 반영했습니다."),
  ).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(
      () =>
        querySql<{ status: string; hr_confirmed_by: string | null }>(`
          SELECT ec.status, ec.hr_confirmed_by
          FROM employee_exit_cases ec
          WHERE ec.org_id = '${ORG_ID}' AND ec.employee_id = '${absenceEmployeeId}'
          ORDER BY ec.created_at DESC
          LIMIT 1
        `)[0] ?? null,
      { message: "exit case HR confirmation should commit", timeout: 10_000 },
    )
    .toEqual({ status: "HR_CONFIRMED", hr_confirmed_by: expect.any(String) });
});

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): no /recruit route exists (grep
  // AppRouter.tsx + web/src/pages for recruit/Posting/Applicant = zero hits,
  // 2026-07-10); MOD_SCREENS (web/src/console/modules/moduleScreens.ts) only
  // wires finance/asset, and ConsoleShell's screen body is still an empty
  // P0.1 canvas (no HR/recruit screen composes in). ROADMAP §2 ontology
  // promises Posting→Applicant→Employee but §8's "채용 파이프라인→입사확정→
  // 근로계약(수신함 passkey)" has no real UI to drive. Fix lane: build the
  // recruit pipeline surface + hire-confirm + contract-passkey inbox delivery.
  "PERSONA-HR 채용 파이프라인 → 입사확정 → 근로계약(수신함 passkey) 수령",
  async () => {},
);
