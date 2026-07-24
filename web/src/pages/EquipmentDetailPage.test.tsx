import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
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
import type * as WebAuthnModule from "../auth/webauthn";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import type {
  EquipmentListItem,
  EquipmentTimelineGraph,
  ObjectActionCatalogResponse,
} from "../api/types";
import { branchId } from "../test/fixtures";

const mockStepUpAssertion = {
  ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credential: { id: "passkey-assertion" },
};
const mockAssertPasskeyStepUp = vi.hoisted(() => vi.fn());

vi.mock("../auth/webauthn", async (importOriginal) => {
  const actual = await importOriginal<typeof WebAuthnModule>();
  return {
    ...actual,
    assertPasskeyStepUp: mockAssertPasskeyStepUp,
  };
});

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

const equipmentId = "44444444-4444-4444-8444-444444444444";

const item: EquipmentListItem = {
  equipment_id: equipmentId,
  branch_id: branchId,
  equipment_no: "D-25-290",
  management_no: "290",
  status: "rented",
  model: "GTS25DE",
  maker: "두산",
  specification: "좌식",
  ton_text: "2.5T",
  customer_name: "케이앤엘",
  site_name: "본사",
  vin: "VIN-0001",
  updated_at: "2026-06-12T08:00:00Z",
};

const timelineGraph: EquipmentTimelineGraph = {
  equipment: {
    equipment_id: equipmentId,
    branch_id: branchId,
    equipment_no: "D-25-290",
    management_no: "290",
    status: "rented",
    model: "GTS25DE",
    maker: "두산",
    customer_id: "55555555-5555-4555-8555-555555555555",
    customer_name: "케이앤엘",
    site_id: "66666666-6666-4666-8666-666666666666",
    site_name: "본사",
  },
  lifecycle_events: [
    {
      id: "asset-registered",
      kind: "asset_registered",
      label: "자산 등록",
      description: null,
      event_date: "2024-01-10",
      occurred_at: null,
      href: `/equipment/${equipmentId}`,
    },
    {
      id: "work-order-33333333-3333-4333-8333-333333333333",
      kind: "work_order",
      label: "작업지시 20260612-001",
      description: "ASSIGNED · P1",
      event_date: null,
      occurred_at: "2026-06-12T08:30:00Z",
      href: "/work-orders/33333333-3333-4333-8333-333333333333",
    },
  ],
  graph: {
    nodes: [
      {
        id: "customer:55555555-5555-4555-8555-555555555555",
        node_type: "customer",
        label: "케이앤엘",
        subtitle: "고객",
        href: "/dispatch?customer_id=55555555-5555-4555-8555-555555555555",
        current: false,
      },
      {
        id: `equipment:${equipmentId}`,
        node_type: "equipment",
        label: "D-25-290",
        subtitle: "GTS25DE",
        href: `/equipment/${equipmentId}`,
        current: true,
      },
      {
        id: "work_order:33333333-3333-4333-8333-333333333333",
        node_type: "work_order",
        label: "20260612-001",
        subtitle: "ASSIGNED · P1",
        href: "/work-orders/33333333-3333-4333-8333-333333333333",
        current: false,
      },
    ],
    edges: [
      {
        from: `equipment:${equipmentId}`,
        to: "work_order:33333333-3333-4333-8333-333333333333",
        kind: "has_work_order",
        label: "정비 이력",
      },
    ],
  },
  work_order_count: 1,
  cost_ledger_total_won: 120000,
};

const actionCatalog: ObjectActionCatalogResponse = {
  object_type: "equipment",
  object_id: equipmentId,
  actions: [
    {
      action_id: "equipment.update_profile",
      object_type: "equipment",
      object_id: equipmentId,
      label: "장비 정보 수정",
      description: "장비 마스터 정보를 감사 로그와 함께 수정합니다.",
      submit_label: "패스키로 수정 실행",
      requires_passkey_step_up: true,
      risk_level: "sensitive_write",
      fields: [
        {
          field_key: "status",
          label: "상태",
          field_type: "select",
          required: false,
          current_value: "rented",
          options: [
            { value: "rented", label: "임대" },
            { value: "spare", label: "예비" },
          ],
        },
        {
          field_key: "model",
          label: "모델",
          field_type: "text",
          required: false,
          current_value: "GTS25DE",
          options: [],
        },
      ],
    },
  ],
};

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "admin-1",
  roles: ["ADMIN"],
  branches: [branchId],
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

function renderApp(path: string, session: AuthSession = adminSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function equipmentDetailHandler(row: EquipmentListItem | undefined) {
  return http.get("*/api/v1/equipment/:id", ({ params }) => {
    if (params.id !== equipmentId || !row) {
      return HttpResponse.json(
        { code: "not_found", message: "equipment was not found" },
        { status: 404 },
      );
    }
    return HttpResponse.json(row);
  });
}

function equipmentTimelineGraphHandler(
  row: EquipmentTimelineGraph | undefined,
) {
  return http.get("*/api/v1/equipment/:id/timeline-graph", ({ params }) => {
    if (params.id !== equipmentId || !row) {
      return HttpResponse.json(
        { code: "not_found", message: "equipment was not found" },
        { status: 404 },
      );
    }
    return HttpResponse.json(row);
  });
}

function objectActionCatalogHandler(
  row: ObjectActionCatalogResponse | undefined,
) {
  return http.get("*/api/v1/object-actions/catalog", ({ request }) => {
    const url = new URL(request.url);
    if (
      url.searchParams.get("object_type") !== "equipment" ||
      url.searchParams.get("object_id") !== equipmentId ||
      !row
    ) {
      return HttpResponse.json(
        { code: "not_found", message: "equipment was not found" },
        { status: 404 },
      );
    }
    return HttpResponse.json(row);
  });
}

function objectActionExecuteHandler(onExecute: (body: unknown) => void) {
  return http.post("*/api/v1/object-actions/execute", async ({ request }) => {
    onExecute(await request.json());
    return HttpResponse.json({
      execution_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      action_id: "equipment.update_profile",
      object_type: "equipment",
      object_id: equipmentId,
      status: "succeeded",
      audit_event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      target_href: `/equipment/${equipmentId}`,
      message: "updated",
    });
  });
}

describe("EquipmentDetailPage", () => {
  it("renders an imported equipment object view from a deep link", async () => {
    server.use(
      equipmentDetailHandler(item),
      equipmentTimelineGraphHandler(timelineGraph),
      objectActionCatalogHandler(actionCatalog),
    );

    renderApp(`/equipment/${equipmentId}`);

    expect(
      await screen.findByRole("heading", { name: "장비 상세", level: 1 }),
    ).toBeVisible();
    expect((await screen.findAllByText("D-25-290"))[0]).toBeVisible();
    expect(screen.getAllByText("GTS25DE")[0]).toBeVisible();
    expect(screen.getAllByText("케이앤엘")[0]).toBeVisible();
    expect(screen.getByRole("link", { name: "장비 목록으로" })).toHaveAttribute(
      "href",
      "/equipment",
    );
    expect(screen.getByRole("link", { name: "재무 보기" })).toHaveAttribute(
      "href",
      "/financial",
    );
    expect(screen.getByRole("button", { name: "정보 수정" })).toBeVisible();
    expect(
      await screen.findByRole("heading", {
        name: "실행 가능한 작업",
        level: 2,
      }),
    ).toBeVisible();
    expect(screen.getByText("장비 정보 수정")).toBeVisible();
    expect(screen.getByText("패스키 확인 필요")).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "생애주기 리본", level: 2 }),
    ).toBeVisible();
    expect(screen.getByText("자산 등록")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /작업지시 20260612-001/ }),
    ).toHaveAttribute(
      "href",
      "/work-orders/33333333-3333-4333-8333-333333333333",
    );
    expect(
      screen.getByRole("heading", {
        name: "고객-현장-장비-작업 그래프",
        level: 2,
      }),
    ).toBeVisible();
    expect(
      screen.getByText("최근 작업지시 1건 · 비용 원장 120,000원"),
    ).toBeVisible();
    expect(screen.getByText("정비 이력")).toBeVisible();
    expect(screen.queryByText(equipmentId)).not.toBeInTheDocument();
  });

  it("shows a not-found state when the equipment id is not in the imported list", async () => {
    server.use(
      equipmentDetailHandler(undefined),
      equipmentTimelineGraphHandler(undefined),
      objectActionCatalogHandler(undefined),
    );

    renderApp(`/equipment/${equipmentId}`);

    expect(await screen.findByText("장비를 찾을 수 없습니다.")).toBeVisible();
  });

  it("executes the generated equipment action through passkey step-up", async () => {
    const user = userEvent.setup();
    const executed = vi.fn();
    server.use(
      equipmentDetailHandler(item),
      equipmentTimelineGraphHandler(timelineGraph),
      objectActionCatalogHandler(actionCatalog),
      objectActionExecuteHandler(executed),
    );

    renderApp(`/equipment/${equipmentId}`);

    await screen.findByRole("heading", {
      name: "실행 가능한 작업",
      level: 2,
    });
    await user.selectOptions(screen.getByLabelText("상태"), "spare");
    await user.clear(screen.getByLabelText("모델"));
    await user.type(screen.getByLabelText("모델"), "GTS30");
    await user.click(
      screen.getByRole("button", { name: "패스키로 수정 실행" }),
    );

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledOnce();
      expect(executed).toHaveBeenCalledWith({
        action_id: "equipment.update_profile",
        object_type: "equipment",
        object_id: equipmentId,
        input: {
          status: "spare",
          model: "GTS30",
        },
        step_up: mockStepUpAssertion,
      });
    });
    expect(
      await screen.findByText(/cccccccc-cccc-4ccc-8ccc-cccccccccccc/),
    ).toBeVisible();
  });
});
