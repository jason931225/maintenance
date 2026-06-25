import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-19 — newly-wired console affordances whose backend endpoints existed but
 * had no UI: Start-P1 dispatch, outsource-work create, target-change review,
 * inspection-round complete, manual cost-ledger entry, and equipment .xlsx import.
 *
 * Prereqs (seed-admin.sql):
 *   - …f00010 (request_no -101): RECEIVED P1 work order with NO dispatch (Start P1)
 *   - …f00009 (request_no -091): RECEIVED P1 work order (outsource create)
 *   - …0cc001: REQUESTED target-change request on …f00009 (review approve)
 *   - …0ab001: SCHEDULED inspection schedule (the round test reassigns it to the
 *     SUPER_ADMIN it promotes to a 예방 MECHANIC, since /inspection is admin-gated)
 *   - …ee0003 (호기 E2E-001): equipment for the manual cost-ledger entry
 *
 * Per-test resets restore the seeded rows so the file is order-independent.
 */

const ORG_ID = TENANT_ORG_ID;
const BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";
const SADMIN_ID = "00000000-0000-0000-0000-0000000d0005";
const EQUIP_ID = "00000000-0000-0000-0000-000000ee0003";

const WO_START_P1 = "00000000-0000-0000-0000-000000f00010";
const WO_OUTSOURCE = "00000000-0000-0000-0000-000000f00009";
const TARGET_CHANGE_ID = "00000000-0000-0000-0000-0000000cc001";
const SCHEDULE_ID = "00000000-0000-0000-0000-0000000ab001";
const MANAGEMENT_NO = "E2E-001";

/** Select a work order on the board to open the manager controls panel. */
async function openControls(
  page: import("@playwright/test").Page,
  requestNoSuffix: string,
) {
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
  const selectBtn = page.getByRole("button", {
    name: new RegExp(`${requestNoSuffix} 배차 제어`),
  });
  await expect
    .poll(
      async () => {
        if (await selectBtn.isVisible()) return true;
        const retry = page.getByRole("button", { name: /다시 시도/ });
        if (await retry.isVisible()) await retry.click();
        return selectBtn.isVisible();
      },
      { timeout: 20_000, intervals: [500, 1000, 1500] },
    )
    .toBe(true);
  await selectBtn.click();
  await expect(
    page.getByRole("heading", {
      name: new RegExp(`배차 제어 · .*${requestNoSuffix}`),
    }),
  ).toBeVisible({ timeout: 8_000 });
}

test("ADMIN-19 admin starts a P1 emergency dispatch from the controls panel", async ({
  page,
  loginAs,
}) => {
  // Clear any dispatch a prior run started for …f00010 so RECEIVED+P1 has none.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM p1_dispatch_targets WHERE dispatch_id IN (
       SELECT id FROM p1_dispatches WHERE work_order_id = '${WO_START_P1}'
     );
     DELETE FROM p1_dispatches WHERE work_order_id = '${WO_START_P1}';
     UPDATE work_orders SET status = 'RECEIVED', priority = 'P1'
       WHERE id = '${WO_START_P1}';
     COMMIT;`,
  );

  await loginAs("ADMIN");
  await openControls(page, "-101");

  await page.getByRole("button", { name: "P1 배차 시작", exact: true }).click();
  await expect(page.getByText(/P1 긴급 배차를 시작했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
});

test("ADMIN-19 admin creates an outsource work for a work order", async ({
  page,
  loginAs,
}) => {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM outsource_works WHERE vendor_id IN (
       SELECT id FROM outsource_vendors WHERE name = 'E2E외주처'
     );
     DELETE FROM outsource_vendors WHERE name = 'E2E외주처';
     COMMIT;`,
  );

  await loginAs("ADMIN");
  await openControls(page, "-091");

  await page
    .getByLabel("외주처명", { exact: true })
    .fill("E2E외주처");
  await page.getByLabel("외주처 연락처").fill("010-1234-5678");
  await page.getByLabel("작업 사유").fill("E2E 외주 작업 사유");
  await page
    .getByRole("button", { name: "외주 작업 등록", exact: true })
    .click();

  await expect(page.getByText(/외주 작업을 등록했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
});

test("ADMIN-19 admin approves a target due-date change request by id", async ({
  page,
  loginAs,
}) => {
  // Restore the request to REQUESTED so an earlier approve doesn't 409 it.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     INSERT INTO target_change_requests (
       id, work_order_id, requested_by, requested_target_due_at, reason,
       status, reviewed_by, reviewed_at, review_memo, org_id
     ) VALUES (
       '${TARGET_CHANGE_ID}', '${WO_OUTSOURCE}', '${ADMIN_ID}',
       now() + interval '7 days', 'E2E 일정 변경 검토 대상',
       'REQUESTED', NULL, NULL, NULL, '${ORG_ID}'
     )
     ON CONFLICT (id) DO UPDATE
       SET work_order_id = EXCLUDED.work_order_id,
           requested_by = EXCLUDED.requested_by,
           requested_target_due_at = EXCLUDED.requested_target_due_at,
           reason = EXCLUDED.reason,
           status = 'REQUESTED',
           reviewed_by = NULL,
           reviewed_at = NULL,
           review_memo = NULL,
           org_id = EXCLUDED.org_id;
     COMMIT;`,
  );

  await loginAs("ADMIN");
  await page.goto("/approvals");
  await expect(
    page.getByRole("heading", { name: /승인 대기/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  // Confirm the page's initial protected read succeeded by waiting for a seeded
  // approval-queue work order (request_no …-071). The first on-load read can race
  // the single-flight 401→refresh and error out; if so, retry the page read until
  // the work order appears, so the later review POST runs with a warm token.
  const seededWo = page.getByText(/-071\b/).first();
  await expect
    .poll(
      async () => {
        if (await seededWo.isVisible()) return true;
        const retry = page.getByRole("button", { name: /다시 시도/ });
        if (await retry.isVisible()) await retry.click();
        return seededWo.isVisible();
      },
      { timeout: 20_000, intervals: [500, 1000, 1500] },
    )
    .toBe(true);

  // The review queue renders below the work-order queue; wait for its input.
  const reviewInput = page.locator("#target-change-request-id");
  await expect(reviewInput).toBeVisible({ timeout: 8_000 });
  await reviewInput.fill(TARGET_CHANGE_ID);
  const reviewMemo = page.locator("#target-change-memo");
  await reviewMemo.fill("E2E 승인 메모");
  await reviewMemo.press("Tab");
  await page.keyboard.press("Enter");

  await expect(page.getByText(/일정 변경 요청을 승인했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
});

test("ADMIN-19 admin completes a scheduled inspection round", async ({
  page,
  loginAs,
}) => {
  // The /inspection page is admin-gated, and the round adapter requires the
  // actor to be the schedule's assigned mechanic AND an active 예방 MECHANIC in
  // the branch. The SUPER_ADMIN login fixture satisfies the route guard; grant
  // it the MECHANIC role + 예방 team and assign the schedule to it so the wired
  // "점검 완료" action drives the real endpoint. Restore role/team after.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE users SET team = '예방', roles = ARRAY['SUPER_ADMIN','MECHANIC']
       WHERE id = '${SADMIN_ID}';
     INSERT INTO user_branches (user_id, branch_id, org_id)
       VALUES ('${SADMIN_ID}', '${BRANCH_ID}', '${ORG_ID}')
       ON CONFLICT (user_id, branch_id) DO NOTHING;
     DELETE FROM inspection_rounds WHERE schedule_id = '${SCHEDULE_ID}';
     UPDATE regular_inspection_schedules
       SET status = 'SCHEDULED', completed_at = NULL, completed_by = NULL,
           mechanic_id = '${SADMIN_ID}', due_date = CURRENT_DATE
     WHERE id = '${SCHEDULE_ID}';
     COMMIT;`,
  );

  try {
    await loginAs("SUPER_ADMIN");
    await page.goto("/inspection");
    await expect(
      page.getByRole("heading", { name: /정기 예방정비/, level: 1 }),
    ).toBeVisible({ timeout: 8_000 });

    // Widen the date range so the seeded schedule is included regardless of the
    // exact server CURRENT_DATE vs Seoul-today boundary, then re-query with a warm
    // token (the initial on-mount read can race the first 401→refresh cycle).
    const start = new Date();
    start.setDate(start.getDate() - 7);
    const end = new Date();
    end.setDate(end.getDate() + 30);
    await page.locator("#inspection-range-start").fill(start.toISOString().slice(0, 10));
    await page.locator("#inspection-range-end").fill(end.toISOString().slice(0, 10));
    await page.getByRole("button", { name: /일정 조회/ }).click();

    // The seeded schedule's complete-round button carries a per-row aria-label;
    // wait for it before opening the inline form.
    const completeBtn = page
      .getByRole("button", { name: /점검 완료/ })
      .first();
    await expect(completeBtn).toBeVisible({ timeout: 10_000 });
    await completeBtn.click();
    await page
      .locator(`#round-findings-${SCHEDULE_ID}`)
      .fill("E2E 점검 정상 완료");
    await page.getByRole("button", { name: "완료 처리", exact: true }).click();

    await expect(
      page.getByText(/정기 점검 라운드를 완료 처리했습니다\./),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    // Restore the SUPER_ADMIN's role/team so other specs see the seeded shape.
    sql(
      `BEGIN;
       SELECT set_config('app.current_org', '${ORG_ID}', true);
       UPDATE users SET team = NULL, roles = ARRAY['SUPER_ADMIN']
         WHERE id = '${SADMIN_ID}';
       COMMIT;`,
    );
  }
});

test("ADMIN-19 admin appends a manual cost-ledger entry", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/financial");
  await page.getByRole("tab", { name: "원가 원장" }).click();
  await expect(
    page.getByRole("heading", { name: /장비 원가·비용 원장/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Resolve the equipment via the shared selector.
  await page.locator("#financial-equipment-lookup").fill(MANAGEMENT_NO);
  await page.getByRole("button", { name: /^호기 번호$/ }).click();
  await expect(page.getByText(/선택된 장비/).first()).toBeVisible({
    timeout: 8_000,
  });

  await page.locator("#cost-ledger-manual-amount").fill("250000");
  await page.locator("#cost-ledger-manual-memo").fill("E2E 수기 비용");
  await page.getByRole("button", { name: "항목 등록", exact: true }).click();

  await expect(page.getByText(/수기 비용 항목을 등록했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
  // The new entry's memo renders in the refreshed ledger list.
  await expect(page.getByText("E2E 수기 비용")).toBeVisible({ timeout: 8_000 });

  // Clean up so repeated runs don't accumulate manual rows.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM equipment_cost_ledger
       WHERE equipment_id = '${EQUIP_ID}' AND memo = 'E2E 수기 비용';
     COMMIT;`,
  );
});

test("ADMIN-19 admin imports an equipment master-list .xlsx", async ({
  page,
  loginAs,
}) => {
  await loginAs("SUPER_ADMIN");
  await page.goto("/equipment/legacy");
  await expect(
    page.getByRole("heading", { name: /장비 마스터 일괄 등록/ }),
  ).toBeVisible({ timeout: 8_000 });

  // A non-xlsx payload exercises the wired multipart upload + error surfacing
  // without depending on a binary fixture: the backend rejects it and the panel
  // renders the failure message (the control is reachable and posts the file).
  await page
    .locator("#equipment-import-file")
    .setInputFiles({
      name: "not-a-workbook.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("not a real xlsx workbook"),
    });
  await page.getByRole("button", { name: /업로드/ }).click();

  await expect(
    page.getByText(/마스터 워크북을 등록하지 못했습니다\./),
  ).toBeVisible({ timeout: 10_000 });
});
