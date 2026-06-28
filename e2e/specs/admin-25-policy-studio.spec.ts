import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

const ORG_ID = TENANT_ORG_ID;
const SUPER_ADMIN_ID = "00000000-0000-0000-0000-0000000d0005";
const POLICY_ROLE_ID = "00000000-0000-0000-0000-0000000e2501";

function seedPolicyDecisionPathFixture() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM user_role_assignments WHERE org_id = '${ORG_ID}' AND role_id = '${POLICY_ROLE_ID}';
     DELETE FROM policy_role_conditions WHERE org_id = '${ORG_ID}' AND role_id = '${POLICY_ROLE_ID}';
     DELETE FROM policy_role_permissions WHERE org_id = '${ORG_ID}' AND role_id = '${POLICY_ROLE_ID}';
     DELETE FROM policy_roles WHERE org_id = '${ORG_ID}' AND (id = '${POLICY_ROLE_ID}' OR role_key = 'e2e_policy_decision_path');
     INSERT INTO policy_roles (
       id, org_id, role_key, display_name, description, status,
       is_system, created_by, updated_by
     ) VALUES (
       '${POLICY_ROLE_ID}', '${ORG_ID}', 'e2e_policy_decision_path',
       'E2E 권한 관리자', '권한 변경 결정 경로 e2e fixture', 'DRAFT',
       false, '${SUPER_ADMIN_ID}', '${SUPER_ADMIN_ID}'
     );
     INSERT INTO policy_role_permissions (org_id, role_id, feature_key, permission_level)
     VALUES ('${ORG_ID}', '${POLICY_ROLE_ID}', 'work_order_create', 'allow');
     INSERT INTO policy_role_conditions (
       org_id, role_id, condition_key, attribute, operator, condition_values
     ) VALUES (
       '${ORG_ID}', '${POLICY_ROLE_ID}', 'department_1', 'department', 'in', ARRAY['정비팀','야간조']
     );
     COMMIT;`,
  );
}

test.beforeEach(() => {
  seedPolicyDecisionPathFixture();
});

test("ADMIN-25 policy assignment preview shows a workflow-aware decision path", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);
  await loginAs("SUPER_ADMIN");

  await page.goto("/settings/policy");
  await expect(
    page.getByRole("heading", { name: "권한 정책", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("이 화면을 표시하지 못했습니다.")).not.toBeVisible();

  const assignmentsResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/policy/assignments") &&
    response.url().includes("user_id=00000000-0000-0000-0000-0000000d0003") &&
    response.request().method() === "GET" &&
    response.status() === 200,
  );
  await page.getByLabel("사용자", { exact: true }).selectOption({
    label: "E2E Admin",
  });
  await assignmentsResponse;
  await expect(page.getByLabel("E2E 권한 관리자", { exact: true })).toBeVisible({
    timeout: 8_000,
  });
  await page.getByLabel("E2E 권한 관리자", { exact: true }).check();

  const previewResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/policy/users/") &&
    response.url().includes("/assignment-preview") &&
    response.request().method() === "POST" &&
    response.status() === 200,
  );
  await page.getByRole("button", { name: "영향 미리보기" }).click();
  await previewResponse;

  const previewPanel = page.getByRole("region", { name: "권한 영향 미리보기" });
  await expect(previewPanel).toBeVisible({ timeout: 8_000 });
  const decisionPath = previewPanel.getByRole("group", {
    name: "권한 변경 결정 경로",
  });
  await expect(decisionPath).toBeVisible();
  await expect(decisionPath.getByText("대상 사용자")).toBeVisible();
  await expect(decisionPath.getByText("E2E Admin")).toBeVisible();
  await expect(decisionPath.getByText("현재 배정")).toBeVisible();
  await expect(decisionPath.getByText("현재 사용자 지정 역할 없음")).toBeVisible();
  await expect(decisionPath.getByText("변경 후", { exact: true })).toBeVisible();
  await expect(decisionPath.getByText("E2E 권한 관리자")).toBeVisible();
  await expect(decisionPath.getByText("런타임 판정")).toBeVisible();
  await expect(decisionPath.getByText("런타임 차단 있음")).toBeVisible();
  await expect(decisionPath.getByText("다음 단계")).toBeVisible();
  await expect(
    decisionPath.getByText("런타임 차단 사유를 해소한 뒤 다시 미리보기하세요."),
  ).toBeVisible();
  await expect(previewPanel.getByLabel("영향 판정 요약")).toBeVisible();
  await expect(previewPanel.getByText("업무 객체 중심 실행 흐름")).not.toBeVisible();

  await auditPage(page, { context: "/settings/policy", consoleGuard });
});
