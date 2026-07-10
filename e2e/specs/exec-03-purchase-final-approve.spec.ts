import {
  test,
  expect,
  sql,
  TENANT_ORG_ID,
  loginWithRetainedPasskey,
  waitForSessionReady,
} from "../fixtures/roles";
import { removeVirtualAuthenticator } from "../fixtures/auth";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * EXEC-03 — executive final-approves a purchase request on /financial.
 *
 * PurchaseFinalApprove is `[D, D, D, A, A]` — exec-only (plus SUPER_ADMIN). The
 * seeded request (…f10001) is parked at EXECUTIVE_PENDING (admin already
 * approved; amount above the 2,000,000원 executive threshold), so the executive's
 * 임원 최종 승인 control is the legitimate next step. Approving transitions it to
 * READY_TO_EXECUTE (집행 대기) — and the executive has NO PurchaseExecute, so the
 * 집행 button must stay hidden.
 *
 * A per-test reset restores the EXECUTIVE_PENDING state so the spec is
 * order-independent.
 */

const ORG_ID = TENANT_ORG_ID;
const PR_ID = "00000000-0000-0000-0000-000000f10001";
const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";

function resetPurchaseRequest() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE financial_purchase_requests
       SET status = 'EXECUTIVE_PENDING',
           executive_approved_by = NULL,
           executed_by = NULL,
           updated_at = now()
     WHERE id = '${PR_ID}';
     DELETE FROM financial_purchase_history
       WHERE purchase_request_id = '${PR_ID}'
         AND actor <> '${ADMIN_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetPurchaseRequest();
});

test("EXEC-03 executive final-approves an EXECUTIVE_PENDING purchase request", async ({
  page,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  // Final-approve now requires a real passkey step-up (M1 governance), so log in
  // keeping the virtual authenticator attached to auto-assert the ceremony.
  const authenticator = await loginWithRetainedPasskey(page, "EXECUTIVE");
  try {
    await waitForSessionReady(page);
    await page.goto("/financial");
    await expect(
      page.getByRole("heading", { name: /구매·정산/, level: 1 }),
    ).toBeVisible({ timeout: 8_000 });

    // Load the seeded EXECUTIVE_PENDING request by id (the 구매요청서 번호로 불러오기).
    await page.locator("#pr-lookup").fill(PR_ID);
    await page.getByRole("button", { name: /^불러오기$/ }).click();

    // The detail panel renders with the EXECUTIVE_PENDING (임원 승인 대기) badge.
    await expect(
      page.getByRole("heading", { name: /구매요청서 상세/ }),
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/임원 승인 대기/).first()).toBeVisible();

    // The exec-only final-approve control.
    const finalApprove = page.getByRole("button", { name: /임원 최종 승인/ });
    await expect(finalApprove).toBeVisible({ timeout: 8_000 });

    // Audit the settled detail panel before the mutation.
    await auditPage(page, {
      context: "/financial purchase EXECUTIVE_PENDING",
      consoleGuard,
    });

    // Click → passkey step-up auto-asserts → the mutation commits and the panel
    // refetches to READY_TO_EXECUTE (집행 대기). The badge is proof of the commit.
    await finalApprove.click();
    await expect(page.getByText(/집행 대기/).first()).toBeVisible({
      timeout: 8_000,
    });
    // The executive has no PurchaseExecute, so the 집행 control must NOT appear.
    await expect(page.getByRole("button", { name: /^집행$/ })).toHaveCount(0);

    consoleGuard.assertClean();
  } finally {
    await removeVirtualAuthenticator(authenticator);
  }
});
