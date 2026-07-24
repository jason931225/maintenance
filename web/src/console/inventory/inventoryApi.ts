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

/** A 2xx response that does not satisfy the generated contract at runtime. */
export class InventoryApiContractError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} returned an invalid response`);
    this.name = "InventoryApiContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value == null || isString(value);
}

function isOptionalNumber(value: unknown): boolean {
  return value == null || isNumber(value);
}

function isInventoryItem(value: unknown): value is InventoryItem {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.branch_id) &&
    isRecord(value.stock_location) &&
    isString(value.stock_location.id) &&
    isString(value.stock_location.label) &&
    isString(value.iv_code) &&
    isString(value.display_name) &&
    isOptionalString(value.description) &&
    isOptionalString(value.sku) &&
    isString(value.unit_code) &&
    isNumber(value.quantity_on_hand_milli) &&
    isNumber(value.safety_stock_milli) &&
    isOptionalNumber(value.unit_cost_won) &&
    typeof value.low_stock === "boolean" &&
    isString(value.status)
  );
}

function isInventoryItemPage(value: unknown): value is InventoryItemPage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isInventoryItem) &&
    isNumber(value.limit) &&
    isNumber(value.offset) &&
    isNumber(value.total)
  );
}

function isInventoryConsumptionEvent(
  value: unknown,
): value is InventoryConsumptionEvent {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.item_id) ||
    !isString(value.iv_code) ||
    !isString(value.branch_id) ||
    !isString(value.stock_location_id) ||
    !isRecord(value.source) ||
    !isNumber(value.quantity_consumed_milli) ||
    !isNumber(value.quantity_after_milli) ||
    !isString(value.occurred_at) ||
    !isOptionalString(value.memo)
  ) {
    return false;
  }
  return value.source.kind === "work_order"
    ? isString(value.source.work_order_id)
    : value.source.kind === "p1_dispatch" && isString(value.source.dispatch_id);
}

function isInventoryConsumptionResult(
  value: unknown,
): value is InventoryConsumptionResult {
  return (
    isRecord(value) &&
    isInventoryItem(value.item) &&
    isInventoryConsumptionEvent(value.event)
  );
}

function isWorkOrderSummary(value: unknown): value is WorkOrderSummary {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.request_no) &&
    isString(value.branch_id) &&
    isString(value.status) &&
    isString(value.priority)
  );
}

function isWorkOrderPage(
  value: unknown,
): value is { items: WorkOrderSummary[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isWorkOrderSummary)
  );
}

function isErrorBody(value: unknown): value is ErrorBody {
  return isRecord(value) && isRecord(value.error);
}

function requireData<T>(
  operation: string,
  result: { data?: unknown; error?: unknown; response: Response },
  isValid: (value: unknown) => value is T,
): T {
  if (result.data == null) {
    throw new ApiCallError(
      result.response.status,
      isErrorBody(result.error) ? result.error : undefined,
    );
  }
  if (!isValid(result.data)) throw new InventoryApiContractError(operation);
  return result.data;
}

export async function listInventoryItems(
  api: ConsoleApiClient,
  filters: InventoryListFilters,
  signal?: AbortSignal,
): Promise<InventoryItemPage> {
  return requireData(
    "inventory item list",
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
    isInventoryItemPage,
  );
}

export async function getInventoryItem(
  api: ConsoleApiClient,
  itemId: string,
  signal?: AbortSignal,
): Promise<InventoryItem> {
  return requireData(
    "inventory item",
    await api.GET("/api/v1/inventory/items/{item_id}", {
      params: { path: { item_id: itemId } },
      signal,
    }),
    isInventoryItem,
  );
}

export async function listInventoryConsumptions(
  api: ConsoleApiClient,
  itemId: string,
  signal?: AbortSignal,
): Promise<InventoryConsumptionEvent[]> {
  return requireData(
    "inventory consumption trace",
    await api.GET("/api/v1/inventory/items/{item_id}/consumptions", {
      params: { path: { item_id: itemId }, query: { limit: 100, offset: 0 } },
      signal,
    }),
    (value): value is InventoryConsumptionEvent[] =>
      Array.isArray(value) && value.every(isInventoryConsumptionEvent),
  );
}

export async function listOpenWorkOrders(
  api: ConsoleApiClient,
  branchId: string,
  signal?: AbortSignal,
): Promise<WorkOrderSummary[]> {
  const page = requireData(
    "work-order list",
    await api.GET("/api/v1/work-orders", {
      params: { query: { branch_id: branchId, limit: 100, offset: 0 } },
      signal,
    }),
    isWorkOrderPage,
  );
  // The server narrows within the caller's RLS-derived scope. Retain the
  // selected item's branch as a defense-in-depth fence for malformed or stale
  // responses.
  return page.items.filter((order) => order.branch_id === branchId);
}

export async function consumeInventoryItem(
  api: ConsoleApiClient,
  itemId: string,
  request: ConsumeInventoryItemRequest,
): Promise<InventoryConsumptionResult> {
  return requireData(
    "inventory consumption",
    await api.POST("/api/v1/inventory/items/{item_id}/consumptions", {
      params: { path: { item_id: itemId } },
      body: request,
    }),
    isInventoryConsumptionResult,
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
