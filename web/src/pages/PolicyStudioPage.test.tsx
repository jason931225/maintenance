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

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
beforeEach(() => {
  mockAssertPasskeyStepUp.mockResolvedValue(mockStepUpAssertion);
});
afterEach(() => {
  server.resetHandlers();
  mockAssertPasskeyStepUp.mockReset();
});
afterAll(() => {
  server.close();
});

const features = [
  {
    feature_key: "work_order_create",
    elevated: false,
    default_permissions: [
      { role_key: "SUPER_ADMIN", permission_level: "allow" },
    ],
  },
  {
    feature_key: "daily_plan_review",
    elevated: false,
    default_permissions: [
      { role_key: "SUPER_ADMIN", permission_level: "allow" },
    ],
  },
  {
    feature_key: "role_manage",
    elevated: true,
    default_permissions: [
      { role_key: "SUPER_ADMIN", permission_level: "allow" },
    ],
  },
];

const roleTemplates = [
  {
    template_key: "dispatch_reception",
    role_key: "dispatch_reception",
    display_name: "접수·배차 코디네이터",
    category: "operations",
    description: "접수와 배차 보조를 담당합니다.",
    permissions: [
      { feature_key: "work_order_create", permission_level: "allow" },
      { feature_key: "daily_plan_review", permission_level: "limited" },
    ],
  },
];

const emptyCatalog = {
  policy_version: {
    version: 0,
    updated_at: null,
  },
  system_roles: [
    {
      role_key: "SUPER_ADMIN",
      display_name: "SUPER_ADMIN",
      status: "ACTIVE",
      is_system: true,
      permissions: [{ feature_key: "role_manage", permission_level: "allow" }],
    },
  ],
  custom_roles: [],
};

const userPage = {
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      display_name: "고민서",
      phone: null,
      team: "MAINTENANCE",
      roles: ["MECHANIC"],
      branch_ids: [],
      is_active: true,
      has_passkey: true,
      account_status: "ACTIVE",
      created_at: "2026-06-26T00:00:00Z",
    },
  ],
  limit: 200,
  offset: 0,
  total: 1,
};

const twoUserPage = {
  ...userPage,
  items: [
    ...userPage.items,
    {
      id: "55555555-5555-4555-8555-555555555555",
      display_name: "홍길동",
      phone: null,
      team: "RECEPTION",
      roles: ["RECEPTIONIST"],
      branch_ids: [],
      is_active: true,
      has_passkey: true,
      account_status: "ACTIVE",
      created_at: "2026-06-26T00:00:00Z",
    },
  ],
  total: 2,
};

const catalogWithCustomRole = {
  ...emptyCatalog,
  policy_version: {
    version: 3,
    updated_at: "2026-06-26T00:00:00Z",
  },
  custom_roles: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      role_key: "maintenance_manager",
      display_name: "정비 관리자",
      description: "정비팀 관리자",
      status: "DRAFT",
      is_system: false,
      permissions: [
        { feature_key: "work_order_create", permission_level: "allow" },
      ],
      conditions: [
        {
          condition_key: "department_1",
          attribute: "department",
          operator: "in",
          values: ["정비팀", "야간조"],
        },
      ],
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z",
    },
  ],
};

const policyAuditEvents = [
  {
    id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    actor: "33333333-3333-4333-8333-333333333333",
    action: "policy.role.create",
    target_type: "policy_role",
    target_id: "22222222-2222-4222-8222-222222222222",
    before_snapshot: null,
    after_snapshot: {
      role_key: "maintenance_manager",
      display_name: "정비 관리자",
      status: "DRAFT",
    },
    trace_id: "11111111111111111111111111111111",
    span_id: "2222222222222222",
    occurred_at: "2026-06-26T00:00:00Z",
  },
  {
    id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
    actor: "33333333-3333-4333-8333-333333333333",
    action: "policy.role_assignment.replace.snapshot",
    target_type: "policy_role_assignment",
    target_id: "11111111-1111-4111-8111-111111111111",
    before_snapshot: { assignments: [] },
    after_snapshot: {
      assignments: [
        {
          role_key: "maintenance_manager",
          display_name: "정비 관리자",
        },
      ],
    },
    trace_id: "33333333333333333333333333333333",
    span_id: "4444444444444444",
    occurred_at: "2026-06-26T00:02:00Z",
  },
];

const superAdminSession: AuthSession = {
  access_token: "a",
  roles: ["SUPER_ADMIN"],
};

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api,
  };
}

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("PolicyStudioPage", () => {
  it("creates a tenant custom role from the feature catalog", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () => HttpResponse.json(emptyCatalog)),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.post("*/api/v1/policy/roles", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          {
            id: "99999999-9999-4999-8999-999999999999",
            role_key: "maintenance_manager",
            display_name: "정비 관리자",
            description: "정비팀 관리자",
            status: "DRAFT",
            is_system: false,
            permissions: [
              { feature_key: "work_order_create", permission_level: "allow" },
            ],
            conditions: [
              {
                condition_key: "department_1",
                attribute: "department",
                operator: "in",
                values: ["정비팀", "야간조"],
              },
            ],
            created_at: "2026-06-26T00:00:00Z",
            updated_at: "2026-06-26T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    expect(
      await screen.findByRole("heading", { name: "권한 정책" }),
    ).toBeVisible();
    expect(await screen.findByText("역할 정책 관리")).toBeVisible();
    expect(screen.getByText("상승 권한")).toBeVisible();

    await user.type(screen.getByLabelText("역할 키"), "maintenance_manager");
    await user.type(screen.getByLabelText("표시 이름"), "정비 관리자");
    await user.type(screen.getByLabelText("설명"), "정비팀 관리자");
    await user.click(screen.getByLabelText("작업 생성"));
    await user.click(screen.getByRole("button", { name: "조건 추가" }));
    await user.selectOptions(screen.getByLabelText("조건 연산자 1"), "in");
    await user.type(screen.getByLabelText("조건 값 1"), "정비팀, 야간조");
    await user.click(screen.getByRole("button", { name: "역할 만들기" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({
        role_key: "maintenance_manager",
        display_name: "정비 관리자",
        description: "정비팀 관리자",
        permissions: [
          { feature_key: "work_order_create", permission_level: "allow" },
        ],
        conditions: [
          {
            condition_key: "department_1",
            attribute: "department",
            operator: "in",
            values: ["정비팀", "야간조"],
          },
        ],
      });
    });
  });

  it("copies a safe starter template into the custom role create form", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () => HttpResponse.json(emptyCatalog)),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.post("*/api/v1/policy/roles", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          {
            id: "99999999-9999-4999-8999-999999999999",
            role_key: "dispatch_reception",
            display_name: "접수·배차 코디네이터",
            description: "접수와 배차 보조를 담당합니다.",
            status: "DRAFT",
            is_system: false,
            permissions: roleTemplates[0].permissions,
            conditions: [],
            created_at: "2026-06-26T00:00:00Z",
            updated_at: "2026-06-26T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    const templateSelect = await screen.findByLabelText("시작 템플릿");
    await screen.findByRole("option", {
      name: "접수·배차 코디네이터 · 운영",
    });
    await user.selectOptions(templateSelect, "dispatch_reception");
    expect(screen.getByLabelText("역할 키")).toHaveValue("dispatch_reception");
    expect(screen.getByLabelText("표시 이름")).toHaveValue(
      "접수·배차 코디네이터",
    );
    expect(screen.getByLabelText("설명")).toHaveValue(
      "접수와 배차 보조를 담당합니다.",
    );
    expect(screen.getByLabelText("작업 생성")).toBeChecked();
    expect(screen.getByLabelText("계획업무 승인")).toBeChecked();
    expect(screen.queryByLabelText("역할 정책 관리")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "역할 만들기" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({
        role_key: "dispatch_reception",
        display_name: "접수·배차 코디네이터",
        description: "접수와 배차 보조를 담당합니다.",
        permissions: [
          { feature_key: "work_order_create", permission_level: "allow" },
          { feature_key: "daily_plan_review", permission_level: "limited" },
        ],
      });
    });
  });

  it("keeps elevated features out of the role creation checklist", async () => {
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () => HttpResponse.json(emptyCatalog)),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));
    const form = await screen.findByRole("button", { name: "역할 만들기" });
    const card = form.closest("aside");
    expect(card).not.toBeNull();
    expect(
      await within(card as HTMLElement).findByLabelText("작업 생성"),
    ).toBeVisible();
    expect(
      within(card as HTMLElement).queryByLabelText("역할 정책 관리"),
    ).not.toBeInTheDocument();
  });

  it("publishes a draft custom role only after passkey step-up", async () => {
    const user = userEvent.setup();
    const previewed = vi.fn();
    const patched = vi.fn();
    let resolveStepUp:
      | ((value: typeof mockStepUpAssertion) => void)
      | undefined;
    mockAssertPasskeyStepUp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStepUp = resolve;
        }),
    );
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () =>
        HttpResponse.json(catalogWithCustomRole),
      ),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.post(
        "*/api/v1/policy/roles/:id/status-preview",
        async ({ params, request }) => {
          previewed({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            role_id: "22222222-2222-4222-8222-222222222222",
            role_key: "maintenance_manager",
            display_name: "정비 관리자",
            current_status: "DRAFT",
            requested_status: "ACTIVE",
            permission_count: 1,
            condition_count: 1,
            planned_assignment_count: 1,
            requires_passkey_step_up: true,
            effective_runtime_change: true,
            warnings: [
              "passkey_step_up_required",
              "assigned_users_may_gain_or_lose_runtime_permissions",
              "publish_enables_assigned_custom_role_runtime_grants",
            ],
          });
        },
      ),
      http.patch(
        "*/api/v1/policy/roles/:id/status",
        async ({ params, request }) => {
          patched({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            ...catalogWithCustomRole.custom_roles[0],
            status: "ACTIVE",
            updated_at: "2026-06-26T00:01:00Z",
          });
        },
      ),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    expect(await screen.findByText("정비 관리자")).toBeVisible();
    expect(screen.getByLabelText("정책 버전")).toBeVisible();
    expect(screen.getByText("v3")).toBeVisible();
    expect(screen.getByText("마지막 정책 변경 2026-06-26 09:00")).toBeVisible();
    expect(screen.getByText("1개 조건")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "게시(패스키)" }));

    await waitFor(() => {
      expect(previewed).toHaveBeenCalledWith({
        id: "22222222-2222-4222-8222-222222222222",
        body: { status: "ACTIVE" },
      });
    });
    const preview = await screen.findByLabelText("역할 상태 영향 미리보기");
    expect(within(preview).getByText("DRAFT → ACTIVE")).toBeVisible();
    expect(within(preview).getByText("권한 1개 · 조건 1개")).toBeVisible();
    expect(
      within(preview).getByText("다음 요청부터 권한이 변경됩니다."),
    ).toBeVisible();
    expect(
      within(preview).getByText(
        /게시하면 이미 배정된 사용자에게 지원되는 일반 기능 권한이 런타임에 반영됩니다/u,
      ),
    ).toBeVisible();
    expect(mockAssertPasskeyStepUp).not.toHaveBeenCalled();
    expect(patched).not.toHaveBeenCalled();
    await user.click(
      within(preview).getByRole("button", {
        name: "미리보기 확인 후 패스키로 변경",
      }),
    );
    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledOnce();
    });
    expect(patched).not.toHaveBeenCalled();
    resolveStepUp?.(mockStepUpAssertion);

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        id: "22222222-2222-4222-8222-222222222222",
        body: { status: "ACTIVE", step_up: mockStepUpAssertion },
      });
    });
    expect(
      await screen.findByText("역할 상태가 업데이트되었습니다."),
    ).toBeVisible();
  });

  it("previews rollback runtime impact before passkey step-up", async () => {
    const user = userEvent.setup();
    const previewed = vi.fn();
    const patched = vi.fn();
    const activeCatalog = {
      ...catalogWithCustomRole,
      custom_roles: [
        { ...catalogWithCustomRole.custom_roles[0], status: "ACTIVE" },
      ],
    };
    let resolveStepUp:
      | ((value: typeof mockStepUpAssertion) => void)
      | undefined;
    mockAssertPasskeyStepUp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStepUp = resolve;
        }),
    );
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () => HttpResponse.json(activeCatalog)),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.post(
        "*/api/v1/policy/roles/:id/status-preview",
        async ({ params, request }) => {
          previewed({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            role_id: "22222222-2222-4222-8222-222222222222",
            role_key: "maintenance_manager",
            display_name: "정비 관리자",
            current_status: "ACTIVE",
            requested_status: "DRAFT",
            permission_count: 1,
            condition_count: 1,
            planned_assignment_count: 2,
            requires_passkey_step_up: true,
            effective_runtime_change: true,
            warnings: [
              "passkey_step_up_required",
              "assigned_users_may_gain_or_lose_runtime_permissions",
              "rollback_disables_assigned_custom_role_runtime_grants",
            ],
          });
        },
      ),
      http.patch(
        "*/api/v1/policy/roles/:id/status",
        async ({ params, request }) => {
          patched({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            ...activeCatalog.custom_roles[0],
            status: "DRAFT",
            updated_at: "2026-06-26T00:02:00Z",
          });
        },
      ),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    expect(await screen.findByText("정비 관리자")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "초안으로 되돌리기(패스키)" }),
    );

    await waitFor(() => {
      expect(previewed).toHaveBeenCalledWith({
        id: "22222222-2222-4222-8222-222222222222",
        body: { status: "DRAFT" },
      });
    });
    const preview = await screen.findByLabelText("역할 상태 영향 미리보기");
    expect(within(preview).getByText("ACTIVE → DRAFT")).toBeVisible();
    expect(within(preview).getByText("2명")).toBeVisible();
    expect(
      within(preview).getByText("다음 요청부터 권한이 변경됩니다."),
    ).toBeVisible();
    expect(
      within(preview).getByText(/다시 게시해야 반영됩니다/u),
    ).toBeVisible();
    expect(mockAssertPasskeyStepUp).not.toHaveBeenCalled();
    expect(patched).not.toHaveBeenCalled();
    await user.click(
      within(preview).getByRole("button", {
        name: "미리보기 확인 후 패스키로 변경",
      }),
    );
    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledOnce();
    });
    expect(patched).not.toHaveBeenCalled();
    resolveStepUp?.(mockStepUpAssertion);

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        id: "22222222-2222-4222-8222-222222222222",
        body: { status: "DRAFT", step_up: mockStepUpAssertion },
      });
    });
  });

  it("previews retire runtime impact before passkey step-up", async () => {
    const user = userEvent.setup();
    const previewed = vi.fn();
    const patched = vi.fn();
    const activeCatalog = {
      ...catalogWithCustomRole,
      custom_roles: [
        { ...catalogWithCustomRole.custom_roles[0], status: "ACTIVE" },
      ],
    };
    let resolveStepUp:
      | ((value: typeof mockStepUpAssertion) => void)
      | undefined;
    mockAssertPasskeyStepUp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStepUp = resolve;
        }),
    );
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () => HttpResponse.json(activeCatalog)),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.post(
        "*/api/v1/policy/roles/:id/status-preview",
        async ({ params, request }) => {
          previewed({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            role_id: "22222222-2222-4222-8222-222222222222",
            role_key: "maintenance_manager",
            display_name: "정비 관리자",
            current_status: "ACTIVE",
            requested_status: "RETIRED",
            permission_count: 1,
            condition_count: 1,
            planned_assignment_count: 2,
            requires_passkey_step_up: true,
            effective_runtime_change: true,
            warnings: [
              "passkey_step_up_required",
              "assigned_users_may_gain_or_lose_runtime_permissions",
              "retire_disables_assigned_custom_role_runtime_grants",
            ],
          });
        },
      ),
      http.patch(
        "*/api/v1/policy/roles/:id/status",
        async ({ params, request }) => {
          patched({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            ...activeCatalog.custom_roles[0],
            status: "RETIRED",
            updated_at: "2026-06-26T00:02:00Z",
          });
        },
      ),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    expect(await screen.findByText("정비 관리자")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "퇴역(패스키)" }));

    await waitFor(() => {
      expect(previewed).toHaveBeenCalledWith({
        id: "22222222-2222-4222-8222-222222222222",
        body: { status: "RETIRED" },
      });
    });
    const preview = await screen.findByLabelText("역할 상태 영향 미리보기");
    expect(within(preview).getByText("ACTIVE → RETIRED")).toBeVisible();
    expect(
      within(preview).getByText(/퇴역하면 이 역할 배정의 런타임 권한/u),
    ).toBeVisible();
    expect(mockAssertPasskeyStepUp).not.toHaveBeenCalled();
    expect(patched).not.toHaveBeenCalled();

    await user.click(
      within(preview).getByRole("button", {
        name: "미리보기 확인 후 패스키로 변경",
      }),
    );
    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledOnce();
    });
    expect(patched).not.toHaveBeenCalled();
    resolveStepUp?.(mockStepUpAssertion);

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        id: "22222222-2222-4222-8222-222222222222",
        body: { status: "RETIRED", step_up: mockStepUpAssertion },
      });
    });
  });

  it("edits a custom role definition only after passkey step-up", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    let currentCatalog = catalogWithCustomRole;
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () =>
        HttpResponse.json(currentCatalog),
      ),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.patch("*/api/v1/policy/roles/:id", async ({ params, request }) => {
        const body = await request.json();
        patched({ id: params.id, body });
        const updatedRole = {
          ...catalogWithCustomRole.custom_roles[0],
          display_name: "정비 승인 관리자",
          description: "정비 승인과 계획 검토 담당",
          permissions: [
            { feature_key: "work_order_create", permission_level: "allow" },
            { feature_key: "daily_plan_review", permission_level: "allow" },
          ],
          conditions: [
            {
              condition_key: "department_1",
              attribute: "department",
              operator: "in",
              values: ["정비팀"],
            },
          ],
          updated_at: "2026-06-26T00:03:00Z",
        };
        currentCatalog = {
          ...catalogWithCustomRole,
          custom_roles: [updatedRole],
        };
        return HttpResponse.json(updatedRole);
      }),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    expect(await screen.findByText("정비 관리자")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "편집" }));

    const formHeading = await screen.findByRole("heading", {
      name: "사용자 지정 역할 편집",
    });
    const form = formHeading.closest("aside");
    expect(form).not.toBeNull();
    const scopedForm = within(form as HTMLElement);
    expect(scopedForm.getByText(/역할 키는 감사/u)).toBeVisible();
    expect(scopedForm.getByLabelText("역할 키")).toBeDisabled();
    expect(scopedForm.queryByLabelText("시작 템플릿")).not.toBeInTheDocument();

    await user.clear(scopedForm.getByLabelText("표시 이름"));
    await user.type(scopedForm.getByLabelText("표시 이름"), "정비 승인 관리자");
    await user.clear(scopedForm.getByLabelText("설명"));
    await user.type(
      scopedForm.getByLabelText("설명"),
      "정비 승인과 계획 검토 담당",
    );
    await user.click(scopedForm.getByLabelText("계획업무 승인"));
    await user.clear(scopedForm.getByLabelText("조건 값 1"));
    await user.type(scopedForm.getByLabelText("조건 값 1"), "정비팀");
    await user.click(
      scopedForm.getByRole("button", { name: "변경 저장(패스키)" }),
    );

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledOnce();
      expect(patched).toHaveBeenCalledWith({
        id: "22222222-2222-4222-8222-222222222222",
        body: {
          display_name: "정비 승인 관리자",
          description: "정비 승인과 계획 검토 담당",
          permissions: [
            { feature_key: "work_order_create", permission_level: "allow" },
            { feature_key: "daily_plan_review", permission_level: "allow" },
          ],
          conditions: [
            {
              condition_key: "department_1",
              attribute: "department",
              operator: "in",
              values: ["정비팀"],
            },
          ],
          step_up: mockStepUpAssertion,
        },
      });
    });
    expect(
      await screen.findByText("사용자 지정 역할을 업데이트했습니다."),
    ).toBeVisible();
    expect(await screen.findByText("정비 승인 관리자")).toBeVisible();
  });

  it("saves custom-role assignments with passkey-gated runtime impact", async () => {
    const user = userEvent.setup();
    const previewed = vi.fn();
    const replaced = vi.fn();
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () =>
        HttpResponse.json(catalogWithCustomRole),
      ),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage)),
      http.get("*/api/v1/policy/assignments", () => HttpResponse.json([])),
      http.post(
        "*/api/v1/policy/users/:id/assignment-preview",
        async ({ request }) => {
          previewed(await request.json());
          return HttpResponse.json({
            user_id: "11111111-1111-4111-8111-111111111111",
            preview_receipt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            preview_receipt_expires_at: "2026-06-26T00:10:00Z",
            effective: false,
            system_roles: ["MECHANIC"],
            current_role_ids: [],
            requested_role_ids: ["22222222-2222-4222-8222-222222222222"],
            delta: {
              added_role_ids: ["22222222-2222-4222-8222-222222222222"],
              removed_role_ids: [],
              unchanged_role_ids: [],
            },
            custom_roles: [
              {
                role_id: "22222222-2222-4222-8222-222222222222",
                role_key: "maintenance_manager",
                display_name: "정비 관리자",
                status: "DRAFT",
                runtime_effective: false,
                runtime_warnings: [
                  "custom_role_status_not_active",
                  "custom_role_condition_unsupported_by_runtime_evaluator",
                ],
                conditions: [
                  {
                    condition_key: "department_1",
                    attribute: "department",
                    operator: "in",
                    values: ["정비팀", "야간조"],
                  },
                ],
              },
            ],
            feature_grants: [],
            warnings: [
              "preview_only_pending_save",
              "custom_role_condition_unsupported_by_runtime_evaluator",
              "custom_role_status_not_active",
            ],
          });
        },
      ),
      http.put("*/api/v1/policy/users/:id/assignments", async ({ request }) => {
        replaced(await request.json());
        return HttpResponse.json([
          {
            user_id: "11111111-1111-4111-8111-111111111111",
            role_id: "22222222-2222-4222-8222-222222222222",
            role_key: "maintenance_manager",
            display_name: "정비 관리자",
            status: "DRAFT",
            assigned_by: "33333333-3333-4333-8333-333333333333",
            created_at: "2026-06-26T00:00:00Z",
          },
        ]);
      }),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    expect(await screen.findByText("역할 배정")).toBeVisible();
    expect(
      screen.getByText(/다음 요청부터 런타임 권한에 반영됩니다/u),
    ).toBeVisible();
    expect(await screen.findByText("고민서")).toBeVisible();
    expect(
      screen.getByText(/저장하려면 권한 영향 미리보기를 검토하고 확인란/u),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "배정 저장(패스키)" }),
    ).toBeDisabled();
    await user.click(await screen.findByLabelText("정비 관리자"));
    expect(
      screen.getByRole("button", { name: "배정 저장(패스키)" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "영향 미리보기" }));

    await waitFor(() => {
      expect(previewed).toHaveBeenCalledWith({
        role_ids: ["22222222-2222-4222-8222-222222222222"],
      });
    });
    const previewPanel = await screen.findByLabelText("권한 영향 미리보기");
    expect(previewPanel).toBeVisible();
    expect(within(previewPanel).getByText("추가 예정")).toBeVisible();
    expect(within(previewPanel).getByText("런타임 차단 있음")).toBeVisible();
    const rollup = within(previewPanel).getByLabelText("영향 판정 요약");
    expect(rollup).toBeVisible();
    expect(within(rollup).getByText("차단")).toBeVisible();
    expect(within(rollup).getAllByText("1").length).toBeGreaterThanOrEqual(1);
    expect(
      within(rollup).getByText(
        /다음 역할은 저장되어도 현재 런타임 권한으로 반영되지 않습니다: 정비 관리자/u,
      ),
    ).toBeVisible();
    expect(within(previewPanel).getByText("조건 범위")).toBeVisible();
    expect(within(previewPanel).getByText(/정비팀, 야간조/u)).toBeVisible();
    expect(within(previewPanel).getByText("런타임 판정")).toBeVisible();
    expect(
      within(previewPanel).getByText(/정비 관리자 · 계획\/감사용/u),
    ).toBeVisible();
    expect(
      within(previewPanel).getByText(
        /현재 런타임 평가기가 아직 지원하지 않는 ABAC\/PBAC 조건/u,
      ),
    ).toBeVisible();
    expect(
      within(previewPanel).getByText("미리보기할 기능 권한이 없습니다."),
    ).toBeVisible();
    const saveAssignmentsButton = screen.getByRole("button", {
      name: "배정 저장(패스키)",
    });
    expect(
      screen.getByText(
        "저장하려면 권한 영향 미리보기를 검토하고 확인란을 선택하세요.",
      ),
    ).toBeVisible();
    expect(saveAssignmentsButton).toBeDisabled();

    await user.click(
      screen.getByRole("checkbox", {
        name: "권한 영향 미리보기를 검토했고 이 배정 변경을 진행합니다.",
      }),
    );
    expect(
      screen.getByText("현재 선택에 대한 영향 미리보기를 확인했습니다."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "배정 저장(패스키)" }),
    ).toBeEnabled();

    await user.click(saveAssignmentsButton);

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledOnce();
      expect(replaced).toHaveBeenCalledWith({
        role_ids: ["22222222-2222-4222-8222-222222222222"],
        preview_acknowledged: true,
        preview_receipt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        step_up: mockStepUpAssertion,
      });
    });
  });

  it("ignores stale assignment loads when switching users before previewing", async () => {
    const user = userEvent.setup();
    const previewed = vi.fn();
    let resolveFirstAssignments:
      | ((response: Response) => void)
      | undefined;
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () =>
        HttpResponse.json(catalogWithCustomRole),
      ),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.get("*/api/v1/users", () => HttpResponse.json(twoUserPage)),
      http.get("*/api/v1/policy/assignments", ({ request }) => {
        const userId = new URL(request.url).searchParams.get("user_id");
        if (userId === "11111111-1111-4111-8111-111111111111") {
          return new Promise<Response>((resolve) => {
            resolveFirstAssignments = resolve;
          });
        }
        return HttpResponse.json([]);
      }),
      http.post(
        "*/api/v1/policy/users/:id/assignment-preview",
        async ({ params, request }) => {
          previewed({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            user_id: "55555555-5555-4555-8555-555555555555",
            preview_receipt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            preview_receipt_expires_at: "2026-06-26T00:10:00Z",
            effective: false,
            system_roles: ["RECEPTIONIST"],
            current_role_ids: [],
            requested_role_ids: [],
            delta: {
              added_role_ids: [],
              removed_role_ids: [],
              unchanged_role_ids: [],
            },
            custom_roles: [],
            feature_grants: [],
            warnings: ["preview_only_pending_save"],
          });
        },
      ),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    const userSelect = await screen.findByLabelText("사용자");
    await waitFor(() => {
      expect(resolveFirstAssignments).toBeDefined();
    });
    await user.selectOptions(userSelect, "55555555-5555-4555-8555-555555555555");
    resolveFirstAssignments?.(
      HttpResponse.json([
        {
          user_id: "11111111-1111-4111-8111-111111111111",
          role_id: "22222222-2222-4222-8222-222222222222",
          role_key: "maintenance_manager",
          display_name: "정비 관리자",
          status: "ACTIVE",
          assigned_by: "33333333-3333-4333-8333-333333333333",
          created_at: "2026-06-26T00:00:00Z",
        },
      ]),
    );

    await user.click(screen.getByRole("button", { name: "영향 미리보기" }));

    await waitFor(() => {
      expect(previewed).toHaveBeenCalledWith({
        id: "55555555-5555-4555-8555-555555555555",
        body: { role_ids: [] },
      });
    });
  });

  it("requires a fresh assignment preview matching the selected user before passkey save", async () => {
    const user = userEvent.setup();
    const replaced = vi.fn();
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () =>
        HttpResponse.json(catalogWithCustomRole),
      ),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage)),
      http.get("*/api/v1/policy/assignments", () => HttpResponse.json([])),
      http.post("*/api/v1/policy/users/:id/assignment-preview", () =>
        HttpResponse.json({
          user_id: "55555555-5555-4555-8555-555555555555",
          preview_receipt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          preview_receipt_expires_at: "2026-06-26T00:10:00Z",
          effective: false,
          system_roles: ["MECHANIC"],
          current_role_ids: [],
          requested_role_ids: ["22222222-2222-4222-8222-222222222222"],
          delta: {
            added_role_ids: ["22222222-2222-4222-8222-222222222222"],
            removed_role_ids: [],
            unchanged_role_ids: [],
          },
          custom_roles: [],
          feature_grants: [],
          warnings: ["preview_only_pending_save"],
        }),
      ),
      http.put("*/api/v1/policy/users/:id/assignments", async ({ request }) => {
        replaced(await request.json());
        return HttpResponse.json([]);
      }),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    await user.click(await screen.findByLabelText("정비 관리자"));
    await user.click(screen.getByRole("button", { name: "영향 미리보기" }));
    const previewPanel = await screen.findByLabelText("권한 영향 미리보기");
    await user.click(
      screen.getByRole("checkbox", {
        name: "권한 영향 미리보기를 검토했고 이 배정 변경을 진행합니다.",
      }),
    );
    expect(previewPanel).toBeVisible();

    await user.click(screen.getByRole("button", { name: "배정 저장(패스키)" }));

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).not.toHaveBeenCalled();
      expect(replaced).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "저장하려면 권한 영향 미리보기를 검토하고 확인란을 선택하세요.",
      );
    });
  });

  it("renders policy audit evidence without exposing raw target ids", async () => {
    server.use(
      http.get("*/api/v1/policy/features", () => HttpResponse.json(features)),
      http.get("*/api/v1/policy/roles", () =>
        HttpResponse.json(catalogWithCustomRole),
      ),
      http.get("*/api/v1/policy/role-templates", () =>
        HttpResponse.json(roleTemplates),
      ),
      http.get("*/api/v1/policy/audit-events", () =>
        HttpResponse.json(policyAuditEvents),
      ),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage)),
      http.get("*/api/v1/policy/assignments", () => HttpResponse.json([])),
    );

    renderApp("/settings/policy", makeAuthContext(superAdminSession));

    const timeline = await screen.findByLabelText("정책 감사 타임라인");
    expect(within(timeline).getByText("역할 생성")).toBeVisible();
    expect(within(timeline).getByText("배정 스냅샷")).toBeVisible();
    expect(
      within(timeline).getByText("정비 관리자 역할 정의가 생성되었습니다."),
    ).toBeVisible();
    expect(
      within(timeline).getByText("역할 배정이 0개에서 1개로 변경되었습니다."),
    ).toBeVisible();
    expect(
      screen.queryByText("22222222-2222-4222-8222-222222222222"),
    ).not.toBeInTheDocument();
  });
});
