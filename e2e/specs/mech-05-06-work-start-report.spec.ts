import { test, expect, sql } from "../fixtures/roles";

/**
 * MECH-05 — mechanic starts a work order (ASSIGNED → IN_PROGRESS).
 * MECH-06 — mechanic submits a work report (IN_PROGRESS → REPORT_SUBMITTED).
 *
 * Seeded rows:
 *   - …f00003 ASSIGNED (primary: mechanic) — for MECH-05
 *   - …f00004 IN_PROGRESS (primary: mechanic) — for MECH-06
 *
 * Per-test resets restore these rows so specs are order-independent.
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
     -- Restore the MECH-05 start order to ASSIGNED so it does NOT show a
     -- "작업 보고" button — otherwise a prior MECH-05 run that left it IN_PROGRESS
     -- makes WO-014 ambiguous (two report buttons). This keeps WO-014 the only
     -- IN_PROGRESS order, so the report form acts on it.
     UPDATE work_orders SET status = 'ASSIGNED' WHERE id = '${WO_START_ID}';
     COMMIT;`,
  );
}

test("MECH-05 mechanic starts an ASSIGNED work order", async ({
  page,
  loginAs,
}) => {
  resetStartWo();
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // The WorkOrderActions panel renders "작업 시작" for ASSIGNED orders.
  // The card heading includes both action names.
  await expect(page.getByText(/작업 시작/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Click the 작업 시작 button for the ASSIGNED work order (…-013 suffix).
  const startBtn = page
    .getByRole("button", { name: /작업 시작/ })
    .first();
  await expect(startBtn).toBeVisible();
  await startBtn.click();

  // Success message confirms the state transition.
  await expect(
    page.getByText(/작업을 시작했습니다\./).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("MECH-06 mechanic submits a work report for an IN_PROGRESS work order", async ({
  page,
  loginAs,
}) => {
  resetReportWo();
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // Click the 작업 보고 button for the IN_PROGRESS work order.
  const reportBtn = page
    .getByRole("button", { name: /작업 보고/ })
    .first();
  await expect(reportBtn).toBeVisible({ timeout: 8_000 });
  await reportBtn.click();

  // The inline report form opens.
  await expect(page.getByRole("combobox", { name: /작업 결과/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /진단 내용/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /조치 내용/ })).toBeVisible();

  // Fill the form.
  await page.getByRole("combobox", { name: /작업 결과/ }).selectOption("COMPLETED");
  await page
    .getByRole("textbox", { name: /진단 내용/ })
    .fill("배터리 완전 방전으로 충전 필요");
  await page
    .getByRole("textbox", { name: /조치 내용/ })
    .fill("충전기 연결 후 완전 충전 완료");

  // Submit. The inline report form renders below the card rows, so its submit
  // button is the LAST "작업 보고" button in the DOM (the earlier matches are the
  // card-row buttons that open the form).
  await page.getByRole("button", { name: /^작업 보고$/ }).last().click();

  // Success message.
  await expect(
    page.getByText(/작업 보고를 제출했습니다\./).first(),
  ).toBeVisible({ timeout: 10_000 });
});
