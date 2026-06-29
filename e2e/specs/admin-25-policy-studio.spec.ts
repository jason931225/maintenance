import { Buffer } from "node:buffer";

import {
  test,
  expect,
  performRoleLogin,
  resetRateLimits,
  sql,
  TENANT_ORG_ID,
} from "../fixtures/roles";
import {
  attachVirtualAuthenticator,
  removeVirtualAuthenticator,
  type WebAuthnAuthenticator,
} from "../fixtures/auth";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

const ORG_ID = TENANT_ORG_ID;
const SUPER_ADMIN_ID = "00000000-0000-0000-0000-0000000d0005";
const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";
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

function seedPolicyRuntimeGrantFixture() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM user_role_assignments WHERE org_id = '${ORG_ID}' AND role_id = '${POLICY_ROLE_ID}';
     DELETE FROM policy_assignment_preview_receipts WHERE org_id = '${ORG_ID}';
     DELETE FROM policy_role_conditions WHERE org_id = '${ORG_ID}' AND role_id = '${POLICY_ROLE_ID}';
     DELETE FROM policy_role_permissions WHERE org_id = '${ORG_ID}' AND role_id = '${POLICY_ROLE_ID}';
     DELETE FROM policy_roles WHERE org_id = '${ORG_ID}' AND (id = '${POLICY_ROLE_ID}' OR role_key = 'e2e_runtime_policy_grant');
     INSERT INTO policy_roles (
       id, org_id, role_key, display_name, description, status,
       is_system, created_by, updated_by
     ) VALUES (
       '${POLICY_ROLE_ID}', '${ORG_ID}', 'e2e_runtime_policy_grant',
       'E2E 런타임 권한', '실제 패스키 배정 e2e fixture', 'ACTIVE',
       false, '${SUPER_ADMIN_ID}', '${SUPER_ADMIN_ID}'
     );
     INSERT INTO policy_role_permissions (org_id, role_id, feature_key, permission_level)
     VALUES ('${ORG_ID}', '${POLICY_ROLE_ID}', 'work_order_create', 'allow');
     COMMIT;`,
  );
}

async function seedDeviceId(page: Parameters<typeof performRoleLogin>[0]) {
  await page.addInitScript(
    (id) => {
      try {
        window.localStorage.setItem("maintenance_console_device_id", id);
      } catch {
        /* backend falls back to per-IP limiting if storage is unavailable. */
      }
    },
    `e2e-policy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
}

async function loginWithRetainedPasskey(
  page: Parameters<typeof performRoleLogin>[0],
  role: Parameters<typeof performRoleLogin>[1],
): Promise<WebAuthnAuthenticator> {
  resetRateLimits();
  await seedDeviceId(page);
  const authenticator = await attachVirtualAuthenticator(page);
  await performRoleLogin(page, role);
  return authenticator;
}

async function refreshAccessToken(
  page: Parameters<typeof performRoleLogin>[0],
) {
  return page.evaluate(async () => {
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
    return { status: response.status, token: body.access_token ?? "" };
  });
}

function decodeJwtPayload(token: string): { feature_grants?: string[] } {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("access token has no payload");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    feature_grants?: string[];
  };
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
  await expect(
    page.getByText("이 화면을 표시하지 못했습니다."),
  ).not.toBeVisible();

  const assignmentsResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/policy/assignments") &&
      response.url().includes("user_id=00000000-0000-0000-0000-0000000d0003") &&
      response.request().method() === "GET" &&
      response.status() === 200,
  );
  await page.getByLabel("사용자", { exact: true }).selectOption({
    label: "E2E Admin",
  });
  await assignmentsResponse;
  await expect(page.getByLabel("E2E 권한 관리자", { exact: true })).toBeVisible(
    {
      timeout: 8_000,
    },
  );
  await page.getByLabel("E2E 권한 관리자", { exact: true }).check();

  const previewResponse = page.waitForResponse(
    (response) =>
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
  await expect(
    decisionPath.getByText("현재 사용자 지정 역할 없음"),
  ).toBeVisible();
  await expect(
    decisionPath.getByText("변경 후", { exact: true }),
  ).toBeVisible();
  await expect(decisionPath.getByText("E2E 권한 관리자")).toBeVisible();
  await expect(decisionPath.getByText("런타임 판정")).toBeVisible();
  await expect(decisionPath.getByText("런타임 차단 있음")).toBeVisible();
  await expect(decisionPath.getByText("다음 단계")).toBeVisible();
  await expect(
    decisionPath.getByText("런타임 차단 사유를 해소한 뒤 다시 미리보기하세요."),
  ).toBeVisible();
  await expect(previewPanel.getByLabel("영향 판정 요약")).toBeVisible();
  await expect(
    previewPanel.getByText("업무 객체 중심 실행 흐름"),
  ).not.toBeVisible();

  await auditPage(page, { context: "/settings/policy", consoleGuard });
});

test("ADMIN-25 publishes a custom role through a real passkey step-up and audit/version write", async ({
  page,
}) => {
  const authenticator = await loginWithRetainedPasskey(page, "SUPER_ADMIN");
  try {
    const consoleGuard = attachConsoleGuard(page);
    await page.goto("/settings/policy");
    await expect(
      page.getByRole("heading", { name: "권한 정책", level: 1 }),
    ).toBeVisible({ timeout: 8_000 });

    const draftRoleRow = page.getByRole("row", {
      name: /E2E 권한 관리자.*DRAFT/u,
    });
    await draftRoleRow
      .getByRole("button", { name: "게시(패스키)" })
      .scrollIntoViewIfNeeded();
    await draftRoleRow.getByRole("button", { name: "게시(패스키)" }).click();
    const preview = page.getByRole("region", {
      name: "역할 상태 영향 미리보기",
    });
    await expect(preview).toBeVisible({ timeout: 8_000 });
    await expect(preview.getByText("DRAFT → ACTIVE")).toBeVisible();
    await expect(
      preview.getByText(
        "현재 배정 기준으로 즉시 바뀌는 런타임 권한은 없습니다.",
      ),
    ).toBeVisible();
    await expect(
      preview.getByText("민감 정책 변경이므로 패스키 승인이 필요합니다."),
    ).toBeVisible();

    const statusResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/api/v1/policy/roles/${POLICY_ROLE_ID}/status`) &&
        response.request().method() === "PATCH" &&
        response.status() === 200,
    );
    await preview
      .getByRole("button", { name: "미리보기 확인 후 패스키로 변경" })
      .click();
    await statusResponse;

    await expect(page.getByText("역할 상태가 업데이트되었습니다.")).toBeVisible(
      { timeout: 8_000 },
    );
    sql(
      `DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM policy_roles
           WHERE org_id = '${ORG_ID}'
             AND id = '${POLICY_ROLE_ID}'
             AND status = 'ACTIVE'
         ) THEN
           RAISE EXCEPTION 'policy role was not activated';
         END IF;
         IF NOT EXISTS (
           SELECT 1 FROM policy_versions
           WHERE org_id = '${ORG_ID}'
             AND version >= 1
         ) THEN
           RAISE EXCEPTION 'policy version was not bumped';
         END IF;
         IF NOT EXISTS (
           SELECT 1 FROM audit_events
           WHERE org_id = '${ORG_ID}'
             AND action = 'policy.role.status_update.snapshot'
             AND target_id = '${POLICY_ROLE_ID}'
         ) THEN
           RAISE EXCEPTION 'policy status audit snapshot was not written';
         END IF;
       END $$;`,
    );
    await auditPage(page, {
      context: "/settings/policy#publish-step-up",
      consoleGuard,
    });
  } finally {
    await removeVirtualAuthenticator(authenticator);
  }
});

test("ADMIN-25 saves a policy assignment through real passkey step-up and refreshes runtime grants", async ({
  browser,
  page,
}) => {
  seedPolicyRuntimeGrantFixture();
  const superAdminAuthenticator = await loginWithRetainedPasskey(
    page,
    "SUPER_ADMIN",
  );
  try {
    const consoleGuard = attachConsoleGuard(page);
    await page.goto("/settings/policy");
    await expect(
      page.getByRole("heading", { name: "권한 정책", level: 1 }),
    ).toBeVisible({ timeout: 8_000 });

    const assignmentsResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/policy/assignments") &&
        response.url().includes(`user_id=${ADMIN_ID}`) &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await page.getByLabel("사용자", { exact: true }).selectOption({
      label: "E2E Admin",
    });
    await assignmentsResponse;
    await page.getByLabel("E2E 런타임 권한", { exact: true }).check();

    const previewResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/api/v1/policy/users/${ADMIN_ID}/assignment-preview`) &&
        response.request().method() === "POST" &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "영향 미리보기" }).click();
    await previewResponse;

    const previewPanel = page.getByRole("region", {
      name: "권한 영향 미리보기",
    });
    await expect(previewPanel).toBeVisible({ timeout: 8_000 });
    await expect(previewPanel.getByText("검토 필요").first()).toBeVisible();
    await expect(
      previewPanel.getByText(
        "선택한 사용자 지정 역할은 저장 후 런타임에 반영됩니다.",
      ),
    ).toBeVisible();
    await page
      .getByRole("checkbox", {
        name: "권한 영향 미리보기를 검토했고 이 배정 변경을 진행합니다.",
      })
      .check();

    const saveResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/api/v1/policy/users/${ADMIN_ID}/assignments`) &&
        response.request().method() === "PUT" &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "배정 저장(패스키)" }).click();
    await saveResponse;
    await expect(page.getByText("역할 배정을 저장했습니다.")).toBeVisible({
      timeout: 8_000,
    });
    sql(
      `DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM user_role_assignments
           WHERE org_id = '${ORG_ID}'
             AND user_id = '${ADMIN_ID}'
             AND role_id = '${POLICY_ROLE_ID}'
         ) THEN
           RAISE EXCEPTION 'custom role assignment was not persisted';
         END IF;
         IF NOT EXISTS (
           SELECT 1 FROM audit_events
           WHERE org_id = '${ORG_ID}'
             AND action = 'policy.role_assignment.replace.snapshot'
             AND target_id = '${ADMIN_ID}'
         ) THEN
           RAISE EXCEPTION 'policy assignment audit snapshot was not written';
         END IF;
       END $$;`,
    );
    await auditPage(page, {
      context: "/settings/policy#assignment-step-up",
      consoleGuard,
    });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const adminAuthenticator = await loginWithRetainedPasskey(
      adminPage,
      "ADMIN",
    );
    try {
      const { status, token } = await refreshAccessToken(adminPage);
      expect(status).toBe(200);
      const claims = decodeJwtPayload(token);
      expect(claims.feature_grants ?? []).toContain("work_order_create");
    } finally {
      await removeVirtualAuthenticator(adminAuthenticator);
      await adminContext.close();
    }
  } finally {
    await removeVirtualAuthenticator(superAdminAuthenticator);
  }
});
