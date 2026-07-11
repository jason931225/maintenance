import { test, expect, querySql, resetRateLimits, sql } from "../fixtures/roles";
import { assertNoAxeViolations, assertNoRawI18nKeys } from "../fixtures/ux";

/**
 * PERSONA-FORKLIFT-DRIVER — 지게차 기사/현장직(모바일, design mirror 김성호),
 * ROADMAP.md §8 row 3.
 *
 * Design mirror top workflow: 출근 체크→WO- 수신→작업일지(JL-)→연장근로 AP-→
 * 본인 급여·수신함.
 *
 * Real-app coverage (throwaway-PG harness, real WebAuthn MECHANIC session):
 *   WO- 수신 = the MECHANIC's login lands directly on /dispatch with the
 *   assigned work order already in view — this IS "내 업무=배정 WO- 행"
 *   (ROADMAP 2026-07-09 v7 note). 작업일지(JL-) = the work-start + work-report
 *   flow (mech-05/06 already prove the individual transitions; this spec
 *   scripts them as ONE persona journey and adds the SQL proof that the report
 *   fields — the actual journal content — persisted).
 *
 * Frictions recorded as test.fixme: 출근 체크인 UI, 연장근로 AP- 신청, 본인
 * 급여·수신함 열람 have no real UI (see each fixme for grep evidence).
 */

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const WO_START_ID = "00000000-0000-0000-0000-000000f00003";
const WO_REPORT_ID = "00000000-0000-0000-0000-000000f00004";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";

function resetStartWo() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE work_orders SET status = 'ASSIGNED' WHERE id = '${WO_START_ID}';
     INSERT INTO work_order_assignments (id, work_order_id, mechanic_id, role, assigned_at, org_id)
     VALUES ('00000000-0000-0000-0000-000000a00001', '${WO_START_ID}', '${MECH_ID}', 'PRIMARY', now(), '${ORG_ID}')
     ON CONFLICT (id) DO NOTHING;
     COMMIT;`,
  );
}

function resetReportWo() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE work_orders
       SET status = 'IN_PROGRESS', result_type = 'UNKNOWN',
           diagnosis = NULL, action_taken = NULL,
           report_submitted_by = NULL, report_submitted_at = NULL
     WHERE id = '${WO_REPORT_ID}';
     INSERT INTO work_order_assignments (id, work_order_id, mechanic_id, role, assigned_at, org_id)
     VALUES ('00000000-0000-0000-0000-000000a00002', '${WO_REPORT_ID}', '${MECH_ID}', 'PRIMARY', now(), '${ORG_ID}')
     ON CONFLICT (id) DO NOTHING;
     -- Keep WO-013 ASSIGNED so it does not also show a "작업 보고" button.
     UPDATE work_orders SET status = 'ASSIGNED' WHERE id = '${WO_START_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetRateLimits();
  resetStartWo();
  resetReportWo();
});

test("PERSONA-FORKLIFT-DRIVER WO- 수신(내 업무) → 작업 시작 → 작업일지(JL-) 등재, SQL-verified", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  // WO- 수신: landing directly on /dispatch with the assigned order already
  // rendered IS the "내 업무" row — zero extra navigation clicks needed.
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "dispatch board (내 업무 / WO- 수신)" });

  // Scope every action to the specific -013/-014 row so a THIRD work order
  // sharing this mechanic's action panel (e.g. persona-dispatcher's WO- also
  // gets assigned to this mechanic in the same DB session) can never make a
  // bare "작업 시작"/"작업 보고" lookup ambiguous. Row container is a plain
  // <div class="...border-line..."> per WorkOrderActions.tsx (key={wo.id}) —
  // NOT an <article> (DispatchBoard's own board cards use <article> instead).
  const startCard = page.locator("div.border-line").filter({ hasText: "-013" });
  const reportCard = page.locator("div.border-line").filter({ hasText: "-014" });

  // click 1: 작업 시작 (ASSIGNED → IN_PROGRESS) on WO-013.
  const startBtn = startCard.getByRole("button", { name: /^작업 시작$/ });
  await expect(startBtn).toBeVisible({ timeout: 8_000 });
  await startBtn.click();
  await expect(page.getByText(/작업을 시작했습니다\./).first()).toBeVisible({
    timeout: 10_000,
  });

  await expect
    .poll(
      () =>
        querySql<{ status: string }>(
          `SELECT status FROM work_orders WHERE id = '${WO_START_ID}'`,
        )[0]?.status ?? null,
      { message: "work start should commit", timeout: 8_000 },
    )
    .toBe("IN_PROGRESS");

  // click 2: open the report form on the IN_PROGRESS WO-014
  // (작업일지/JL- entry point — the report IS the journal record).
  const reportOpenBtn = reportCard.getByRole("button", { name: /^작업 보고$/ });
  await expect(reportOpenBtn).toBeVisible({ timeout: 8_000 });
  await reportOpenBtn.click();

  // The inline form itself renders at PANEL level (WorkOrderActions.tsx: a
  // sibling after the rows list, not nested inside the row), so once opened
  // there is only ONE such form on the page — page-level locators are
  // unambiguous here even though the row lookups above had to be scoped.
  await page.getByRole("combobox", { name: /작업 결과/ }).selectOption("COMPLETED");
  await page
    .getByRole("textbox", { name: /진단 내용/ })
    .fill("E2E persona 배터리 완전 방전으로 충전 필요");
  await page
    .getByRole("textbox", { name: /조치 내용/ })
    .fill("E2E persona 충전기 연결 후 완전 충전 완료");

  // click 3: submit the journal entry. The panel-level form's submit button
  // is the LAST "작업 보고" match on the page (earlier matches are per-row
  // open buttons, e.g. WO-014's own — mech-06's documented pattern).
  await page.getByRole("button", { name: /^작업 보고$/ }).last().click();
  await expect(
    page.getByText(/작업 보고를 제출했습니다\./).first(),
  ).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(
      () =>
        querySql<{
          status: string;
          diagnosis: string | null;
          action_taken: string | null;
          report_submitted_by: string | null;
        }>(`
          SELECT status, diagnosis, action_taken, report_submitted_by
          FROM work_orders WHERE id = '${WO_REPORT_ID}'
        `)[0] ?? null,
      { message: "journal (work report) should persist", timeout: 8_000 },
    )
    .toEqual({
      status: "REPORT_SUBMITTED",
      diagnosis: "E2E persona 배터리 완전 방전으로 충전 필요",
      action_taken: "E2E persona 충전기 연결 후 완전 충전 완료",
      report_submitted_by: MECH_ID,
    });
});

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): ROADMAP.md §8 itself flags this —
  // "잔여: 출근 체크인 UI(백엔드성)" (2026-07-09 audit note). site_attendance_events
  // rows (ARRIVAL/DEPARTURE) exist only as backend facts today; every e2e spec
  // that needs one seeds it directly via SQL (see admin-24-hr-core.spec.ts) —
  // there is no button/form anywhere in web/src for a mechanic to check in.
  // Fix lane: ship the check-in UI the ROADMAP note names as remaining.
  "PERSONA-FORKLIFT-DRIVER 출근 체크인 (모바일 UI)",
  async () => {},
);

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): no overtime-request UI exists — grep
  // for 연장근로|초과근무|overtime across web/src (excluding tests) returns
  // zero hits, 2026-07-10. ROADMAP §8 promises "연장근로 AP-" as part of this
  // persona's daily flow; there is no approval-template or form to drive.
  // Fix lane: add a 연장근로 AP- request template (mirrors the existing
  // annual-leave AP- template at /approvals?template=annual-leave).
  "PERSONA-FORKLIFT-DRIVER 연장근로 AP- 신청",
  async () => {},
);

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): no payslip/own-payroll-view UI exists
  // for a MECHANIC — grep for 명세서|Payslip|payslip across web/src (excluding
  // tests) returns zero hits, 2026-07-10. PayrollPage is ADMIN/EXECUTIVE/
  // SUPER_ADMIN-gated (RequireEmployeeDirectoryRoute) and shows org-wide
  // readiness, not a self-service payslip. Fix lane: an owner-scoped 수신함
  // (inbox) payslip surface, per ROADMAP's "본인 명세 PS- (owner scope)" note.
  "PERSONA-FORKLIFT-DRIVER 본인 급여 명세·수신함 열람",
  async () => {},
);
