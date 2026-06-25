import { test, expect, sql } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * RECEPTIONIST messenger + support.
 *
 * Messenger threads are membership-scoped, so seed-recp.sql seeds a 'group'
 * thread "E2E 접수팀 대화" with the receptionist as OWNER. Support tickets are
 * branch-scoped, so the seed-mech ticket (…b00001) is visible to the receptionist
 * in the same branch; the receptionist's authorized capability is READ-ONLY.
 * Posting a comment maps to WorkOrderStart `[L, A, A, L, A]` which the comment
 * endpoint requires at the Allow level — receptionist=Limited does NOT satisfy it
 * (only MECHANIC/ADMIN/SUPER_ADMIN do), so the composer is hidden (app fix) rather
 * than 403-ing on submit. Triage (AssigneeManage, admin-only) stays hidden too.
 */

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const TICKET_ID = "00000000-0000-0000-0000-000000b00001";

function resetTicket() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM support_ticket_comments WHERE ticket_id = '${TICKET_ID}';
     UPDATE support_tickets
       SET status = 'OPEN', assignee_user_id = NULL
     WHERE id = '${TICKET_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetTicket();
});

test("RECP opens a messenger thread and sends a message", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("RECEPTIONIST");
  await page.goto("/messenger");
  await expect(
    page.getByRole("heading", { name: /메신저/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  const threadBtn = page
    .getByRole("button", { name: /E2E 접수팀 대화/ })
    .first();
  await expect(threadBtn).toBeVisible({ timeout: 8_000 });
  await threadBtn.click();

  const composer = page.getByRole("textbox", { name: /메시지 입력/ });
  await expect(composer).toBeVisible({ timeout: 5_000 });
  await composer.fill("접수 데스크 E2E 메시지입니다.");
  await page.getByRole("button", { name: /^전송$/ }).click();

  await expect(
    page.getByText(/접수 데스크 E2E 메시지입니다\./).first(),
  ).toBeVisible({ timeout: 8_000 });

  await auditPage(page, { context: "/messenger (receptionist)", consoleGuard });
});

test("RECP reads a support ticket; comment composer + triage stay hidden", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("RECEPTIONIST");
  await page.goto("/support");
  await expect(
    page.getByRole("heading", { name: /고객지원 티켓/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  const ticketBtn = page
    .getByRole("button", { name: /E2E 지원 티켓 테스트/ })
    .first();
  await expect(ticketBtn).toBeVisible({ timeout: 8_000 });
  await ticketBtn.click();

  await expect(
    page.getByRole("heading", { name: /E2E 지원 티켓 테스트/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // The comment thread section renders (the receptionist may READ the thread).
  await expect(
    page.getByRole("heading", { name: /대화 내역/ }).first(),
  ).toBeVisible();

  // Posting a comment requires WorkOrderStart at the Allow level, which a
  // receptionist (Limited) lacks; the composer is therefore hidden rather than
  // 403-ing on submit. Both the composer and its submit control must be absent.
  await expect(page.locator("#support-comment-body")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /코멘트 등록/ }),
  ).toHaveCount(0);

  // The triage "담당 맡기" (claim) control is admin-only (AssigneeManage) and must
  // NOT be offered to a receptionist.
  await expect(
    page.getByRole("button", { name: /담당 맡기/ }),
  ).toHaveCount(0);

  await auditPage(page, { context: "/support (receptionist)", consoleGuard });
});
