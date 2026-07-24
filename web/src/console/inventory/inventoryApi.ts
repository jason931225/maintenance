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

export type InventoryMovement = {
  id: string; item_id: string; iv_code: string; kind: "ISSUE" | "RECEIPT" | "ADJUSTMENT";
  quantity_delta_milli: number; quantity_before_milli: number; quantity_after_milli: number;
  source: { kind: "work_order"; work_order_id: string } | { kind: "p1_dispatch"; dispatch_id: string; work_order_id: string } | { kind: "cycle_count"; cycle_count_id: string; cc_code: string } | { kind: "external_ref"; source_ref: string | null };
  actor: string; occurred_at: string; memo: string | null;
};
export type InventoryMrpLine = { item_id: string; iv_code: string; display_name: string; unit_code: string; quantity_on_hand_milli: number; safety_stock_milli: number; inbound_expected_milli: number; reserved_outbound_milli: number; monthly_usage_milli: number; cover_months_centi: number | null; short: boolean; proposed_order_milli: number };
export type CycleCountStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "CANCELLED";
export type CycleCountDetail = { count: { id: string; cc_code: string; branch_id: string; stock_location: { id: string; label: string }; status: CycleCountStatus; version: number; opened_by: string; submitted_by: string | null; decided_by: string | null; decision_memo: string | null; line_count: number; variance_line_count: number; created_at: string; updated_at: string }; lines: Array<{ id: string; item_id: string; iv_code: string; display_name: string; unit_code: string; system_quantity_milli: number; counted_quantity_milli: number; variance_milli: number; reason: "DAMAGE" | "LOSS" | "MISCOUNT" | "FOUND" | "OTHER" | null; note: string | null; recorded_by: string; recorded_at: string }>; applied_movement_ids: string[] };
type UntypedApi = { GET: (path: string, options?: unknown) => Promise<{ data?: unknown; error?: unknown; response: Response }>; POST: (path: string, options?: unknown) => Promise<{ data?: unknown; error?: unknown; response: Response }> };

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

function isMovement(value: unknown): value is InventoryMovement {
  return isRecord(value) && isString(value.id) && isString(value.item_id) && isString(value.iv_code) && ["ISSUE", "RECEIPT", "ADJUSTMENT"].includes(String(value.kind)) && isNumber(value.quantity_delta_milli) && isNumber(value.quantity_before_milli) && isNumber(value.quantity_after_milli) && isRecord(value.source) && isString(value.source.kind) && isString(value.actor) && isString(value.occurred_at) && isOptionalString(value.memo);
}
function isMrpLine(value: unknown): value is InventoryMrpLine {
  return isRecord(value) && isString(value.item_id) && isString(value.iv_code) && isString(value.display_name) && isString(value.unit_code) && ["quantity_on_hand_milli", "safety_stock_milli", "inbound_expected_milli", "reserved_outbound_milli", "monthly_usage_milli", "proposed_order_milli"].every((key) => isNumber(value[key])) && isOptionalNumber(value.cover_months_centi) && typeof value.short === "boolean";
}
function isCycleDetail(value: unknown): value is CycleCountDetail {
  if (!isRecord(value) || !isRecord(value.count) || !Array.isArray(value.lines) || !Array.isArray(value.applied_movement_ids)) return false;
  const count = value.count;
  return isString(count.id) && isString(count.cc_code) && isString(count.branch_id) && isRecord(count.stock_location) && isString(count.stock_location.id) && isString(count.stock_location.label) && ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED"].includes(String(count.status)) && isNumber(count.version) && value.lines.every((line) => isRecord(line) && isString(line.id) && isString(line.item_id) && isString(line.iv_code) && isString(line.display_name) && isString(line.unit_code) && isNumber(line.system_quantity_milli) && isNumber(line.counted_quantity_milli) && isNumber(line.variance_milli)) && value.applied_movement_ids.every(isString);
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

// These signed routes are intentionally isolated behind a local port until the
// reviewed OpenAPI/client generation catches up. Every response is still checked.
function inventoryPort(api: ConsoleApiClient): UntypedApi { return api as unknown as UntypedApi; }
export async function listInventoryMovements(api: ConsoleApiClient, itemId: string, signal?: AbortSignal): Promise<InventoryMovement[]> {
  return requireData("inventory movement ledger", await inventoryPort(api).GET(`/api/v1/inventory/items/${itemId}/movements`, { signal }), (value): value is InventoryMovement[] => Array.isArray(value) && value.every(isMovement));
}
export async function receiveInventoryItem(api: ConsoleApiClient, itemId: string, request: { quantity_received_milli: number; source_ref?: string; memo?: string; idempotency_key: string }): Promise<{ item: InventoryItem; movement: InventoryMovement }> {
  return requireData("inventory receipt", await inventoryPort(api).POST(`/api/v1/inventory/items/${itemId}/receipts`, { body: request }), (value): value is { item: InventoryItem; movement: InventoryMovement } => isRecord(value) && isInventoryItem(value.item) && isMovement(value.movement));
}
export async function getInventoryMrp(api: ConsoleApiClient, branchId: string, signal?: AbortSignal): Promise<InventoryMrpLine[]> {
  return requireData("inventory MRP", await inventoryPort(api).GET("/api/v1/inventory/mrp", { params: { query: { branch_id: branchId } }, signal }), (value): value is InventoryMrpLine[] => Array.isArray(value) && value.every(isMrpLine));
}
export async function listCycleCounts(api: ConsoleApiClient, branchId: string, signal?: AbortSignal): Promise<CycleCountDetail["count"][]> {
  return requireData("cycle count list", await inventoryPort(api).GET("/api/v1/inventory/cycle-counts", { params: { query: { branch_id: branchId, limit: 50, offset: 0 } }, signal }), (value): value is { items: CycleCountDetail["count"][] } => isRecord(value) && Array.isArray(value.items) && value.items.every((count) => isCycleDetail({ count, lines: [], applied_movement_ids: [] }))).items;
}
export async function openCycleCount(api: ConsoleApiClient, branchId: string, stockLocationId: string): Promise<CycleCountDetail> { return requireData("open cycle count", await inventoryPort(api).POST("/api/v1/inventory/cycle-counts", { body: { branch_id: branchId, stock_location_id: stockLocationId } }), isCycleDetail); }
export async function getCycleCount(api: ConsoleApiClient, id: string): Promise<CycleCountDetail> { return requireData("cycle count", await inventoryPort(api).GET(`/api/v1/inventory/cycle-counts/${id}`), isCycleDetail); }
export async function upsertCycleLine(api: ConsoleApiClient, id: string, body: { item_id: string; counted_quantity_milli: number; reason?: string; note?: string }): Promise<CycleCountDetail> { return requireData("cycle count line", await inventoryPort(api).POST(`/api/v1/inventory/cycle-counts/${id}/lines`, { body }), isCycleDetail); }
export async function submitCycleCount(api: ConsoleApiClient, id: string, expected_version: number): Promise<CycleCountDetail> { return requireData("cycle count submit", await inventoryPort(api).POST(`/api/v1/inventory/cycle-counts/${id}/submit`, { body: { expected_version } }), isCycleDetail); }
export async function decideCycleCount(api: ConsoleApiClient, id: string, body: { expected_version: number; decision: "APPROVE" | "REJECT"; memo?: string; idempotency_key?: string }): Promise<CycleCountDetail> { return requireData("cycle count decision", await inventoryPort(api).POST(`/api/v1/inventory/cycle-counts/${id}/decision`, { body }), isCycleDetail); }
export async function cancelCycleCount(api: ConsoleApiClient, id: string): Promise<CycleCountDetail> { return requireData("cycle count cancel", await inventoryPort(api).POST(`/api/v1/inventory/cycle-counts/${id}/cancel`), isCycleDetail); }

export function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiCallError && error.status === 403;
}

/** Converts a user-entered unit quantity into the contract's exact milli-unit integer. */
export function milliUnits(value: string): number | null {
  const milli = nonNegativeMilliUnits(value);
  return milli != null && milli > 0 ? milli : null;
}

/** Converts a counted quantity into milli-units; physical cycle counts may be zero. */
export function nonNegativeMilliUnits(value: string): number | null {
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = value.trim().split(".")[0];
  const fraction = (match[1] || "").padEnd(3, "0");
  const milli = Number(whole) * 1_000 + Number(fraction);
  return Number.isSafeInteger(milli) && milli >= 0 ? milli : null;
}
