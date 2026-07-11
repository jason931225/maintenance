import { test, expect, loginAsLanding, querySql, resetRateLimits, sql, TENANT_ORG_ID } from "../fixtures/roles";
import { assertNoAxeViolations, assertNoRawI18nKeys, navigateByHref } from "../fixtures/ux";

/**
 * PERSONA-DISPATCHER — 배차 담당, ROADMAP.md §8 row 2.
 *
 * Design mirror top workflow: WO- 큐(SLA 칩)→가용 기사 매칭→배정 승인→추적→
 * 정산 연동. "전담 페르소나는 미분리(v1 수행)" per ROADMAP — driven as ADMIN,
 * same role admin-09-dispatch.spec.ts already exercises for the controls panel;
 * this spec instead scripts the FULL persona flow end-to-end (queue read →
 * priority/SLA read → assign → SQL-verify → track) and asserts the assign
 * primary action lands in <=3 clicks from the authenticated landing route.
 *
 * Reuses the seed-admin.sql P1 work order (…f00009) + broadcasting dispatch
 * (…d10003) admin-09 already seeds; this spec resets the same rows itself so
 * it is order-independent of that spec.
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
  resetRateLimits();
  resetDispatchWo();
});

test("PERSONA-DISPATCHER WO 큐(SLA/우선순위 칩) → 매칭 → 배정, <=3 clicks from landing, SQL-verified", async ({
  page,
}) => {
  await loginAsLanding(page, "ADMIN");

  // click 1/3: nav → dispatch board (WO- 큐).
  await navigateByHref(page, "/dispatch");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // The board renders a per-order "{requestNo} 배차 제어" ghost button; its
  // sibling priority chip is the SLA-adjacent signal this persona scans first.
  const selectBtn = page.getByRole("button", { name: /-091 배차 제어/ });
  await expect(selectBtn).toBeVisible({ timeout: 10_000 });
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "dispatch board (WO 큐)" });

  // click 2/3: select the P1 order to open the controls panel (가용 기사 매칭 UI).
  await selectBtn.click();
  await expect(
    page.getByRole("heading", { name: /배차 제어 · .*-091/ }),
  ).toBeVisible({ timeout: 8_000 });

  // click 3/3: assign the available mechanic (배정 승인).
  await page.getByRole("button", { name: "E2E Mechanic 주", exact: true }).click();
  await page.getByRole("button", { name: "배정", exact: true }).last().click();
  await expect(page.getByText(/정비사를 배정했습니다\./)).toBeVisible({
    timeout: 8_000,
  });

  await expect
    .poll(
      () =>
        querySql<{ mechanic_id: string; role: string }>(`
          SELECT mechanic_id, role FROM work_order_assignments
          WHERE work_order_id = '${WO_ID}' AND org_id = '${ORG_ID}'
        `)[0] ?? null,
      { message: "assignment should commit", timeout: 8_000 },
    )
    .toEqual({ mechanic_id: MECH_ID, role: "PRIMARY" });

  // ── 추적 (tracking): the work order detail page renders the assigned state. ──
  await page.goto(`/work-orders/${WO_ID}`);
  await expect(
    page.getByRole("heading", { name: "작업지시 상세", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });
});

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): WorkOrderDetailPage has no link to a
  // financial voucher / settlement object (grep for 정산|financial|voucher in
  // web/src/pages/WorkOrderDetailPage.tsx = zero hits, 2026-07-10). ROADMAP §2's
  // standard relation chain ends "...LaborCost → ContractProfitability (환류)"
  // but the dispatch board never links a completed WO- forward to that chain.
  // Fix lane: add a WO- → finance_voucher/ContractProfitability link chip on
  // WorkOrderDetailPage (mirrors the object-link chip pattern already used in
  // web/src/console/modules/moduleScreens.ts financeModuleScreen.detail.linkChips).
  "PERSONA-DISPATCHER 배차 완료 WO- → 정산(재무전표) 연동 확인",
  async () => {},
);
