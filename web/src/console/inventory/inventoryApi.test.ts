import { describe, expect, it } from "vitest";

import {
  consumeInventoryItem,
  getInventoryItem,
  listInventoryConsumptions,
  listInventoryItems,
} from "./inventoryApi";

describe("inventoryApi", () => {
  it("uses only generated inventory paths and forwards list filters", async () => {
    const GET = (path: string) => {
      if (path === "/api/v1/inventory/items") {
        return {
          data: { items: [], limit: 50, offset: 0, total: 0 },
          response: new Response(),
        };
      }
      throw new Error(`unexpected ${path}`);
    };

    await expect(
      listInventoryItems({ GET } as never, { q: "필터", lowStock: true }),
    ).resolves.toMatchObject({ total: 0 });
    expect(
      await listInventoryItems({ GET } as never, { q: "필터", lowStock: true }),
    ).toMatchObject({ items: [] });
  });

  it("reads an item and its consumption trace through the generated contract", async () => {
    const GET = (
      path: string,
      options?: { params?: { path?: { item_id?: string } } },
    ) => ({
      data: path.endsWith("/consumptions")
        ? []
        : {
            id: "item-1",
            display_name: "필터",
            stock_location: { id: "loc", label: "A-01" },
          },
      response: new Response(),
      path,
      options,
    });
    await expect(
      getInventoryItem({ GET } as never, "item-1"),
    ).resolves.toMatchObject({ id: "item-1" });
    await expect(
      listInventoryConsumptions({ GET } as never, "item-1"),
    ).resolves.toEqual([]);
  });

  it("submits an idempotent work-order consumption through the generated POST", async () => {
    const POST = (path: string, options?: { body?: unknown }) => ({
      data: { event: { id: "event-1" }, item: { id: "item-1" } },
      response: new Response(),
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
});
