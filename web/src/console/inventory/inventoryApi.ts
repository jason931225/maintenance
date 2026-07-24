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
type InventoryMovementDto = components["schemas"]["InventoryMovement"];
type InventoryMovementSourceDto =
  components["schemas"]["InventoryMovementSource"];
type InventoryMrpLineDto = components["schemas"]["InventoryMrpLine"];
type InventoryReceiptResultDto =
  components["schemas"]["InventoryReceiptResult"];
type CycleCountDto = components["schemas"]["CycleCount"];
type CycleCountDetailDto = components["schemas"]["CycleCountDetail"];
type CycleCountLineDto = components["schemas"]["CycleCountLine"];
type CycleCountPageDto = components["schemas"]["CycleCountPage"];
type RecordInventoryReceiptRequest =
  components["schemas"]["RecordInventoryReceiptRequest"];
type OpenCycleCountRequest = components["schemas"]["OpenCycleCountRequest"];
type UpsertCycleCountLineRequest =
  components["schemas"]["UpsertCycleCountLineRequest"];
type CycleCountVersionRequest =
  components["schemas"]["CycleCountVersionRequest"];
type DecideCycleCountRequest =
  components["schemas"]["DecideCycleCountRequest"];

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

function isMovementSourceDto(value: unknown): value is InventoryMovementSourceDto {
  if (!isRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "work_order":
      return isString(value.workOrderId);
    case "p1_dispatch":
      return isString(value.dispatchId) && isString(value.workOrderId);
    case "cycle_count":
      return isString(value.cycleCountId) && isString(value.ccCode);
    case "external_ref":
      return isOptionalString(value.sourceRef);
    default:
      return false;
  }
}

function isMovementDto(value: unknown): value is InventoryMovementDto {
  return isRecord(value) && isString(value.id) && isString(value.itemId) && isString(value.ivCode) && ["ISSUE", "RECEIPT", "ADJUSTMENT"].includes(String(value.kind)) && isNumber(value.quantityDeltaMilli) && isNumber(value.quantityBeforeMilli) && isNumber(value.quantityAfterMilli) && isMovementSourceDto(value.source) && isString(value.actor) && isString(value.occurredAt) && isOptionalString(value.memo);
}

function isMrpLineDto(value: unknown): value is InventoryMrpLineDto {
  return isRecord(value) && isString(value.itemId) && isString(value.ivCode) && isString(value.displayName) && isString(value.unitCode) && ["quantityOnHandMilli", "safetyStockMilli", "inboundExpectedMilli", "reservedOutboundMilli", "monthlyUsageMilli", "proposedOrderMilli"].every((key) => isNumber(value[key])) && isOptionalNumber(value.coverMonthsCenti) && typeof value.short === "boolean";
}

function isCycleCountDto(value: unknown): value is CycleCountDto {
  return isRecord(value) && isString(value.id) && isString(value.ccCode) && isString(value.branchId) && isRecord(value.stockLocation) && isString(value.stockLocation.id) && isString(value.stockLocation.label) && ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED"].includes(String(value.status)) && isNumber(value.version) && isString(value.openedBy) && isOptionalString(value.submittedBy) && isOptionalString(value.decidedBy) && isOptionalString(value.decisionMemo) && isNumber(value.lineCount) && isNumber(value.varianceLineCount) && isString(value.createdAt) && isString(value.updatedAt);
}

function isCycleCountReason(
  value: unknown,
): value is CycleCountLineDto["reason"] {
  return (
    value == null ||
    value === "DAMAGE" ||
    value === "LOSS" ||
    value === "MISCOUNT" ||
    value === "FOUND" ||
    value === "OTHER"
  );
}

function isCycleCountLineDto(value: unknown): value is CycleCountLineDto {
  return isRecord(value) && isString(value.id) && isString(value.itemId) && isString(value.ivCode) && isString(value.displayName) && isString(value.unitCode) && isNumber(value.systemQuantityMilli) && isNumber(value.countedQuantityMilli) && isNumber(value.varianceMilli) && isCycleCountReason(value.reason) && isOptionalString(value.note) && isString(value.recordedBy) && isString(value.recordedAt);
}

function isCycleDetailDto(value: unknown): value is CycleCountDetailDto {
  return isRecord(value) && isCycleCountDto(value.count) && Array.isArray(value.lines) && value.lines.every(isCycleCountLineDto) && Array.isArray(value.appliedMovementIds) && value.appliedMovementIds.every(isString);
}

function isCycleCountPageDto(value: unknown): value is CycleCountPageDto {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isCycleCountDto) && isNumber(value.limit) && isNumber(value.offset) && isNumber(value.total);
}

function movementSourceView(source: InventoryMovementSourceDto): InventoryMovement["source"] {
  switch (source.kind) {
    case "work_order":
      return { kind: source.kind, work_order_id: source.workOrderId };
    case "p1_dispatch":
      return {
        kind: source.kind,
        dispatch_id: source.dispatchId,
        work_order_id: source.workOrderId,
      };
    case "cycle_count":
      return {
        kind: source.kind,
        cycle_count_id: source.cycleCountId,
        cc_code: source.ccCode,
      };
    case "external_ref":
      return { kind: source.kind, source_ref: source.sourceRef };
  }
}

function movementView(movement: InventoryMovementDto): InventoryMovement {
  return {
    id: movement.id,
    item_id: movement.itemId,
    iv_code: movement.ivCode,
    kind: movement.kind,
    quantity_delta_milli: movement.quantityDeltaMilli,
    quantity_before_milli: movement.quantityBeforeMilli,
    quantity_after_milli: movement.quantityAfterMilli,
    source: movementSourceView(movement.source),
    actor: movement.actor,
    occurred_at: movement.occurredAt,
    memo: movement.memo ?? null,
  };
}

function mrpLineView(line: InventoryMrpLineDto): InventoryMrpLine {
  return {
    item_id: line.itemId,
    iv_code: line.ivCode,
    display_name: line.displayName,
    unit_code: line.unitCode,
    quantity_on_hand_milli: line.quantityOnHandMilli,
    safety_stock_milli: line.safetyStockMilli,
    inbound_expected_milli: line.inboundExpectedMilli,
    reserved_outbound_milli: line.reservedOutboundMilli,
    monthly_usage_milli: line.monthlyUsageMilli,
    cover_months_centi: line.coverMonthsCenti ?? null,
    short: line.short,
    proposed_order_milli: line.proposedOrderMilli,
  };
}

function cycleCountView(count: CycleCountDto): CycleCountDetail["count"] {
  return {
    id: count.id,
    cc_code: count.ccCode,
    branch_id: count.branchId,
    stock_location: count.stockLocation,
    status: count.status,
    version: count.version,
    opened_by: count.openedBy,
    submitted_by: count.submittedBy ?? null,
    decided_by: count.decidedBy ?? null,
    decision_memo: count.decisionMemo ?? null,
    line_count: count.lineCount,
    variance_line_count: count.varianceLineCount,
    created_at: count.createdAt,
    updated_at: count.updatedAt,
  };
}

function cycleDetailView(detail: CycleCountDetailDto): CycleCountDetail {
  return {
    count: cycleCountView(detail.count),
    lines: detail.lines.map((line) => ({
      id: line.id,
      item_id: line.itemId,
      iv_code: line.ivCode,
      display_name: line.displayName,
      unit_code: line.unitCode,
      system_quantity_milli: line.systemQuantityMilli,
      counted_quantity_milli: line.countedQuantityMilli,
      variance_milli: line.varianceMilli,
      reason: line.reason ?? null,
      note: line.note ?? null,
      recorded_by: line.recordedBy,
      recorded_at: line.recordedAt,
    })),
    applied_movement_ids: detail.appliedMovementIds,
  };
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

export async function listInventoryMovements(api: ConsoleApiClient, itemId: string, signal?: AbortSignal): Promise<InventoryMovement[]> {
  return requireData(
    "inventory movement ledger",
    await api.GET("/api/v1/inventory/items/{item_id}/movements", {
      params: { path: { item_id: itemId }, query: { limit: 100, offset: 0 } },
      signal,
    }),
    (value): value is InventoryMovementDto[] =>
      Array.isArray(value) && value.every(isMovementDto),
  ).map(movementView);
}
export async function receiveInventoryItem(api: ConsoleApiClient, itemId: string, request: { quantity_received_milli: number; source_ref?: string; memo?: string; idempotency_key: string }): Promise<{ item: InventoryItem; movement: InventoryMovement }> {
  const body: RecordInventoryReceiptRequest = {
    quantityReceivedMilli: request.quantity_received_milli,
    sourceRef: request.source_ref,
    memo: request.memo,
    idempotencyKey: request.idempotency_key,
  };
  const result = requireData(
    "inventory receipt",
    await api.POST("/api/v1/inventory/items/{item_id}/receipts", {
      params: { path: { item_id: itemId } },
      body,
    }),
    (value): value is InventoryReceiptResultDto =>
      isRecord(value) &&
      isInventoryItem(value.item) &&
      isMovementDto(value.movement),
  );
  return { item: result.item, movement: movementView(result.movement) };
}
export async function getInventoryMrp(api: ConsoleApiClient, branchId: string, signal?: AbortSignal): Promise<InventoryMrpLine[]> {
  return requireData(
    "inventory MRP",
    await api.GET("/api/v1/inventory/mrp", {
      params: { query: { branchId } },
      signal,
    }),
    (value): value is InventoryMrpLineDto[] =>
      Array.isArray(value) && value.every(isMrpLineDto),
  ).map(mrpLineView);
}
export async function listCycleCounts(api: ConsoleApiClient, branchId: string, signal?: AbortSignal): Promise<CycleCountDetail["count"][]> {
  return requireData(
    "cycle count list",
    await api.GET("/api/v1/inventory/cycle-counts", {
      params: { query: { branchId, limit: 50, offset: 0 } },
      signal,
    }),
    isCycleCountPageDto,
  ).items.map(cycleCountView);
}
export async function openCycleCount(api: ConsoleApiClient, branchId: string, stockLocationId: string): Promise<CycleCountDetail> {
  const body: OpenCycleCountRequest = { branchId, stockLocationId };
  return cycleDetailView(requireData(
    "open cycle count",
    await api.POST("/api/v1/inventory/cycle-counts", { body }),
    isCycleDetailDto,
  ));
}
export async function getCycleCount(api: ConsoleApiClient, id: string): Promise<CycleCountDetail> {
  return cycleDetailView(requireData(
    "cycle count",
    await api.GET("/api/v1/inventory/cycle-counts/{count_id}", {
      params: { path: { count_id: id } },
    }),
    isCycleDetailDto,
  ));
}
export async function upsertCycleLine(api: ConsoleApiClient, id: string, request: { expected_version: number; item_id: string; counted_quantity_milli: number; reason?: CycleCountDetail["lines"][number]["reason"]; note?: string }): Promise<CycleCountDetail> {
  const body: UpsertCycleCountLineRequest = {
    expectedVersion: request.expected_version,
    itemId: request.item_id,
    countedQuantityMilli: request.counted_quantity_milli,
    reason: request.reason,
    note: request.note,
  };
  return cycleDetailView(requireData(
    "cycle count line",
    await api.POST("/api/v1/inventory/cycle-counts/{count_id}/lines", {
      params: { path: { count_id: id } },
      body,
    }),
    isCycleDetailDto,
  ));
}
export async function submitCycleCount(api: ConsoleApiClient, id: string, expected_version: number): Promise<CycleCountDetail> {
  const body: CycleCountVersionRequest = { expectedVersion: expected_version };
  return cycleDetailView(requireData(
    "cycle count submit",
    await api.POST("/api/v1/inventory/cycle-counts/{count_id}/submit", {
      params: { path: { count_id: id } },
      body,
    }),
    isCycleDetailDto,
  ));
}
export async function decideCycleCount(api: ConsoleApiClient, id: string, request: { expected_version: number; decision: "APPROVE" | "REJECT"; memo?: string; idempotency_key?: string }): Promise<CycleCountDetail> {
  const body: DecideCycleCountRequest = {
    expectedVersion: request.expected_version,
    decision: request.decision,
    memo: request.memo,
    idempotencyKey: request.idempotency_key,
  };
  return cycleDetailView(requireData(
    "cycle count decision",
    await api.POST("/api/v1/inventory/cycle-counts/{count_id}/decision", {
      params: { path: { count_id: id } },
      body,
    }),
    isCycleDetailDto,
  ));
}
export async function cancelCycleCount(api: ConsoleApiClient, id: string, expected_version: number): Promise<CycleCountDetail> {
  const body: CycleCountVersionRequest = { expectedVersion: expected_version };
  return cycleDetailView(requireData(
    "cycle count cancel",
    await api.POST("/api/v1/inventory/cycle-counts/{count_id}/cancel", {
      params: { path: { count_id: id } },
      body,
    }),
    isCycleDetailDto,
  ));
}

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
