import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * ADMIN-21 — the unified action inbox landing surface (issue #55 lineage).
 *
 * UI-M3 replaced /work-hub with /overview (통합 개요): one deadline-first
 * action inbox over real pending items (engine approvals, dispatch offers,
 * support tickets, attendance exceptions) plus the Today/Plan todos panel.
 * The filename keeps the historical ADMIN-21 story id so the persona/maturity
 * matrices stay stable.
 *
 * Proves the AC round-trip in a real browser:
 *   1. a real seeded support ticket surfaces as an inbox row, and its primary
 *      action executes the REAL FSM transition (접수 → the row's next action
 *      becomes 해결);
 *   2. todos CRUD against the todos domain: add → appears; complete → leaves
 *      the open list; delete → gone;
 *   3. no route-error fallback anywhere on the surface.
 */
test("ADMIN-21 admin drives the overview action inbox end to end", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);
  await loginAs("ADMIN");

  // Seed one REAL actionable ticket through the public intake API so the run
  // is self-contained regardless of suite ordering.
  const ticketTitle = `Overview E2E ticket ${Date.now()}`;
  const intake = await page.request.post("/api/v1/support/intake", {
    data: {
      category: "OPERATIONAL",
      priority: "URGENT",
      title: ticketTitle,
      body: "Seeded by admin-21 to prove the overview primary action round-trip.",
      requester_name: "Overview E2E",
      requester_contact: "overview-e2e@example.invalid",
    },
  });
  expect(intake.ok()).toBe(true);

  await page.goto("/overview");
  await expect(
    page.getByRole("heading", { name: "통합 개요", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(
    page.getByRole("heading", { name: "액션 인박스", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "항목 종류 필터" }),
  ).toBeVisible();

  await test.step("ticket primary action runs the real support FSM", async () => {
    // (1) The seeded OPEN ticket is an inbox row whose primary action runs the
    // real support FSM transition. 접수 = OPEN → IN_PROGRESS…
    await expect(page.getByText(ticketTitle)).toBeVisible({ timeout: 15_000 });
    const transitionResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/transition") &&
        response.request().method() === "POST" &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: `${ticketTitle} 접수` }).click();
    await transitionResponse;
    await expect(page.getByText("티켓을 접수했습니다.")).toBeVisible();
    // …and after the refetch the SAME row's primary action is the next legal
    // transition (IN_PROGRESS → RESOLVED), proving the mutation stuck.
    await expect(
      page.getByRole("button", { name: `${ticketTitle} 해결` }),
    ).toBeVisible({ timeout: 15_000 });
  });

  await test.step("todos CRUD uses the real todos domain", async () => {
    // (2) Todos CRUD against the real todos domain.
    const todoText = `E2E 할 일 ${Date.now()}`;
    const createResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/me/todos") &&
        response.request().method() === "POST" &&
        response.status() === 201,
    );
    await page.getByRole("textbox", { name: "할 일 추가" }).fill(todoText);
    await page.getByRole("button", { name: "추가" }).click();
    await createResponse;
    await expect(page.getByText(todoText)).toBeVisible();

    // Complete it — explicit done state; the undo toast appears; the open list
    // no longer shows it.
    await page
      .getByRole("checkbox", { name: `${todoText} 완료로 표시` })
      .click();
    await expect(page.getByText("할 일을 완료했습니다.")).toBeVisible();
    await expect(page.getByText(todoText)).not.toBeVisible({ timeout: 15_000 });

    // Show done items, then delete it for a clean slate.
    await page.getByRole("checkbox", { name: "완료 항목 표시" }).check();
    await expect(page.getByText(todoText)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: `${todoText} 삭제` }).click();
    await expect(page.getByText("할 일을 삭제했습니다.")).toBeVisible();
    await expect(page.getByText(todoText)).not.toBeVisible({ timeout: 15_000 });
  });

  await test.step("route-error fallback stays absent", async () => {
    // (3) No route-error fallback anywhere on the surface.
    await expect(page.getByText("이 화면을 표시하지 못했습니다.")).not.toBeVisible();
  });

  await auditPage(page, { context: "/overview-action-inbox", consoleGuard });
});
