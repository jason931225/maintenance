import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AuthContext, type AuthContextValue } from "../../context/auth";
import { InventoryScreenBody } from "./InventoryScreenBody";

const item = {
  id: "item-1",
  branch_id: "branch-1",
  stock_location: { id: "location-1", label: "A-01" },
  iv_code: "IV-031",
  sku: "FLT-100",
  display_name: "유압 필터",
  description: "정비용 필터",
  unit_code: "EA",
  quantity_on_hand_milli: 2_000,
  safety_stock_milli: 3_000,
  unit_cost_won: 15_000,
  low_stock: true,
  status: "AVAILABLE",
  href: "/api/v1/inventory/items/item-1",
  created_by: "user-1",
  created_at: "2026-07-24T00:00:00Z",
  updated_at: "2026-07-24T00:00:00Z",
};

function renderScreen(GET: ReturnType<typeof vi.fn>, POST = vi.fn()) {
  const api = { GET, POST };
  const auth = {
    session: {
      access_token: "token",
      client_session_incarnation: "session-1",
      roles: ["ADMIN"],
      feature_grants: [],
      org_id: "org-1",
      user_id: "user-1",
    },
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api,
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  } as unknown as AuthContextValue;
  return render(
    <AuthContext.Provider value={auth}>
      <InventoryScreenBody />
    </AuthContext.Provider>,
  );
}

describe("InventoryScreenBody", () => {
  it("loads a real list, opens its detail, and exposes the immutable consumption trace", async () => {
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/inventory/items")
        return {
          data: { items: [item], total: 1, limit: 100, offset: 0 },
          response: new Response(),
        };
      if (path === "/api/v1/inventory/items/{item_id}")
        return { data: item, response: new Response() };
      if (path === "/api/v1/inventory/items/{item_id}/consumptions")
        return {
          data: [
            {
              id: "event-1",
              item_id: item.id,
              iv_code: item.iv_code,
              branch_id: item.branch_id,
              stock_location_id: item.stock_location.id,
              source: { kind: "work_order", work_order_id: "wo-1" },
              quantity_before_milli: 3_000,
              quantity_consumed_milli: 1_000,
              quantity_after_milli: 2_000,
              unit_cost_won: 15_000,
              cost_won: 15_000,
              consumed_by: "user-1",
              occurred_at: "2026-07-24T01:00:00Z",
              memo: "정기 정비",
              created_at: "2026-07-24T01:00:00Z",
            },
          ],
          response: new Response(),
        };
      return { data: { items: [] }, response: new Response() };
    });
    renderScreen(GET);
    expect(await screen.findByText("유압 필터")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "IV-031 상세 열기" }),
    );
    expect(
      await screen.findByRole("heading", { name: "유압 필터" }),
    ).toBeVisible();
    expect(screen.getByText("작업 지시 wo-1")).toBeVisible();
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/inventory/items",
      expect.objectContaining({ params: expect.anything() }),
    );
  });

  it("does not fabricate an empty result when the backend denies the list", async () => {
    const GET = vi.fn(() => ({
      data: undefined,
      error: { error: { code: "forbidden" } },
      response: new Response(null, { status: 403 }),
    }));
    renderScreen(GET);
    expect(await screen.findByRole("alert")).toHaveTextContent("권한");
    expect(
      screen.queryByText("현재 조건에 맞는 재고 품목이 없습니다."),
    ).toBeNull();
  });

  it("records consumption only against a selected real work order", async () => {
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/inventory/items")
        return {
          data: { items: [item], total: 1, limit: 100, offset: 0 },
          response: new Response(),
        };
      if (path === "/api/v1/inventory/items/{item_id}")
        return { data: item, response: new Response() };
      if (path === "/api/v1/inventory/items/{item_id}/consumptions")
        return { data: [], response: new Response() };
      if (path === "/api/v1/work-orders")
        return {
          data: {
            items: [
              {
                id: "wo-1",
                request_no: "WO-1001",
                branch_id: "branch-1",
                equipment_id: "eq",
                customer_id: "customer",
                site_id: "site",
                status: "IN_PROGRESS",
                priority: "HIGH",
                result_type: "REPAIR",
                evidence_verified: false,
              },
            ],
          },
          response: new Response(),
        };
      return { data: undefined, response: new Response(null, { status: 404 }) };
    });
    const POST = vi.fn(() => ({
      data: {
        item: { ...item, quantity_on_hand_milli: 750 },
        event: {
          id: "event-2",
          item_id: item.id,
          iv_code: item.iv_code,
          branch_id: item.branch_id,
          stock_location_id: item.stock_location.id,
          source: { kind: "work_order", work_order_id: "wo-1" },
          quantity_before_milli: 2_000,
          quantity_consumed_milli: 1_250,
          quantity_after_milli: 750,
          consumed_by: "user-1",
          occurred_at: "2026-07-24T01:00:00Z",
          created_at: "2026-07-24T01:00:00Z",
        },
      },
      response: new Response(),
    }));
    renderScreen(GET, POST);
    await userEvent.click(
      await screen.findByRole("button", { name: "IV-031 상세 열기" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "작업 지시 출고 기록" }),
    );
    const select = await screen.findByLabelText("작업 지시");
    await userEvent.selectOptions(select, "wo-1");
    await userEvent.type(screen.getByLabelText("출고 수량 (EA)"), "1.250");
    await userEvent.click(
      screen.getByRole("button", { name: "출고 기록 저장" }),
    );
    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith(
        "/api/v1/inventory/items/{item_id}/consumptions",
        expect.objectContaining({
          body: expect.objectContaining({
            quantity_consumed_milli: 1_250,
            source: { kind: "work_order", work_order_id: "wo-1" },
          }),
        }),
      );
    });
  });
});
