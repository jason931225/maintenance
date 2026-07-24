import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";

export type InventoryItem = components["schemas"]["InventoryItem"];
export type InventoryItemPage = components["schemas"]["InventoryItemPage"];
export type InventoryConsumptionEvent =
  components["schemas"]["InventoryConsumptionEvent"];
export type InventoryConsumptionSource =
  components["schemas"]["InventoryConsumptionSource"];
export type ConsumeInventoryItemRequest =
  components["schemas"]["ConsumeInventoryItemRequest"];
export type InventoryConsumptionResult =
  components["schemas"]["InventoryConsumptionResult"];
export type WorkOrderSummary = components["schemas"]["WorkOrderListItem"];
type ErrorBody = components["schemas"]["ErrorBody"];

export interface InventoryListFilters {
  q?: string;
  lowStock?: boolean;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === "object" && value !== null && "error" in value;
}

function requireData<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (!result.data) {
    throw new ApiCallError(
      result.response.status,
      isErrorBody(result.error) ? result.error : undefined,
    );
  }
  return result.data;
}

export async function listInventoryItems(
  api: ConsoleApiClient,
  filters: InventoryListFilters,
  signal?: AbortSignal,
): Promise<InventoryItemPage> {
  return requireData(
    await api.GET("/api/v1/inventory/items", {
      params: {
        query: {
          q: filters.q || undefined,
          low_stock: filters.lowStock || undefined,
          limit: 100,
          offset: 0,
        },
      },
      signal,
    }),
  );
}

export async function getInventoryItem(
  api: ConsoleApiClient,
  itemId: string,
  signal?: AbortSignal,
): Promise<InventoryItem> {
  return requireData(
    await api.GET("/api/v1/inventory/items/{item_id}", {
      params: { path: { item_id: itemId } },
      signal,
    }),
  );
}

export async function listInventoryConsumptions(
  api: ConsoleApiClient,
  itemId: string,
  signal?: AbortSignal,
): Promise<InventoryConsumptionEvent[]> {
  return requireData(
    await api.GET("/api/v1/inventory/items/{item_id}/consumptions", {
      params: { path: { item_id: itemId }, query: { limit: 100, offset: 0 } },
      signal,
    }),
  );
}

export async function listOpenWorkOrders(
  api: ConsoleApiClient,
  signal?: AbortSignal,
): Promise<WorkOrderSummary[]> {
  const page = requireData(
    await api.GET("/api/v1/work-orders", {
      params: { query: { limit: 100, offset: 0 } },
      signal,
    }),
  );
  return page.items;
}

export async function consumeInventoryItem(
  api: ConsoleApiClient,
  itemId: string,
  request: ConsumeInventoryItemRequest,
): Promise<InventoryConsumptionResult> {
  return requireData(
    await api.POST("/api/v1/inventory/items/{item_id}/consumptions", {
      params: { path: { item_id: itemId } },
      body: request,
    }),
  );
}

export function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiCallError && error.status === 403;
}

/** Converts a user-entered unit quantity into the contract's exact milli-unit integer. */
export function milliUnits(value: string): number | null {
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = value.trim().split(".")[0];
  const fraction = (match[1] || "").padEnd(3, "0");
  const milli = Number(whole) * 1_000 + Number(fraction);
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}
