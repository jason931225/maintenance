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

function requestBody(
  requestMock: ReturnType<typeof vi.fn>,
  callIndex: number,
): Record<string, unknown> {
  const calls = requestMock.mock.calls as unknown[][];
  const options = calls[callIndex]?.[1];
  if (
    typeof options !== "object" ||
    options === null ||
    !("body" in options) ||
    typeof options.body !== "object" ||
    options.body === null
  ) {
    throw new Error(
      `request ${String(callIndex)} did not include an object body`,
    );
  }
  return options.body as Record<string, unknown>;
}

const movement = {
  id: "movement-1", itemId: item.id, ivCode: item.iv_code, kind: "RECEIPT",
  quantityDeltaMilli: 1_000, quantityBeforeMilli: 2_000,
  quantityAfterMilli: 3_000, source: { kind: "external_ref", sourceRef: "PO-1" },
  actor: "user-1", occurredAt: "2026-07-24T00:00:00Z", memo: null,
};
const cycleCount = {
  id: "cc-1", ccCode: "CC-1", branchId: item.branch_id,
  stockLocation: item.stock_location, status: "DRAFT", version: 1,
  openedBy: "user-1", submittedBy: null, decidedBy: null, decisionMemo: null,
  lineCount: 0, varianceLineCount: 0, createdAt: "2026-07-24T00:00:00Z",
  updatedAt: "2026-07-24T00:00:00Z",
};
const cycleDetail = { count: cycleCount, lines: [], appliedMovementIds: [] };

function operationalGet(path: string, options?: { params?: { path?: { item_id?: string } } }) {
  if (path === "/api/v1/inventory/items") return { data: { items: [item, secondItem], total: 2, limit: 100, offset: 0 }, response: new Response() };
  if (path === "/api/v1/inventory/items/{item_id}") return { data: options?.params?.path?.item_id === secondItem.id ? secondItem : item, response: new Response() };
  if (path === "/api/v1/inventory/items/{item_id}/consumptions" || path.includes("/movements") || path === "/api/v1/inventory/mrp") return { data: [], response: new Response() };
  if (path === "/api/v1/inventory/cycle-counts") return { data: { items: [], total: 0, limit: 50, offset: 0 }, response: new Response() };
  return { data: undefined, response: new Response(null, { status: 404 }) };
}

describe("InventoryScreenBody", () => {
  it("discards a deferred cycle-count detail after the selected branch and item change", async () => {
    let resolveDetail: ((value: unknown) => void) | undefined;
    const count = cycleCount;
    const GET = vi.fn((path: string, options?: { params?: { path?: { item_id?: string } } }) => {
      if (path === "/api/v1/inventory/items") return { data: { items: [item, secondItem], total: 2, limit: 100, offset: 0 }, response: new Response() };
      if (path === "/api/v1/inventory/items/{item_id}") return { data: options?.params?.path?.item_id === secondItem.id ? secondItem : item, response: new Response() };
      if (path === "/api/v1/inventory/items/{item_id}/consumptions") return { data: [], response: new Response() };
      if (path.includes("/movements")) return { data: [], response: new Response() };
      if (path === "/api/v1/inventory/mrp") return { data: [], response: new Response() };
      if (path === "/api/v1/inventory/cycle-counts") return { data: { items: [count], total: 1, limit: 50, offset: 0 }, response: new Response() };
      if (path === "/api/v1/inventory/cycle-counts/{count_id}") return new Promise((resolve) => { resolveDetail = resolve; });
      return { data: [], response: new Response() };
    });
    renderScreen(GET);
    await userEvent.click(await screen.findByRole("button", { name: "IV-031 상세 열기" }));
    await userEvent.click(await screen.findByRole("button", { name: "CC-1 · DRAFT" }));
    await waitFor(() => {
      expect(resolveDetail).toBeTypeOf("function");
    });
    await userEvent.click(screen.getByRole("button", { name: "IV-032 상세 열기" }));
    expect(await screen.findByRole("heading", { name: "윤활유" })).toBeVisible();
    resolveDetail?.({ data: { count, lines: [], appliedMovementIds: [] }, response: new Response() });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "윤활유" })).toBeVisible();
    });
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

  it("reuses one receipt idempotency key after a lost response", async () => {
    const POST = vi.fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce({ data: { item, movement }, response: new Response() });
    renderScreen(vi.fn(operationalGet), POST);
    await userEvent.click(await screen.findByRole("button", { name: "IV-031 상세 열기" }));
    await userEvent.click(screen.getByRole("button", { name: "입고 기록" }));
    await userEvent.type(screen.getByLabelText("입고 수량 (EA)"), "1");
    await userEvent.click(screen.getByRole("button", { name: "입고 저장" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("입고가 저장되지 않았습니다");
    await userEvent.click(screen.getByRole("button", { name: "입고 저장" }));
    await waitFor(() => {
      expect(POST).toHaveBeenCalledTimes(2);
    });
    expect(requestBody(POST, 0).idempotencyKey).toBe(
      requestBody(POST, 1).idempotencyKey,
    );
  });

  it("drops a deferred receipt and resets busy receipt UI after selection changes", async () => {
    let resolveReceipt: ((value: unknown) => void) | undefined;
    const POST = vi.fn(() => new Promise((resolve) => { resolveReceipt = resolve; }));
    renderScreen(vi.fn(operationalGet), POST);
    await userEvent.click(await screen.findByRole("button", { name: "IV-031 상세 열기" }));
    await userEvent.click(screen.getByRole("button", { name: "입고 기록" }));
    await userEvent.type(screen.getByLabelText("입고 수량 (EA)"), "1");
    await userEvent.click(screen.getByRole("button", { name: "입고 저장" }));
    await userEvent.click(screen.getByRole("button", { name: "IV-032 상세 열기" }));
    expect(await screen.findByRole("heading", { name: "윤활유" })).toBeVisible();
    expect(screen.queryByRole("form", { name: "재고 입고 기록" })).toBeNull();
    resolveReceipt?.({ data: { item, movement }, response: new Response() });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "이 위치 실사 개설" }),
      ).not.toBeDisabled();
    });
    expect(screen.queryByText("입고가 저장되지 않았습니다")).toBeNull();
  });

  it("submits a rendered zero physical count without an invented variance reason", async () => {
    const POST = vi.fn()
      .mockResolvedValueOnce({ data: cycleDetail, response: new Response() })
      .mockResolvedValueOnce({ data: cycleDetail, response: new Response() });
    renderScreen(vi.fn(operationalGet), POST);
    await userEvent.click(await screen.findByRole("button", { name: "IV-031 상세 열기" }));
    await userEvent.click(screen.getByRole("button", { name: "이 위치 실사 개설" }));
    expect(await screen.findByText("CC-1 · DRAFT · 버전 1")).toBeVisible();
    await userEvent.type(screen.getByLabelText("실사 수량 (EA)"), "0");
    await userEvent.click(screen.getByRole("button", { name: "실사 라인 저장" }));
    await waitFor(() => {
      expect(POST).toHaveBeenCalledTimes(2);
    });
    const lineBody = requestBody(POST, 1);
    expect(lineBody).toMatchObject({
      expectedVersion: 1,
      itemId: item.id,
      countedQuantityMilli: 0,
    });
    expect(lineBody.reason).toBeUndefined();
  });

  it("does not let deferred movement MRP or cycle-list reads overwrite the new selection", async () => {
    const deferred: Array<(value: unknown) => void> = [];
    const GET = vi.fn((path: string, options?: { params?: { path?: { item_id?: string } } }) => {
      if (path === "/api/v1/inventory/items" || path === "/api/v1/inventory/items/{item_id}" || path === "/api/v1/inventory/items/{item_id}/consumptions") return operationalGet(path, options);
      if (path.includes("/movements") || path === "/api/v1/inventory/mrp" || path === "/api/v1/inventory/cycle-counts") return new Promise((resolve) => deferred.push(resolve));
      return operationalGet(path, options);
    });
    renderScreen(GET);
    await userEvent.click(await screen.findByRole("button", { name: "IV-031 상세 열기" }));
    await waitFor(() => {
      expect(deferred).toHaveLength(3);
    });
    await userEvent.click(screen.getByRole("button", { name: "IV-032 상세 열기" }));
    expect(await screen.findByRole("heading", { name: "윤활유" })).toBeVisible();
    deferred.splice(0).forEach((resolve, index) => {
      resolve(
        index === 2
          ? {
              data: {
                items: [cycleCount],
                total: 1,
                limit: 50,
                offset: 0,
              },
              response: new Response(),
            }
          : { data: [], response: new Response() },
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "윤활유" })).toBeVisible();
    });
    expect(screen.queryByRole("button", { name: "CC-1 · DRAFT" })).toBeNull();
  });

  it("does not commit a deferred cycle-count open after selection changes", async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    const POST = vi.fn(() => new Promise((resolve) => { resolveOpen = resolve; }));
    renderScreen(vi.fn(operationalGet), POST);
    await userEvent.click(await screen.findByRole("button", { name: "IV-031 상세 열기" }));
    await userEvent.click(screen.getByRole("button", { name: "이 위치 실사 개설" }));
    await waitFor(() => {
      expect(resolveOpen).toBeTypeOf("function");
    });
    await userEvent.click(screen.getByRole("button", { name: "IV-032 상세 열기" }));
    expect(await screen.findByRole("heading", { name: "윤활유" })).toBeVisible();
    resolveOpen?.({ data: cycleDetail, response: new Response() });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "이 위치 실사 개설" }),
      ).not.toBeDisabled();
    });
    expect(screen.queryByText("CC-1 · DRAFT · 버전 1")).toBeNull();
  });
});
