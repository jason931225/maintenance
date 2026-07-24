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
const secondItem = {
  ...item,
  id: "item-2",
  branch_id: "branch-2",
  iv_code: "IV-032",
  display_name: "윤활유",
  stock_location: { id: "location-2", label: "B-02" },
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
  it("discards a deferred cycle-count detail after the selected branch and item change", async () => {
    let resolveDetail: ((value: unknown) => void) | undefined;
    const count = { id: "cc-1", cc_code: "CC-1", branch_id: item.branch_id, stock_location: item.stock_location, status: "DRAFT", version: 1, opened_by: "user-1", submitted_by: null, decided_by: null, decision_memo: null, line_count: 0, variance_line_count: 0, created_at: "2026-07-24T00:00:00Z", updated_at: "2026-07-24T00:00:00Z" };
    const GET = vi.fn((path: string, options?: { params?: { path?: { item_id?: string } } }) => {
      if (path === "/api/v1/inventory/items") return { data: { items: [item, secondItem], total: 2, limit: 100, offset: 0 }, response: new Response() };
      if (path === "/api/v1/inventory/items/{item_id}") return { data: options?.params?.path?.item_id === secondItem.id ? secondItem : item, response: new Response() };
      if (path === "/api/v1/inventory/items/{item_id}/consumptions") return { data: [], response: new Response() };
      if (path.includes("/movements")) return { data: [], response: new Response() };
      if (path === "/api/v1/inventory/mrp") return { data: [], response: new Response() };
      if (path === "/api/v1/inventory/cycle-counts") return { data: { items: [count], total: 1, limit: 50, offset: 0 }, response: new Response() };
      if (path === "/api/v1/inventory/cycle-counts/cc-1") return new Promise((resolve) => { resolveDetail = resolve; });
      return { data: [], response: new Response() };
    });
    renderScreen(GET);
    await userEvent.click(await screen.findByRole("button", { name: "IV-031 상세 열기" }));
    await userEvent.click(await screen.findByRole("button", { name: "CC-1 · DRAFT" }));
    await waitFor(() => expect(resolveDetail).toBeTypeOf("function"));
    await userEvent.click(screen.getByRole("button", { name: "IV-032 상세 열기" }));
    expect(await screen.findByRole("heading", { name: "윤활유" })).toBeVisible();
    resolveDetail?.({ data: { count, lines: [], applied_movement_ids: [] }, response: new Response() });
    await waitFor(() => expect(screen.getByRole("heading", { name: "윤활유" })).toBeVisible());
    expect(screen.queryByText("CC-1 · DRAFT · 버전 1")).toBeNull();
  });
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

  it("clears a loaded detail and trace when list authority is lost", async () => {
    let denyList = false;
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/inventory/items") {
        return denyList
          ? {
              data: undefined,
              error: { error: { code: "forbidden" } },
              response: new Response(null, { status: 403 }),
            }
          : {
              data: { items: [item], total: 1, limit: 100, offset: 0 },
              response: new Response(),
            };
      }
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
              consumed_by: "user-1",
              occurred_at: "2026-07-24T01:00:00Z",
              memo: "정기 정비",
              created_at: "2026-07-24T01:00:00Z",
            },
          ],
          response: new Response(),
        };
      return { data: undefined, response: new Response(null, { status: 404 }) };
    });
    renderScreen(GET);
    await userEvent.click(
      await screen.findByRole("button", { name: "IV-031 상세 열기" }),
    );
    expect(await screen.findByText("작업 지시 wo-1")).toBeVisible();

    denyList = true;
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("권한");
    expect(screen.queryByRole("heading", { name: "유압 필터" })).toBeNull();
    expect(screen.queryByText("작업 지시 wo-1")).toBeNull();
  });

  it("shows a visible error instead of rendering a malformed 2xx list", async () => {
    const GET = vi.fn(() => ({
      data: { items: "not-an-array", total: 1 },
      response: new Response(),
    }));
    renderScreen(GET);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "불러오지 못했습니다",
    );
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

  it("does not let a deferred consumption for A overwrite selected item B", async () => {
    let resolveConsumption: ((value: unknown) => void) | undefined;
    const POST = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConsumption = resolve;
        }),
    );
    const GET = vi.fn(
      (
        path: string,
        options?: { params?: { path?: { item_id?: string } } },
      ) => {
        if (path === "/api/v1/inventory/items")
          return {
            data: {
              items: [item, secondItem],
              total: 2,
              limit: 100,
              offset: 0,
            },
            response: new Response(),
          };
        const selected =
          options?.params?.path?.item_id === secondItem.id ? secondItem : item;
        if (path === "/api/v1/inventory/items/{item_id}")
          return { data: selected, response: new Response() };
        if (path === "/api/v1/inventory/items/{item_id}/consumptions")
          return { data: [], response: new Response() };
        if (path === "/api/v1/work-orders")
          return {
            data: {
              items: [
                {
                  id: "wo-1",
                  request_no: "WO-1001",
                  branch_id: item.branch_id,
                  status: "IN_PROGRESS",
                  priority: "HIGH",
                },
                {
                  id: "wo-2",
                  request_no: "WO-1002",
                  branch_id: secondItem.branch_id,
                  status: "IN_PROGRESS",
                  priority: "HIGH",
                },
              ],
            },
            response: new Response(),
          };
        return {
          data: undefined,
          response: new Response(null, { status: 404 }),
        };
      },
    );

    renderScreen(GET, POST);
    await userEvent.click(
      await screen.findByRole("button", { name: "IV-031 상세 열기" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "작업 지시 출고 기록" }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText("작업 지시"),
      "wo-1",
    );
    await userEvent.type(screen.getByLabelText("출고 수량 (EA)"), "1");
    await userEvent.click(
      screen.getByRole("button", { name: "출고 기록 저장" }),
    );
    await waitFor(() => {
      expect(resolveConsumption).toBeTypeOf("function");
    });

    await userEvent.click(
      screen.getByRole("button", { name: "IV-032 상세 열기" }),
    );
    expect(
      await screen.findByRole("heading", { name: "윤활유" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("form", { name: "작업 지시 출고 기록" }),
    ).toBeNull();

    resolveConsumption?.({
      data: {
        item: { ...item, quantity_on_hand_milli: 0 },
        event: {
          id: "event-a",
          item_id: item.id,
          iv_code: item.iv_code,
          branch_id: item.branch_id,
          stock_location_id: item.stock_location.id,
          source: { kind: "work_order", work_order_id: "wo-1" },
          quantity_before_milli: 2_000,
          quantity_consumed_milli: 2_000,
          quantity_after_milli: 0,
          consumed_by: "user-1",
          occurred_at: "2026-07-24T01:00:00Z",
          created_at: "2026-07-24T01:00:00Z",
        },
      },
      response: new Response(),
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "윤활유" })).toBeVisible();
    });
    expect(screen.queryByText("event-a")).toBeNull();
    expect(screen.getByText("2 EA")).toBeVisible();
  });
});
