import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppRouter } from "../AppRouter";
import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import {
  createEmptyWorkflowDefinition,
  createWorkflowNode,
} from "../features/workflow-canvas/model";
import type { WorkflowDefinitionV1 } from "../features/workflow-canvas/model";

const mockStepUpAssertion = {
  ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credential: {
    id: "credential",
    rawId: "credential",
    response: {
      authenticatorData: "authenticator-data",
      clientDataJSON: "client-data",
      signature: "signature",
      userHandle: null,
    },
    type: "public-key",
  },
};

const mockAssertPasskeyStepUp = vi.hoisted(() => vi.fn());

vi.mock("../auth/webauthn", () => ({
  assertPasskeyStepUp: mockAssertPasskeyStepUp,
}));

const server = setupServer();
const publishRequests: unknown[] = [];
const createRequests: unknown[] = [];
const updateRequests: unknown[] = [];
const archiveRequests: unknown[] = [];
const lifecycleRequests: Array<{ action: string; body: unknown }> = [];

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

beforeEach(() => {
  publishRequests.length = 0;
  createRequests.length = 0;
  updateRequests.length = 0;
  archiveRequests.length = 0;
  lifecycleRequests.length = 0;
  mockAssertPasskeyStepUp.mockResolvedValue(mockStepUpAssertion);
});

afterEach(() => {
  server.resetHandlers();
  mockAssertPasskeyStepUp.mockReset();
});

afterAll(() => {
  server.close();
});

const session: AuthSession = {
  access_token: "token",
  user_id: "00000000-0000-4000-8000-0000000000aa",
  display_name: "개발자",
  roles: ["SUPER_ADMIN"],
  group_roles: [],
  feature_grants: ["role_manage"],
  org_id: "00000000-0000-0000-0000-0000000000a1",
  branches: ["00000000-0000-4000-8000-000000000001"],
  isPlatform: false,
};

function renderApp(path = "/settings/workflows") {
  const auth: AuthContextValue = {
    session,
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api: createConsoleApiClient(() => session.access_token),
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  };
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const catalogResponse = {
  connectors: [
    {
      connector_key: "internal.approvals",
      display_name: "승인센터",
      action_keys: ["request_approval", "notify_assignee"],
    },
    {
      connector_key: "internal.notifications",
      display_name: "알림",
      action_keys: ["send_badge", "send_push"],
    },
    {
      connector_key: "internal.audit",
      display_name: "감사 로그",
      action_keys: ["append_timeline_event"],
    },
  ],
  templates: [
    {
      template_key: "equipment_location_access_policy",
      display_name: "장비·위치 접근 정책",
      object_type: "equipment",
      required_approval_line: true,
      required_payment_line: false,
    },
    {
      template_key: "maintenance_completion_approval",
      display_name: "정비 완료 승인",
      object_type: "work_order",
      required_approval_line: true,
      required_payment_line: false,
    },
  ],
};

const baseDefinition = {
  id: "11111111-1111-4111-8111-111111111111",
  workflow_key: "work_order.completion_review",
  display_name: "작업 완료 승인",
  object_type: "work_order",
  status: "DRAFT",
  latest_version: 1,
  active_version: null,
  definition: {},
  approval_line: [],
  payment_line: [],
  notification_rules: [],
  action_allowlist: [],
  required_approval_line: false,
  required_payment_line: false,
  created_at: "2026-06-29T09:00:00Z",
  updated_at: "2026-06-29T09:00:00Z",
};

const secondaryDefinition = {
  ...baseDefinition,
  id: "44444444-4444-4444-8444-444444444444",
  workflow_key: "work_order.safety_review",
  display_name: "안전 점검 승인",
};

const definitionsResponse = {
  items: [baseDefinition],
};

const historyResponse = {
  items: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      definition_id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      status: "DRAFT",
      action: "workflow_definition.create_draft",
      actor_display_name: "개발자",
      summary: "초안 생성",
      created_at: "2026-06-29T09:00:00Z",
    },
  ],
};

const secondaryHistoryResponse = {
  items: [
    {
      ...historyResponse.items[0],
      id: "55555555-5555-4555-8555-555555555555",
      definition_id: secondaryDefinition.id,
      summary: "안전 점검 초안 생성",
    },
  ],
};

function installBaseHandlers() {
  server.use(
    http.get("*/api/v1/workflow-studio/catalog", () =>
      HttpResponse.json(catalogResponse),
    ),
    http.get("*/api/v1/workflow-studio/definitions", () =>
      HttpResponse.json(definitionsResponse),
    ),
    http.get("*/api/v1/workflow-studio/definitions/:id/history", () =>
      HttpResponse.json(historyResponse),
    ),
  );
}

describe("WorkflowStudioPage", () => {
  it("loads workflow definitions, connector allowlist, authoring, and change history", async () => {
    installBaseHandlers();

    renderApp();

    expect(
      await screen.findByRole(
        "heading",
        { name: "워크플로 스튜디오" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("작업 완료 승인")).toBeInTheDocument();
    expect(screen.getByText("승인센터")).toBeInTheDocument();
    expect(screen.getByText("request_approval")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "워크플로 캔버스" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("초안 생성").length).toBeGreaterThan(0);
    expect(screen.queryByText("Workflow + Approval")).not.toBeInTheDocument();
  }, 15000);

  it("creates a draft from the no-code canvas with a canonical workflow definition", async () => {
    installBaseHandlers();
    server.use(
      http.post("*/api/v1/workflow-studio/definitions", async ({ request }) => {
        const body = await request.json();
        createRequests.push(body);
        return HttpResponse.json({
          ...baseDefinition,
          id: "33333333-3333-4333-8333-333333333333",
          workflow_key: (body as { workflow_key: string }).workflow_key,
          display_name: (body as { display_name: string }).display_name,
          object_type: (body as { object_type: string }).object_type,
          definition: (body as { definition: unknown }).definition,
          required_approval_line: true,
          approval_line: [
            { step_key: "manager", approver_role: "MANAGER", required: true },
          ],
          action_allowlist: [
            {
              connector_key: "internal.approvals",
              action_key: "request_approval",
            },
          ],
        });
      }),
    );

    renderApp();

    expect(await screen.findByRole("heading", { name: "워크플로 캔버스" })).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "정의 JSON" }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "휴가 신청 승인 템플릿 사용" }),
    );
    const fallbackInput = await screen.findByLabelText("승인 대체 역할");
    await userEvent.clear(fallbackInput);
    await userEvent.type(fallbackInput, "people.ops.manager");
    await userEvent.click(screen.getByRole("button", { name: "초안 생성" }));

    await waitFor(() => {
      expect(createRequests).toHaveLength(1);
    });
    const request = createRequests[0] as {
      workflow_key: string;
      display_name: string;
      object_type: string;
      required_approval_line: boolean;
      required_payment_line: boolean;
      definition: WorkflowDefinitionV1;
      action_allowlist: unknown[];
    };
    expect(request).toMatchObject({
      workflow_key: "leave_request.approval",
      display_name: "휴가 신청 승인",
      object_type: "leave_request",
      required_approval_line: true,
      required_payment_line: false,
      definition: {
        schema_version: "workflow.definition.v1",
        metadata: { object_type: "leave_request" },
        validation: { last_result: "valid" },
      },
    });
    expect(request.definition.graph.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining([
        "trigger.form_submission",
        "form.input",
        "task.approval",
        "condition.branch",
        "action.object_update",
        "action.notification",
        "action.audit_append",
        "end.state",
      ]),
    );
    expect(
      request.definition.graph.nodes.find((node) => node.type === "task.approval")
        ?.config,
    ).toMatchObject({
      assignee_rule: { fallback_role: "people.ops.manager" },
    });
    expect(request.definition.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_node_id: "node-condition",
          from_port: "approved",
          to_node_id: "node-approved-update",
        }),
      ]),
    );
    expect(request.action_allowlist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connector_key: "internal.approvals" }),
        expect.objectContaining({ connector_key: "internal.notifications" }),
      ]),
    );
    expect(
      await screen.findByText("워크플로 초안을 생성했습니다."),
    ).toBeInTheDocument();
  }, 15000);

  it("creates a fixed no-code policy decision draft from the equipment location template", async () => {
    installBaseHandlers();
    server.use(
      http.post("*/api/v1/workflow-studio/definitions", async ({ request }) => {
        const body = await request.json();
        createRequests.push(body);
        return HttpResponse.json({
          ...baseDefinition,
          id: "55555555-5555-4555-8555-555555555555",
          workflow_key: (body as { workflow_key: string }).workflow_key,
          display_name: (body as { display_name: string }).display_name,
          object_type: (body as { object_type: string }).object_type,
          definition: (body as { definition: unknown }).definition,
          required_approval_line: true,
          approval_line: [
            {
              step_key: "policy_owner",
              approver_role: "MAINTENANCE_MANAGER",
              required: true,
            },
          ],
          action_allowlist: [
            {
              connector_key: "internal.audit",
              action_key: "append_timeline_event",
            },
          ],
        });
      }),
    );

    renderApp();

    await userEvent.click(
      await screen.findByRole("button", { name: "장비·위치 접근 정책" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "초안 생성" }));

    await waitFor(() => {
      expect(createRequests).toHaveLength(1);
    });
    expect(createRequests[0]).toMatchObject({
      workflow_key: "equipment.equipment_location_access_policy",
      display_name: "장비·위치 접근 정책",
      object_type: "equipment",
      required_approval_line: true,
      required_payment_line: false,
      definition: {
        schema_version: "workflow.definition.v1",
        policy_decision: {
          template_key: "equipment_location_access",
          effect: "allow",
          action: "maintenance:StartWorkOrder",
          resource: { type: "equipment", id: "EQ-BOILER-17" },
          context: expect.objectContaining({
            subject_role: "MAINTENANCE_MANAGER",
            passkey_step_up_satisfied: true,
          }),
          scope: {
            org_id: "org_demo_001",
            location_id: "loc_plant_2",
          },
          requirements: {
            passkey_step_up: true,
            audit_event: "workflow_definition.publish",
          },
        },
      },
      approval_line: [
        {
          step_key: "policy_owner",
          approver_role: "MAINTENANCE_MANAGER",
          required: true,
        },
      ],
      action_allowlist: [
        {
          connector_key: "internal.audit",
          action_key: "append_timeline_event",
        },
      ],
      notification_rules: [],
    });
  });

  it("resets policy fields when switching back to a standard catalog template", async () => {
    installBaseHandlers();
    server.use(
      http.post("*/api/v1/workflow-studio/definitions", async ({ request }) => {
        const body = await request.json();
        createRequests.push(body);
        return HttpResponse.json({
          ...baseDefinition,
          id: "66666666-6666-4666-8666-666666666666",
          workflow_key: (body as { workflow_key: string }).workflow_key,
          display_name: (body as { display_name: string }).display_name,
          object_type: (body as { object_type: string }).object_type,
          definition: (body as { definition: unknown }).definition,
          approval_line: (body as { approval_line: unknown }).approval_line,
          action_allowlist: (body as { action_allowlist: unknown })
            .action_allowlist,
        });
      }),
    );

    renderApp();

    await userEvent.click(
      await screen.findByRole("button", { name: "장비·위치 접근 정책" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "정비 완료 승인" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "초안 생성" }));

    await waitFor(() => {
      expect(createRequests).toHaveLength(1);
    });
    expect(createRequests[0]).toMatchObject({
      workflow_key: "work_order.maintenance_completion_approval",
      definition: {
        schema_version: "workflow.definition.v1",
        template_key: "maintenance_completion_approval",
        object_type: "work_order",
        trigger: "work_order.maintenance_completion_approval",
      },
      approval_line: [
        { step_key: "manager", approver_role: "MANAGER", required: true },
      ],
      action_allowlist: expect.arrayContaining([
        { connector_key: "internal.approvals", action_key: "request_approval" },
      ]),
      notification_rules: [
        {
          event: "approved",
          connector_key: "internal.notifications",
          action_key: "send_push",
        },
      ],
    });
    expect(
      (createRequests[0] as { definition: Record<string, unknown> }).definition,
    ).not.toHaveProperty("policy_decision");
  });

  it("updates a draft from the canvas authoring form", async () => {
    installBaseHandlers();
    server.use(
      http.patch(
        "*/api/v1/workflow-studio/definitions/:id",
        async ({ request }) => {
          const body = await request.json();
          updateRequests.push(body);
          return HttpResponse.json({
            ...baseDefinition,
            ...(body as object),
            latest_version: 2,
          });
        },
      ),
    );

    renderApp();

    const row = await screen.findByRole("row", { name: /작업 완료 승인/ });
    await userEvent.click(within(row).getByRole("button", { name: "편집" }));
    await userEvent.clear(screen.getByLabelText("이름"));
    await userEvent.type(screen.getByLabelText("이름"), "작업 완료 승인 수정");
    await userEvent.click(screen.getByRole("button", { name: "초안 저장" }));

    await waitFor(() => {
      expect(updateRequests).toHaveLength(1);
    });
    expect(updateRequests[0]).toMatchObject({
      display_name: "작업 완료 승인 수정",
      required_approval_line: false,
      required_payment_line: false,
      definition: {},
      approval_line: [],
      payment_line: [],
      notification_rules: [],
      action_allowlist: [],
    });
    expect(
      (updateRequests[0] as { workflow_key?: unknown }).workflow_key,
    ).toBeUndefined();
    expect(
      await screen.findByText("워크플로 초안을 저장했습니다."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("이름")).toHaveValue("작업 완료 승인 수정");
    expect(
      screen.queryByRole("button", { name: "편집 취소" }),
    ).not.toBeInTheDocument();
  });

  it("archives a draft with passkey step-up and selects remaining history", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let archived = false;
    const historyRequests: string[] = [];
    server.use(
      http.get("*/api/v1/workflow-studio/catalog", () =>
        HttpResponse.json(catalogResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({
          items: archived
            ? [secondaryDefinition]
            : [baseDefinition, secondaryDefinition],
        }),
      ),
      http.get(
        "*/api/v1/workflow-studio/definitions/:id/history",
        ({ params }) => {
          const definitionId = String(params.id);
          historyRequests.push(definitionId);
          return HttpResponse.json(
            definitionId === secondaryDefinition.id
              ? secondaryHistoryResponse
              : historyResponse,
          );
        },
      ),
      http.delete(
        "*/api/v1/workflow-studio/definitions/:id",
        async ({ request }) => {
          const body = await request.json();
          archiveRequests.push(body);
          archived = true;
          return HttpResponse.json({ ...baseDefinition, status: "RETIRED" });
        },
      ),
    );

    renderApp();

    const row = await screen.findByRole("row", { name: /작업 완료 승인/ });
    await userEvent.click(within(row).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledTimes(1);
    });
    expect(confirmSpy).toHaveBeenCalledWith(
      "이 초안을 삭제하시겠습니까? 변경 이력은 감사 목적으로 보존됩니다.",
    );
    expect(archiveRequests).toEqual([{ step_up: mockStepUpAssertion }]);
    expect(
      await screen.findByText("워크플로 초안을 삭제했습니다."),
    ).toBeInTheDocument();
    expect(screen.queryByText("작업 완료 승인")).not.toBeInTheDocument();
    const remainingRow = screen.getByRole("row", { name: /안전 점검 승인/ });
    expect(remainingRow).toHaveClass("bg-signal/10");
    expect(await screen.findByText("안전 점검 초안 생성")).toBeInTheDocument();
    expect(historyRequests).toContain(secondaryDefinition.id);

    confirmSpy.mockRestore();
  });

  it("blocks saving when edited draft metadata would make the canonical graph inconsistent", async () => {
    installBaseHandlers();
    server.use(
      http.post("*/api/v1/workflow-studio/definitions", async ({ request }) => {
        createRequests.push(await request.json());
        return HttpResponse.json({
          ...baseDefinition,
          id: "33333333-3333-4333-8333-333333333333",
        });
      }),
    );

    renderApp();

    expect(await screen.findByRole("heading", { name: "워크플로 캔버스" })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "휴가 신청 승인 템플릿 사용" }),
    );
    const objectTypeInput = await screen.findByLabelText("업무 객체");
    await userEvent.clear(objectTypeInput);
    await userEvent.type(objectTypeInput, "work_order");
    await userEvent.click(screen.getByRole("button", { name: "초안 생성" }));

    expect(
      await screen.findByText("캔버스 검증 오류를 해결하면 저장할 수 있습니다."),
    ).toBeInTheDocument();
    expect(createRequests).toHaveLength(0);
  }, 15000);

  it("flags invalid edge attempts and disables save for invalid canvas drafts", async () => {
    installBaseHandlers();

    renderApp();

    expect(await screen.findByRole("heading", { name: "워크플로 캔버스" })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "노드 추가: Form submission trigger" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "노드 추가: End state" }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("연결 시작 노드"),
      "node-end",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("연결 대상 노드"),
      "node-trigger",
    );
    await userEvent.click(screen.getByRole("button", { name: "연결 추가" }));

    expect(
      await screen.findByText(
        "Select compatible source and target ports before connecting.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "초안 생성" })).toBeDisabled();
    expect(
      screen.getByText("Leave request submitted requires a Submitted connection."),
    ).toBeInTheDocument();
  });

  it("lets users choose branch ports when connecting a blank no-code canvas", async () => {
    installBaseHandlers();

    renderApp();

    expect(
      await screen.findByRole(
        "heading",
        { name: "워크플로 스튜디오" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "워크플로 캔버스" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "빈 캔버스 시작" }));
    await userEvent.click(
      screen.getByRole("button", { name: "노드 추가: Approval result condition" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "노드 추가: End state" }));

    await userEvent.selectOptions(
      screen.getByLabelText("연결 시작 노드"),
      "node-condition",
    );
    await userEvent.selectOptions(screen.getByLabelText("연결 시작 포트"), "rejected");
    await userEvent.selectOptions(
      screen.getByLabelText("연결 대상 노드"),
      "node-end",
    );
    await userEvent.selectOptions(screen.getByLabelText("연결 대상 포트"), "in");
    await userEvent.click(screen.getByRole("button", { name: "연결 추가" }));

    expect(
      await screen.findByText("node-condition:rejected → node-end:in"),
    ).toBeInTheDocument();
    expect(screen.queryByText("node-condition:approved → node-end:in")).not.toBeInTheDocument();
  }, 15000);

  it("blocks publishing invalid canonical graphs before passkey step-up", async () => {
    const invalidDefinition = createEmptyWorkflowDefinition({
      name: "Invalid workflow",
      objectType: "leave_request",
    });
    invalidDefinition.graph.nodes.push(createWorkflowNode("trigger.form_submission"));
    server.use(
      http.get("*/api/v1/workflow-studio/catalog", () =>
        HttpResponse.json(catalogResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({
          items: [
            {
              ...baseDefinition,
              definition: invalidDefinition,
              required_approval_line: true,
              approval_line: [
                { step_key: "admin", approver_role: "ADMIN", required: true },
              ],
            },
          ],
        }),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/history", () =>
        HttpResponse.json(historyResponse),
      ),
      http.post("*/api/v1/workflow-studio/definitions/:id/publish", async ({ request }) => {
        publishRequests.push(await request.json());
        return HttpResponse.json({}, { status: 500 });
      }),
    );

    renderApp();

    const row = await screen.findByRole("row", { name: /작업 완료 승인/ });
    await userEvent.click(within(row).getByRole("button", { name: "게시" }));

    expect(
      await screen.findByText("캔버스 검증 오류를 해결해야 게시할 수 있습니다."),
    ).toBeInTheDocument();
    expect(mockAssertPasskeyStepUp).not.toHaveBeenCalled();
    expect(publishRequests).toHaveLength(0);
  });

  it("blocks publish without approval and payment lines before passkey step-up", async () => {
    server.use(
      http.get("*/api/v1/workflow-studio/catalog", () =>
        HttpResponse.json(catalogResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({
          items: [
            {
              ...baseDefinition,
              required_approval_line: true,
              required_payment_line: true,
            },
          ],
        }),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/history", () =>
        HttpResponse.json(historyResponse),
      ),
      http.post(
        "*/api/v1/workflow-studio/definitions/:id/publish",
        async ({ request }) => {
          publishRequests.push(await request.json());
          return HttpResponse.json({}, { status: 500 });
        },
      ),
    );

    renderApp();

    const row = await screen.findByRole("row", { name: /작업 완료 승인/ });
    await userEvent.click(within(row).getByRole("button", { name: "게시" }));

    expect(
      await screen.findByText("승인라인과 결제라인을 먼저 지정해야 합니다."),
    ).toBeInTheDocument();
    expect(mockAssertPasskeyStepUp).not.toHaveBeenCalled();
    expect(publishRequests).toHaveLength(0);
  });

  it("publishes with passkey step-up and keeps append-only history visible", async () => {
    installBaseHandlers();
    server.use(
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({
          items: [
            {
              ...baseDefinition,
              required_approval_line: true,
              approval_line: [
                { step_key: "admin", approver_role: "ADMIN", required: true },
              ],
            },
          ],
        }),
      ),
      http.post(
        "*/api/v1/workflow-studio/definitions/:id/publish",
        async ({ request }) => {
          publishRequests.push(await request.json());
          return HttpResponse.json({
            ...baseDefinition,
            status: "ACTIVE",
            latest_version: 2,
            active_version: 2,
          });
        },
      ),
    );

    renderApp();

    const row = await screen.findByRole("row", { name: /작업 완료 승인/ });
    await userEvent.click(within(row).getByRole("button", { name: "게시" }));

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledTimes(1);
    });
    expect(publishRequests).toEqual([{ step_up: mockStepUpAssertion }]);
    expect(
      await screen.findByText("워크플로를 게시했습니다."),
    ).toBeInTheDocument();
  });

  it("requires passkey step-up for pause rollback and clone lifecycle actions", async () => {
    const activeDefinition = {
      ...baseDefinition,
      status: "ACTIVE",
      latest_version: 2,
      active_version: 2,
      required_approval_line: true,
      approval_line: [
        { step_key: "admin", approver_role: "ADMIN", required: true },
      ],
    };
    server.use(
      http.get("*/api/v1/workflow-studio/catalog", () =>
        HttpResponse.json(catalogResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({ items: [activeDefinition] }),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/history", () =>
        HttpResponse.json(historyResponse),
      ),
      http.post(
        "*/api/v1/workflow-studio/definitions/:id/pause",
        async ({ request }) => {
          lifecycleRequests.push({
            action: "pause",
            body: await request.json(),
          });
          return HttpResponse.json({ ...activeDefinition, status: "PAUSED" });
        },
      ),
      http.post(
        "*/api/v1/workflow-studio/definitions/:id/rollback",
        async ({ request }) => {
          lifecycleRequests.push({
            action: "rollback",
            body: await request.json(),
          });
          return HttpResponse.json({
            ...activeDefinition,
            latest_version: 3,
            active_version: 3,
          });
        },
      ),
      http.post(
        "*/api/v1/workflow-studio/definitions/:id/clone",
        async ({ request }) => {
          lifecycleRequests.push({
            action: "clone",
            body: await request.json(),
          });
          return HttpResponse.json({
            ...activeDefinition,
            id: "44444444-4444-4444-8444-444444444444",
            workflow_key: "work_order.completion_review.copy",
            display_name: "작업 완료 승인 복제본",
            status: "DRAFT",
            latest_version: 1,
            active_version: null,
          });
        },
      ),
    );

    renderApp();

    const row = await screen.findByRole("row", { name: /작업 완료 승인/ });
    await userEvent.click(within(row).getByRole("button", { name: "정지" }));
    await userEvent.click(within(row).getByRole("button", { name: "롤백" }));
    await userEvent.click(within(row).getByRole("button", { name: "복제" }));

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledTimes(3);
    });
    expect(lifecycleRequests.map((request) => request.action)).toEqual([
      "pause",
      "rollback",
      "clone",
    ]);
    expect(lifecycleRequests[1]?.body).toMatchObject({
      target_version: 2,
      step_up: mockStepUpAssertion,
    });
    expect(lifecycleRequests[2]?.body).toMatchObject({
      display_name: "작업 완료 승인 복제본",
      step_up: mockStepUpAssertion,
    });
  });
});
