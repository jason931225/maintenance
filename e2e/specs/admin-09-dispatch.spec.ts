import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-09 — admin dispatch controls: set priority, request schedule change,
 * multi-mechanic assign, and force-assign an escalated P1 dispatch.
 *
 * seed-admin.sql seeds a RECEIVED P1 work order (…f00009, request_no -091) with a
 * BROADCASTING dispatch (…d10003) targeting the mechanic, plus a second MECHANIC
 * (…d0006) so the multi-assign control has two candidates.
 *
 * The controls panel is manager-only and renders only after a work order is
 * selected on the board. Per-test resets restore the seeded rows.
 */

const ORG_ID = TENANT_ORG_ID;
const WO_ID = "00000000-0000-0000-0000-000000f00009";
const DISPATCH_ID = "00000000-0000-0000-0000-000000d10003";
const BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";

function resetDispatchWo() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM work_order_assignments WHERE work_order_id = '${WO_ID}';
     DELETE FROM target_change_requests WHERE work_order_id = '${WO_ID}';
     UPDATE work_orders SET status = 'RECEIVED', priority = 'P1', target_due_at = NULL
       WHERE id = '${WO_ID}';
     DELETE FROM p1_dispatch_targets WHERE dispatch_id = '${DISPATCH_ID}';
     DELETE FROM p1_dispatches WHERE id = '${DISPATCH_ID}';
     INSERT INTO p1_dispatches (
       id, work_order_id, branch_id, status,
       accept_window_started_at, accept_window_ends_at,
       created_by, created_at, updated_at, org_id
     ) VALUES (
       '${DISPATCH_ID}', '${WO_ID}', '${BRANCH_ID}', 'BROADCASTING',
       now(), now() + interval '2 hours', '${ADMIN_ID}', now(), now(), '${ORG_ID}'
     );
     INSERT INTO p1_dispatch_targets (
       id, dispatch_id, user_id, target_role, fanout_created_at, org_id
     ) VALUES (
       '00000000-0000-0000-0000-000000d10005', '${DISPATCH_ID}', '${MECH_ID}',
       'TECHNICIAN', now(), '${ORG_ID}'
     );
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetDispatchWo();
});

/** Select the seeded P1 work order on the board to open the controls panel. */
async function openControls(page: import("@playwright/test").Page) {
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
  // The board renders a ghost "{requestNo} 배차 제어" button per order for managers.
  const selectBtn = page.getByRole("button", { name: /-091 배차 제어/ });
  await expect(selectBtn).toBeVisible({ timeout: 8_000 });
  await selectBtn.click();
  // The controls card header is "배차 제어 · {requestNo}".
  await expect(
    page.getByRole("heading", { name: /배차 제어 · .*-091/ }),
  ).toBeVisible({ timeout: 8_000 });
}

test("ADMIN-09 admin sets priority, requests schedule change, and multi-assigns", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await openControls(page);

  // ── Priority ────────────────────────────────────────────────────────────────
  await page.locator(`#priority-${WO_ID}`).selectOption("P2");
  await page.getByRole("button", { name: "중요도 변경" }).click();
  await expect(page.getByText(/중요도를 변경했습니다\./)).toBeVisible({
    timeout: 8_000,
  });

  // ── Schedule change request ──────────────────────────────────────────────────
  await page.locator(`#schedule-${WO_ID}`).fill("2026-12-31T10:00");
  await page.getByLabel("변경 사유").fill("E2E 일정 변경 요청 사유");
  await page.getByRole("button", { name: "일정 변경 요청" }).click();
  await expect(page.getByText(/일정 변경을 요청했습니다\./)).toBeVisible({
    timeout: 8_000,
  });

  // ── Multi-mechanic assign (1 primary + 1 secondary) ──────────────────────────
  // Role buttons carry aria-label "{mechanic_name} 주" / "{mechanic_name} 보조".
  await page.getByRole("button", { name: "E2E Mechanic 주", exact: true }).click();
  await page
    .getByRole("button", { name: "E2E Mechanic 2 보조", exact: true })
    .click();
  // The assign button label is "배정"; the board's per-order button also says 배정,
  // so scope to the controls card region (the assign button after the role list).
  await page
    .getByRole("button", { name: "배정", exact: true })
    .last()
    .click();
  await expect(page.getByText(/정비사를 배정했습니다\./)).toBeVisible({
    timeout: 8_000,
  });
});

test("ADMIN-09 admin force-assigns an escalated P1 dispatch", async ({
  page,
  loginAs,
}) => {
  // Force-assign is only legal once a dispatch has escalated to the manager
  // (MANAGER_FORCE_PENDING) — broadcasting dispatches cannot be force-assigned.
  // Escalate the seeded dispatch into that state for this spec.
  sql(
    `SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE p1_dispatches SET status = 'MANAGER_FORCE_PENDING'
     WHERE id = '${DISPATCH_ID}';`,
  );

  await loginAs("ADMIN");
  await openControls(page);

  // Force-assign needs an in-flight dispatch surfaced for THIS work order. Look it
  // up by id in the offers panel — that sets the page's activeDispatch so the
  // force-assign select unlocks for the matching, selected order.
  await page.getByLabel("배차 코드").fill(DISPATCH_ID);
  await page.getByRole("button", { name: /^조회$/ }).click();
  // The offer status renders (관리자 강제 배정 대기 = MANAGER_FORCE_PENDING).
  await expect(page.getByText(/관리자 강제 배정 대기/).first()).toBeVisible({
    timeout: 8_000,
  });

  // The force-assign select now unlocks (was the "needs dispatch" hint before).
  const forceSelect = page.locator(`#force-${WO_ID}`);
  await expect(forceSelect).toBeVisible({ timeout: 8_000 });
  await forceSelect.selectOption(MECH_ID);

  // The destructive 강제 배정 button opens a confirm dialog.
  await page
    .getByRole("button", { name: "강제 배정", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "강제 배정 확인" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole("button", { name: "강제 배정", exact: true }).click();

  await expect(page.getByText(/강제 배정을 완료했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
});
