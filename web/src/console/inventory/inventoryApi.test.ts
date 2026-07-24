import { describe, expect, it, vi } from "vitest";

import {
  consumeInventoryItem,
  getInventoryItem,
  InventoryApiContractError,
  listInventoryConsumptions,
  listInventoryItems,
  listOpenWorkOrders,
  listInventoryMovements,
  getInventoryMrp,
  openCycleCount,
  submitCycleCount,
  milliUnits,
  nonNegativeMilliUnits,
} from "./inventoryApi";

const item = {
  id: "item-1",
  branch_id: "branch-1",
  stock_location: { id: "loc", label: "A-01" },
  iv_code: "IV-1",
  sku: null,
  display_name: "필터",
  description: null,
  unit_code: "EA",
  quantity_on_hand_milli: 1_000,
  safety_stock_milli: 500,
  unit_cost_won: null,
  low_stock: false,
  status: "AVAILABLE",
};
const event = {
  id: "event-1",
  item_id: item.id,
  iv_code: item.iv_code,
  branch_id: item.branch_id,
  stock_location_id: item.stock_location.id,
  source: { kind: "work_order", work_order_id: "work-order-1" },
  quantity_consumed_milli: 1_000,
  quantity_after_milli: 0,
  occurred_at: "2026-07-24T00:00:00Z",
  memo: null,
};

function response(data: unknown) {
  return { data, response: new Response() };
}

describe("inventoryApi", () => {
  it("distinguishes positive receipt quantities from non-negative cycle counts", () => {
    expect(milliUnits("0")).toBeNull();
    expect(nonNegativeMilliUnits("0")).toBe(0);
    expect(nonNegativeMilliUnits("0.250")).toBe(250);
    expect(nonNegativeMilliUnits("-1")).toBeNull();
  });
  it("uses only generated inventory paths and forwards list filters", async () => {
    const GET = (path: string) => {
      if (path === "/api/v1/inventory/items") {
        return response({ items: [], limit: 50, offset: 0, total: 0 });
      }
      throw new Error(`unexpected ${path}`);
    };

    await expect(
      listInventoryItems({ GET } as never, { q: "필터", lowStock: true }),
    ).resolves.toMatchObject({ total: 0 });
  });

  it("reads an item and its consumption trace through the generated contract", async () => {
    const GET = (path: string) =>
      response(path.endsWith("/consumptions") ? [event] : item);
    await expect(
      getInventoryItem({ GET } as never, "item-1"),
    ).resolves.toMatchObject({ id: "item-1" });
    await expect(
      listInventoryConsumptions({ GET } as never, "item-1"),
    ).resolves.toEqual([event]);
  });

  it("keeps work-order candidates in the selected item's branch", async () => {
    const GET = vi.fn(() =>
      response({
        items: [
          {
            id: "work-order-1",
            request_no: "WO-1",
            branch_id: "branch-1",
            status: "IN_PROGRESS",
            priority: "HIGH",
          },
          {
            id: "work-order-2",
            request_no: "WO-2",
            branch_id: "branch-2",
            status: "IN_PROGRESS",
            priority: "HIGH",
          },
        ],
      }),
    );

    await expect(
      listOpenWorkOrders({ GET } as never, "branch-1"),
    ).resolves.toMatchObject([{ id: "work-order-1" }]);
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/work-orders",
      expect.objectContaining({
        params: { query: { branch_id: "branch-1", limit: 100, offset: 0 } },
      }),
    );
  });

  it("submits an idempotent work-order consumption through the generated POST", async () => {
    const POST = (path: string, options?: { body?: unknown }) => ({
      ...response({ event, item }),
      path,
      options,
    });
    await expect(
      consumeInventoryItem({ POST } as never, "item-1", {
        source: { kind: "work_order", work_order_id: "work-order-1" },
        quantity_consumed_milli: 1_250,
        idempotency_key: "request-1",
      }),
    ).resolves.toMatchObject({ event: { id: "event-1" } });
  });

  it("uses the signed inventory operational routes and fails closed on their object responses", async () => {
    const count = { id: "cc-1", cc_code: "CC-1", branch_id: "branch-1", stock_location: { id: "loc", label: "A-01" }, status: "DRAFT", version: 1, opened_by: "user-1", submitted_by: null, decided_by: null, decision_memo: null, line_count: 0, variance_line_count: 0, created_at: "2026-07-24T00:00:00Z", updated_at: "2026-07-24T00:00:00Z" };
    const detail = { count, lines: [], applied_movement_ids: [] };
    const GET = vi.fn((path: string) => response(path === "/api/v1/inventory/mrp" ? [{ item_id: item.id, iv_code: item.iv_code, display_name: item.display_name, unit_code: item.unit_code, quantity_on_hand_milli: 1, safety_stock_milli: 2, inbound_expected_milli: 0, reserved_outbound_milli: 0, monthly_usage_milli: 1, cover_months_centi: 100, short: true, proposed_order_milli: 2 }] : [{ id: "move-1", item_id: item.id, iv_code: item.iv_code, kind: "RECEIPT", quantity_delta_milli: 1, quantity_before_milli: 0, quantity_after_milli: 1, source: { kind: "external_ref", source_ref: "PO-1" }, actor: "user-1", occurred_at: "2026-07-24T00:00:00Z", memo: null }]));
    const POST = vi.fn(() => response(detail));
    await expect(listInventoryMovements({ GET } as never, item.id)).resolves.toHaveLength(1);
    await expect(getInventoryMrp({ GET } as never, item.branch_id)).resolves.toHaveLength(1);
    await expect(openCycleCount({ POST } as never, item.branch_id, "loc")).resolves.toMatchObject({ count: { id: "cc-1" } });
    await expect(submitCycleCount({ POST } as never, "cc-1", 1)).resolves.toMatchObject({ count: { version: 1 } });
    expect(GET).toHaveBeenCalledWith("/api/v1/inventory/mrp", expect.objectContaining({ params: { query: { branch_id: item.branch_id } } }));
  });

  it("rejects malformed 2xx inventory, work-order, trace, and consumption bodies", async () => {
    await expect(
      listInventoryItems(
        { GET: () => response({ items: "not-an-array", total: 0 }) } as never,
        {},
      ),
    ).rejects.toBeInstanceOf(InventoryApiContractError);
    await expect(
      getInventoryItem(
        { GET: () => response({ id: "item-1" }) } as never,
        "item-1",
      ),
    ).rejects.toBeInstanceOf(InventoryApiContractError);
    await expect(
      listInventoryConsumptions(
        { GET: () => response([{ id: "event-1" }]) } as never,
        "item-1",
      ),
    ).rejects.toBeInstanceOf(InventoryApiContractError);
    await expect(
      listOpenWorkOrders(
        { GET: () => response({ items: [{ id: "wo" }] }) } as never,
        "branch-1",
      ),
    ).rejects.toBeInstanceOf(InventoryApiContractError);
    await expect(
      consumeInventoryItem(
        { POST: () => response({ item, event: {} }) } as never,
        "item-1",
        {
          source: { kind: "work_order", work_order_id: "work-order-1" },
          quantity_consumed_milli: 1,
          idempotency_key: "request-1",
        },
      ),
    ).rejects.toBeInstanceOf(InventoryApiContractError);
  });
});
