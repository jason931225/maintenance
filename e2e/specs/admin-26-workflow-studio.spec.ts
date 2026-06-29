import { test, expect, querySql, TENANT_ORG_ID } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

test("ADMIN-26 Workflow Studio creates audited drafts and enforces passkey step-up for publish", async ({
  page,
  loginAs,
}) => {
  const workflowKey = `work_order.maintenance_completion_approval_${Date.now().toString(36)}`;
  const displayName = `정비 완료 승인 ${workflowKey.split("_").at(-1)}`;
  const consoleGuard = attachConsoleGuard(page);
  await loginAs("SUPER_ADMIN");

  await page.goto("/settings/workflows");
  await expect(
    page.getByRole("heading", { name: "워크플로 스튜디오", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(
    page.getByText("이 화면을 표시하지 못했습니다."),
  ).not.toBeVisible();

  await page.getByRole("button", { name: "정비 완료 승인" }).last().click();
  await page.getByLabel("워크플로 키").fill(workflowKey);
  await page.getByLabel("이름").fill(displayName);
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/workflow-studio/definitions") &&
      response.request().method() === "POST" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "초안 생성" }).click();
  const created = (await (await createResponse).json()) as { id: string };
  await expect(page.getByText("워크플로 초안을 생성했습니다.")).toBeVisible();
  await expect(page.getByRole("row", { name: displayName })).toBeVisible();

  const rows = querySql<{
    workflow_key: string;
    definition_status: string;
    version: number;
    version_status: string;
    required_approval_line: boolean;
    event_action: string;
  }>(
    `SELECT d.workflow_key,
            d.status AS definition_status,
            v.version,
            v.status AS version_status,
            v.required_approval_line,
            e.action AS event_action
       FROM workflow_definitions d
       JOIN workflow_definition_versions v ON v.definition_id = d.id AND v.org_id = d.org_id
       JOIN workflow_definition_events e ON e.definition_id = d.id AND e.org_id = d.org_id
      WHERE d.org_id = '${TENANT_ORG_ID}'
        AND d.workflow_key = '${workflowKey}'
      ORDER BY v.version DESC, e.created_at DESC
      LIMIT 1`,
  );
  expect(rows).toEqual([
    expect.objectContaining({
      workflow_key: workflowKey,
      definition_status: "DRAFT",
      version: 1,
      version_status: "DRAFT",
      required_approval_line: true,
      event_action: "workflow_definition.create_draft",
    }),
  ]);

  const token = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/token/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Transport": "cookie",
      },
      credentials: "include",
      body: "{}",
    });
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? "";
  });
  expect(token.length).toBeGreaterThan(20);

  const publishResponse = await page.request.post(
    `/api/v1/workflow-studio/definitions/${created.id}/publish`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: {},
    },
  );
  expect(publishResponse.status()).toBe(428);

  const versionRows = querySql<{ version_count: number; max_version: number }>(
    `SELECT COUNT(*)::int AS version_count, MAX(version)::int AS max_version
       FROM workflow_definition_versions
      WHERE org_id = '${TENANT_ORG_ID}' AND definition_id = '${created.id}'`,
  );
  expect(versionRows).toEqual([{ version_count: 1, max_version: 1 }]);

  await auditPage(page, { context: "/settings/workflows", consoleGuard });
});
