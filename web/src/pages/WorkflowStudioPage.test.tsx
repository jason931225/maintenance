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

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { WorkflowStudioPage } from "./WorkflowStudioPage";

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
const runRequests: unknown[] = [];

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

beforeEach(() => {
  publishRequests.length = 0;
  createRequests.length = 0;
  updateRequests.length = 0;
  archiveRequests.length = 0;
  lifecycleRequests.length = 0;
  runRequests.length = 0;
  mockAssertPasskeyStepUp.mockResolvedValue(mockStepUpAssertion);
  server.use(
    http.get("*/api/v1/workflow-studio/schedules", () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get("*/api/v1/workflow-studio/definitions/:id/run-log", () =>
      HttpResponse.json({ items: [] }),
    ),
  );
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
        <WorkflowStudioPage />
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

const executableDefinition = {
  ...baseDefinition,
  id: "77777777-7777-4777-8777-777777777777",
  workflow_key: "work_order.exec_approval",
  display_name: "실행 그래프 승인",
  status: "ACTIVE",
  latest_version: 2,
  active_version: 2,
  updated_at: "2026-06-29T10:30:00Z",
  definition: {
    schema_version: "wf.exec.v1",
    metadata: { object_type: "work_order" },
    graph: {
      nodes: [
        {
          id: "node-trigger",
          key: "submitted",
          type: "trigger.form_submission",
          config: {
            type: "trigger.form_submission",
            label: "근태 이벤트",
            source: { object_type: "work_order", event: "submitted", scope: "org" },
          },
          input_ports: [],
          output_ports: [],
        },
        {
          id: "node-condition",
          key: "approval_result",
          type: "condition.branch",
          config: {
            type: "condition.branch",
            label: "승인 조건",
            expression: { left: { ref: "approval.result" }, op: "equals", right: "approved" },
            branches: [
              { port: "approved", label: "승인", when: "true" },
              { port: "rejected", label: "반려", when: "false" },
            ],
            default_port: "rejected",
          },
          input_ports: [],
          output_ports: [],
        },
        {
          id: "node-action",
          key: "notify",
          type: "action.notification",
          config: {
            type: "action.notification",
            label: "알림 발송",
            connector_key: "internal.notifications",
            action_key: "send_push",
          },
          input_ports: [],
          output_ports: [],
        },
      ],
      edges: [],
    },
  },
};

const scheduledDefinition = {
  ...executableDefinition,
  id: "88888888-8888-4888-8888-888888888888",
  workflow_key: "work_order.scheduled_reminder",
  display_name: "근태 마감 예약",
  status: "DRAFT",
  latest_version: 1,
  active_version: null,
  definition: {
    ...executableDefinition.definition,
    schedule: {
      name: "근태 마감 리마인더",
      active: true,
      cron: "0 17 * * *",
      cron_label: "매일 17:00",
      next_run_at: "2026-07-09T08:00:00Z",
      last_run_at: "2026-07-08T08:00:00Z",
    },
  },
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

const runLogResponse = {
  items: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      code: "RUN-001",
      definition_id: baseDefinition.id,
      definition_version: 2,
      trigger_type: "MANUAL",
      status: "FAILED",
      actor_display_name: "자동화 엔진",
      summary: "승인 객체 생성 실패",
      error_message: "connector timeout",
      generated_objects: ["AP-184"],
      started_at: "2026-07-09T08:10:00Z",
      updated_at: "2026-07-09T08:11:00Z",
      completed_at: null,
      failed_at: "2026-07-09T08:11:00Z",
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
    http.get("*/api/v1/workflow-studio/definitions/:id/run-log", () =>
      HttpResponse.json(runLogResponse),
    ),
  );
}

describe("WorkflowStudioPage", () => {
  it("loads workflow definitions, connector allowlist, authoring, and change history", async () => {
    installBaseHandlers();

    renderApp();

    expect(
      await screen.findByRole("heading", { name: "워크플로 스튜디오" }),
    ).toBeInTheDocument();
    expect((await screen.findAllByText("작업 완료 승인")).length).toBeGreaterThan(0);
    expect(screen.getByText("승인센터")).toBeInTheDocument();
    expect(screen.getByText("request_approval")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "초안 작성" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("초안 생성").length).toBeGreaterThan(0);
    expect(screen.queryByText("Workflow + Approval")).not.toBeInTheDocument();
  });

  it("renders read-only wf.exec.v1 trigger condition and branch blocks from the definitions endpoint", async () => {
    server.use(
      http.get("*/api/v1/workflow-studio/catalog", () =>
        HttpResponse.json(catalogResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({ items: [executableDefinition] }),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/history", () =>
        HttpResponse.json(historyResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/run-log", () =>
        HttpResponse.json(runLogResponse),
      ),
    );

    renderApp();

    expect((await screen.findAllByText("실행 그래프 승인")).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: "노코드 블록" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "근태 이벤트 블록" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "승인 조건 블록" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "승인 / 반려 블록" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "알림 발송 블록" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("wf.exec.v1").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("approval.result = approved")).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("rejected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "비활성화" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "수동 실행" })).toBeInTheDocument();
  });

  it("triggers an active workflow manually and refreshes the real run-log timeline", async () => {
    const triggeredRun = {
      ...runLogResponse.items[0],
      id: "99999999-9999-4999-8999-999999999999",
      code: "RUN-999",
      definition_id: executableDefinition.id,
      status: "SUCCEEDED",
      summary: "수동 실행 시작",
      completed_at: "2026-07-09T08:12:00Z",
      failed_at: null,
      error_message: null,
    };
    server.use(
      http.get("*/api/v1/workflow-studio/catalog", () =>
        HttpResponse.json(catalogResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({ items: [executableDefinition] }),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/history", () =>
        HttpResponse.json(historyResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/run-log", () =>
        HttpResponse.json({ items: [triggeredRun] }),
      ),
      http.post(
        "*/api/v1/workflow-studio/definitions/:id/run",
        async ({ request }) => {
          const body = await request.json();
          runRequests.push(body);
          return HttpResponse.json(triggeredRun);
        },
      ),
    );

    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: "수동 실행" }));

    await waitFor(() => {
      expect(runRequests).toHaveLength(1);
    });
    expect(runRequests[0]).toMatchObject({ trigger_type: "MANUAL" });
    expect(await screen.findByText("워크플로 수동 실행을 요청했습니다.")).toBeInTheDocument();
    expect(screen.getByText("수동 실행 시작")).toBeInTheDocument();
    expect(screen.getByText("RUN-999")).toBeInTheDocument();
  });

  it("renders wf.exec.v1 schedules from definitions with runtime schedule controls", async () => {
    const activeDefinition = {
      ...executableDefinition,
      status: "ACTIVE",
      latest_version: 2,
      active_version: 2,
    };
    server.use(
      http.get("*/api/v1/workflow-studio/catalog", () =>
        HttpResponse.json(catalogResponse),
      ),
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({ items: [activeDefinition, scheduledDefinition] }),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/history", () =>
        HttpResponse.json(historyResponse),
      ),
    );

    renderApp();

    expect((await screen.findAllByText("실행 그래프 승인")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "비활성화" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "예약 작업" }));
    expect((await screen.findAllByText("근태 마감 리마인더")).length).toBeGreaterThan(0);
    expect(screen.getByText("cron 0 17 * * *")).toBeInTheDocument();
    expect(screen.getByText("매일 17:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "예약 편집" })).toBeInTheDocument();
  });

  it("creates a draft from the authoring form with typed JSON mapping", async () => {
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

    await userEvent.click(
      await screen.findByRole("button", { name: "정비 완료 승인" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "초안 생성" }));

    await waitFor(() => {
      expect(createRequests).toHaveLength(1);
    });
    expect(createRequests[0]).toMatchObject({
      workflow_key: "work_order.maintenance_completion_approval",
      display_name: "정비 완료 승인",
      object_type: "work_order",
      required_approval_line: true,
      required_payment_line: false,
      definition: {
        schema_version: "workflow.definition.v1",
        template_key: "maintenance_completion_approval",
        object_type: "work_order",
        trigger: "work_order.maintenance_completion_approval",
        steps: [{ key: "review", type: "approval", source: "approval_line" }],
      },
    });
    expect(
      (createRequests[0] as { action_allowlist: unknown[] }).action_allowlist,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connector_key: "internal.approvals" }),
      ]),
    );
    expect(
      await screen.findByText("워크플로 초안을 생성했습니다."),
    ).toBeInTheDocument();
  });

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

  it("resets policy fields when switching back to a standard template", async () => {
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

  it("updates a draft from the authoring form", async () => {
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
    expect(screen.getByLabelText("이름")).toHaveValue("작업 완료 승인");
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
    expect((await screen.findAllByText("안전 점검 초안 생성")).length).toBeGreaterThan(0);
    expect(historyRequests).toContain(secondaryDefinition.id);

    confirmSpy.mockRestore();
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
        HttpResponse.json({ items: [activeDefinition, scheduledDefinition] }),
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
