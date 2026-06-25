import { test, expect, sql } from "../fixtures/roles";

/**
 * MECH-12 — mechanic views a support ticket and adds a comment.
 *
 * A mechanic's authorized support capability is read + comment (the comment
 * endpoint requires WorkOrderStart, allowed for MECHANIC). Claiming/assigning a
 * ticket and transitioning its status both require AssigneeManage, which is
 * ADMIN/SUPER_ADMIN only — so the triage controls are not shown to a mechanic and
 * are not exercised here.
 *
 * Prerequisite: seed-mech.sql seeds an OPEN INTERNAL support ticket
 * titled "E2E 지원 티켓 테스트" (id …b00001).
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

test("MECH-12 mechanic views a support ticket and adds a comment", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await page.goto("/support");
  await expect(
    page.getByRole("heading", { name: /고객지원 티켓/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The seeded ticket should appear in the list.
  const ticketBtn = page
    .getByRole("button", { name: /E2E 지원 티켓 테스트/ })
    .first();
  await expect(ticketBtn).toBeVisible({ timeout: 8_000 });

  // Open the ticket.
  await ticketBtn.click();

  // The ticket detail panel should show the title.
  await expect(
    page.getByRole("heading", { name: /E2E 지원 티켓 테스트/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Add a comment.
  const commentInput = page.locator("#support-comment-body");
  await expect(commentInput).toBeVisible();
  await commentInput.fill("E2E 코멘트: 확인 후 조치하겠습니다.");
  await page.getByRole("button", { name: /코멘트 등록/ }).click();

  // The comment should appear in the thread — proving the mechanic's real
  // (WorkOrderStart-gated) capability worked end-to-end in the browser.
  await expect(
    page.getByText(/E2E 코멘트: 확인 후 조치하겠습니다\./).first(),
  ).toBeVisible({ timeout: 8_000 });

  // The triage "담당 맡기" (claim) control is admin-only (AssigneeManage) and must
  // NOT be offered to a mechanic — the UI hides it rather than 403-ing on click.
  await expect(
    page.getByRole("button", { name: /담당 맡기/ }),
  ).toHaveCount(0);
});
