import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { GenericModuleScreen } from "./GenericModuleScreen";
import { ASSET_MODULE_ACTIONS, assetModuleScreen, getModuleScreen } from "./moduleScreens";

const equipmentId = "00000000-0000-4000-8000-000000000001";

const equipmentRow = {
  equipment_id: equipmentId,
  branch_id: "00000000-0000-4000-8000-000000000002",
  equipment_no: "EQ-900",
  management_no: "MG-77",
  status: "rented",
  model: "ZX-9",
  maker: "MakerOne",
  specification: "3단 마스트",
  ton_text: "3.0t",
  customer_name: "고객 A",
  site_name: "서울 센터",
  asset_owner: "케이엔엘",
  vin: "VIN-900",
  updated_at: "2026-07-09T12:30:00Z",
} as const;

const timelineGraph = {
  equipment: {
    equipment_id: equipmentId,
    branch_id: equipmentRow.branch_id,
    equipment_no: equipmentRow.equipment_no,
    management_no: equipmentRow.management_no,
    status: equipmentRow.status,
    model: equipmentRow.model,
    maker: equipmentRow.maker,
    customer_id: "00000000-0000-4000-8000-000000000003",
    customer_name: equipmentRow.customer_name,
    site_id: "00000000-0000-4000-8000-000000000004",
    site_name: equipmentRow.site_name,
  },
  lifecycle_events: [
    {
      id: "evt-1",
      kind: "maintenance",
      label: "정비 완료",
      description: "정기 점검 완료",
      event_date: "2026-07-08",
      occurred_at: null,
      href: "/work-orders/wo-1",
    },
  ],
  graph: {
    nodes: [
      {
        id: "node-equipment",
        node_type: "equipment",
        label: "EQ-900",
        subtitle: "현재 장비",
        href: null,
        current: true,
      },
      {
        id: "node-customer",
        node_type: "customer",
        label: "고객 A",
        subtitle: "서울 센터",
        href: "/customers/customer-a",
        current: false,
      },
    ],
    edges: [{ from: "node-equipment", to: "node-customer", kind: "assigned", label: "배치" }],
  },
  work_order_count: 3,
  cost_ledger_total_won: 120_000,
} as const;

const costLedger = [
  {
    id: "ledger-1",
    branch_id: equipmentRow.branch_id,
    equipment_id: equipmentId,
    work_order_id: "00000000-0000-4000-8000-000000000005",
    purchase_request_id: null,
    source: "MANUAL_ADMIN",
    amount_won: 120_000,
    memo: "오일 교체",
    residual_before_won: 5_000_000,
    residual_after_won: 4_880_000,
    entry_at: "2026-07-08T06:10:00Z",
  },
] as const;

const lifecycleCost = {
  equipment_id: equipmentId,
  equipment_no: "EQ-900",
  status: "rented",
  acquisition_cost_won: 5_000_000,
  acquisition_date: "2025-01-01",
  acquisition_source: "EXPLICIT",
  maintenance_total_won: 120_000,
  manual_total_won: 0,
  purchase_total_won: 120_000,
  entry_count: 1,
  outsource_unlinked_won: 0,
  residual_value_won: 4_880_000,
  sale_price_won: null,
  sold_at: null,
  gross_margin_won: null,
  tco_won: 5_120_000,
  cost_per_month_won: 320_000,
  cost_per_hour_won: 12_000,
  timeline: costLedger,
} as const;

function createApi() {
  const api = createConsoleApiClient("asset-module-test-token");
  const GET = vi.spyOn(api, "GET").mockImplementation(async (path: string) => {
    await Promise.resolve();
    if (path === "/api/v1/equipment/list") {
      return { data: { items: [equipmentRow], total: 1, limit: 50, offset: 0 } };
    }
    if (path === "/api/v1/equipment/{id}") {
      return { data: equipmentRow };
    }
    if (path === "/api/v1/equipment/{id}/timeline-graph") {
      return { data: timelineGraph };
    }
    if (path === "/api/v1/financial/equipment/{equipmentId}/cost-ledger") {
      return { data: costLedger };
    }
    if (path === "/api/v1/financial/equipment/{equipmentId}/lifecycle-cost") {
      return { data: lifecycleCost };
    }
    if (path === "/api/v1/object-actions/catalog") {
      return {
        data: {
          object_type: "equipment",
          object_id: equipmentId,
          actions: [
            {
              action_id: "equipment.update_profile",
              object_type: "equipment",
              object_id: equipmentId,
              label: "정보 수정",
              description: "프로필 수정",
              submit_label: "저장",
              requires_passkey_step_up: true,
              risk_level: "sensitive_write",
              fields: [],
            },
          ],
        },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  return { api, GET };
}

function renderAsset(gate: PolicyGate) {
  const { api, GET } = createApi();
  const result = render(
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen config={assetModuleScreen} api={api} />
    </PolicyGateProvider>,
  );
  return { ...result, GET };
}

describe("assetModuleScreen", () => {
  it("is selected through MOD_SCREENS and renders source-backed equipment detail surfaces", async () => {
    const { container, GET } = renderAsset({ can: () => true });

    expect(getModuleScreen("asset")).toBe(assetModuleScreen);
    expect(screen.getByRole("heading", { name: "자산" })).toBeVisible();
    expect(screen.getByLabelText("장비 검색")).toBeVisible();

    expect(await screen.findByRole("button", { name: "EQ-900 상세 열기" })).toBeVisible();
    expect(container).not.toHaveTextContent(/FL-/);
    expect(await screen.findByText("정비 완료")).toBeVisible();
    expect(screen.getByText("정기 점검 완료")).toBeVisible();
    expect(screen.getAllByText("고객 A").length).toBeGreaterThan(0);
    expect(screen.getByText("오일 교체")).toBeVisible();
    expect(screen.getByText("버전")).toBeVisible();
    expect(screen.getByText("되돌림")).toBeVisible();
    expect(screen.getByRole("link", { name: "정보 수정" })).toHaveAttribute(
      "href",
      `/equipment/${equipmentId}`,
    );

    await waitFor(() => {
      expect(GET).toHaveBeenCalledWith(
        "/api/v1/financial/equipment/{equipmentId}/cost-ledger",
        expect.anything(),
      );
      expect(GET).toHaveBeenCalledWith("/api/v1/object-actions/catalog", expect.anything());
    });
  });

  it("omits cost and managed-action fetches when policy denies those affordances", async () => {
    const readOnlyGate: PolicyGate = {
      can: (action) => action === ASSET_MODULE_ACTIONS.read || action === ASSET_MODULE_ACTIONS.graph,
    };
    const { GET } = renderAsset(readOnlyGate);

    expect(await screen.findByRole("button", { name: "EQ-900 상세 열기" })).toBeVisible();
    expect(await screen.findByText("정비 완료")).toBeVisible();
    await waitFor(() => {
      expect(GET).toHaveBeenCalledWith("/api/v1/equipment/{id}/timeline-graph", expect.anything());
    });
    const calledPaths = GET.mock.calls.map(([path]) => path);
    expect(calledPaths).not.toContain("/api/v1/financial/equipment/{equipmentId}/cost-ledger");
    expect(calledPaths).not.toContain("/api/v1/financial/equipment/{equipmentId}/lifecycle-cost");
    expect(calledPaths).not.toContain("/api/v1/object-actions/catalog");
    expect(screen.queryByText("오일 교체")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "정보 수정" })).not.toBeInTheDocument();
  });
});
