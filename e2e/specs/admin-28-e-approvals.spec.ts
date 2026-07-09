import { test, expect, querySql, sql, TENANT_ORG_ID } from "../fixtures/roles";
import type { Page } from "@playwright/test";

/**
 * ADMIN-28 — 전자결재 (approvals on the workflow engine), UI-M4.
 *
 * Proves the full user story on the real engine:
 *   1. an initiator (MECHANIC) submits a run against a seeded approval definition,
 *   2. a DIFFERENT actor (ADMIN) claims + approves each line step via the 전자결재
 *      screen (결재함 → pin detail → 승인), advancing the run,
 *   3. the initiator finalizes (종결) their own run and sees it 종결 in 상신함,
 *   4. SoD: an initiator who also holds the approval authority is NEVER offered
 *      the 승인 control on their own run (deny-by-omission), and the engine
 *      returns 403 on a self-approval attempt.
 *
 * The submit step uses the real start endpoint (there is no all-employee compose
 * catalog yet — see the UI-M4 report), which is the sanctioned "use an existing
 * engine definition" path.
 */

const ORG = TENANT_ORG_ID;
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";
const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";

/** The linear approval definition mirrors the backend test seed
 * (workflow_run_read_surface::seed_approval_definition):
 * submit(gate) → review.hr → approve.manager → finalize.author. */
function seedApprovalDefinition(definitionId: string, workflowKey: string): void {
  const definition = JSON.stringify({
    schema_version: "wf.exec.v1",
    workflow_key: workflowKey,
    nodes: [
      { node_key: "submit", node_type: "object_gate", title: "Submit" },
      {
        node_key: "review.hr",
        node_type: "human_task",
        title: "HR review",
        assignee_role_key: "hr_reviewer",
        required_policy: "approval_review",
      },
      {
        node_key: "approve.manager",
        node_type: "human_task",
        title: "Manager approval",
        assignee_role_key: "manager_approver",
        required_policy: "approval_decide",
      },
      {
        node_key: "finalize.author",
        node_type: "human_task",
        title: "Author finalize",
        assignee_role_key: "initiator",
        required_policy: "approval_finalize",
      },
    ],
    edges: [
      { from: "submit", to: "review.hr" },
      { from: "review.hr", to: "approve.manager" },
      { from: "approve.manager", to: "finalize.author" },
    ],
  }).replace(/'/g, "''");

  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG}', true);
     INSERT INTO workflow_definitions
       (id, org_id, workflow_key, display_name, object_type, status, latest_version, active_version)
     VALUES ('${definitionId}', '${ORG}', '${workflowKey}', 'E2E Approval',
             'approval_document', 'ACTIVE', 1, 1);
     INSERT INTO workflow_definition_versions
       (org_id, definition_id, version, status, definition, required_approval_line, required_payment_line)
     VALUES ('${ORG}', '${definitionId}', 1, 'PUBLISHED', '${definition}'::jsonb, TRUE, FALSE);
     COMMIT;`,
  );
}

/** Capture the signed-in session's bearer for direct API calls (admin-26 pattern). */
async function bearerToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/token/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Transport": "cookie" },
      credentials: "include",
      body: "{}",
    });
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? "";
  });
  expect(token.length).toBeGreaterThan(20);
  return token;
}

async function startRun(
  page: Page,
  token: string,
  definitionId: string,
  idempotencyKey: string,
): Promise<string> {
  const response = await page.request.post("/api/v1/workflow-runs", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      definition_id: definitionId,
      trigger_type: "MANUAL",
      idempotency_key: idempotencyKey,
      input_payload: { reason: "annual" },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { run: { id: string; status: string } };
  expect(body.run.status).toBe("WAITING");
  return body.run.id;
}

function waitingTaskKeys(runId: string): string[] {
  return querySql<{ waiting_key: string }>(
    `SELECT waiting_key FROM workflow_waiting_tasks
      WHERE run_id = '${runId}' AND status IN ('OPEN','CLAIMED')`,
  ).map((row) => row.waiting_key);
}

/** In the pinned run-detail panel: claim (if offered) then approve. */
async function claimAndApproveInPanel(page: Page): Promise<void> {
  const panel = page.getByTestId("workspace-pin-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  const claim = panel.getByRole("button", { name: "담당" });
  await expect(claim).toBeVisible({ timeout: 10_000 });
  await claim.click();
  const approve = panel.getByRole("button", { name: "승인" });
  await expect(approve).toBeVisible({ timeout: 10_000 });
  await approve.click();
}

test("ADMIN-28 initiator submits, a different actor approves the line, initiator finalizes", async ({
  page,
  loginAs,
}) => {
  const workflowKey = `e2e.approval.${Date.now().toString(36)}`;
  const definitionId = crypto.randomUUID();
  seedApprovalDefinition(definitionId, workflowKey);

  // 1) MECHANIC submits (real engine start).
  await loginAs("MECHANIC");
  const mechToken = await bearerToken(page);
  const runId = await startRun(page, mechToken, definitionId, `e2e-approve-${Date.now()}`);
  expect(waitingTaskKeys(runId)).toContain("review.hr");

  // MECHANIC sees the run in 상신함.
  await page.goto("/e-approvals");
  await expect(page.getByRole("heading", { name: "전자결재", level: 1 })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("tab", { name: /상신함/ }).click();
  await expect(page.getByText("approval_document").first()).toBeVisible({ timeout: 10_000 });

  // 2) ADMIN (a DIFFERENT actor) approves review.hr, then approve.manager.
  await loginAs("ADMIN");
  await page.goto("/e-approvals");
  await expect(
    page.getByRole("button", { name: /HR review 결재/ }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /HR review 결재/ }).click();
  await claimAndApproveInPanel(page);
  await expect(page.getByText("승인했습니다.")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => waitingTaskKeys(runId)).toContain("approve.manager");

  // The panel reloads to the next line step in place — approve it too.
  await claimAndApproveInPanel(page);
  await expect.poll(() => waitingTaskKeys(runId)).toContain("finalize.author");

  const approverRows = querySql<{ completed_by: string | null; status: string }>(
    `SELECT completed_by::text, status FROM workflow_waiting_tasks
      WHERE run_id = '${runId}' AND waiting_key = 'review.hr'`,
  );
  expect(approverRows[0]).toMatchObject({ completed_by: ADMIN_ID, status: "APPROVED" });

  // 3) MECHANIC (initiator) finalizes their own run → 종결.
  await loginAs("MECHANIC");
  await page.goto("/e-approvals");
  await page.getByRole("button", { name: /Author finalize 종결/ }).click();
  const panel = page.getByTestId("workspace-pin-panel");
  await panel.getByRole("button", { name: "종결" }).click();
  await expect(page.getByText("종결했습니다.")).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      () =>
        querySql<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE id = '${runId}'`,
        )[0]?.status,
    )
    .toBe("SUCCEEDED");
});

test("ADMIN-28 SoD: an initiator is never offered 승인 on their own run and the engine blocks self-approval", async ({
  page,
  loginAs,
}) => {
  const workflowKey = `e2e.sod.${Date.now().toString(36)}`;
  const definitionId = crypto.randomUUID();
  seedApprovalDefinition(definitionId, workflowKey);

  // ADMIN both initiates AND holds the review authority (completion_review).
  await loginAs("ADMIN");
  const adminToken = await bearerToken(page);
  const runId = await startRun(page, adminToken, definitionId, `e2e-sod-${Date.now()}`);

  // The task is in ADMIN's own 결재함 (they hold hr_reviewer), but opening it
  // offers NO 승인 — deny-by-omission, because ADMIN is the initiator.
  await page.goto("/e-approvals");
  await page.getByRole("button", { name: /HR review 결재/ }).click();
  const panel = page.getByTestId("workspace-pin-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByText("review.hr")).toBeVisible();
  await expect(panel.getByRole("button", { name: "승인" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "담당" })).toHaveCount(0);

  // And the engine itself blocks a self-approval attempt (#205 SoD guard): claim
  // succeeds, but decide=approve on a run ADMIN initiated is a 403.
  const taskId = querySql<{ id: string }>(
    `SELECT id::text FROM workflow_waiting_tasks
      WHERE run_id = '${runId}' AND waiting_key = 'review.hr'`,
  )[0].id;
  const claim = await page.request.post(`/api/v1/workflow-tasks/${taskId}/claim`, {
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    data: { idempotency_key: `e2e-sod-claim-${Date.now()}` },
  });
  expect(claim.ok()).toBeTruthy();
  const decide = await page.request.post(`/api/v1/workflow-tasks/${taskId}/decide`, {
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    data: { decision: "approve", idempotency_key: `e2e-sod-decide-${Date.now()}` },
  });
  expect(decide.status()).toBe(403);
});
