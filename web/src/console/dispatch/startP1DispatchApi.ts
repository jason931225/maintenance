import type { ConsoleApiClient } from "../../api/client";
import { DispatchApiContractError, DispatchApiError, type P1DispatchSummary } from "./dispatchApi";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDispatchStatus(value: unknown): boolean {
  return value === "BROADCASTING" || value === "AUTO_ASSIGNED" || value === "MANAGER_FORCE_PENDING";
}

function isErrorBody(value: unknown): value is { error: { message: string } } {
  return isRecord(value) && isRecord(value.error) && isString(value.error.message);
}

function isSummary(value: unknown): value is P1DispatchSummary {
  return isRecord(value)
    && isString(value.id)
    && isString(value.work_order_id)
    && isString(value.branch_id)
    && isDispatchStatus(value.status)
    && isString(value.accept_window_started_at)
    && isString(value.accept_window_ends_at)
    && isOptionalString(value.auto_assigned_mechanic_id)
    && isOptionalString(value.manager_force_pending_at)
    && typeof value.manual_call_required === "boolean"
    && isOptionalString(value.manual_call_required_at)
    && isOptionalString(value.manual_call_cleared_at)
    && isNumber(value.target_count)
    && isNumber(value.accepted_count)
    && isNumber(value.declined_count);
}

/** Starts a P1 broadcast without inventing an incident location or regional scope. */
export async function startP1Dispatch(
  api: ConsoleApiClient,
  workOrderId: string,
  signal?: AbortSignal,
): Promise<P1DispatchSummary> {
  const result = await api.POST("/api/v1/work-orders/{workOrderId}/p1-dispatch", {
    params: { path: { workOrderId } },
    body: { include_region: false },
    signal,
  });
  if (result.data == null) {
    throw new DispatchApiError(result.response.status, isErrorBody(result.error) ? result.error : undefined);
  }
  if (!isSummary(result.data)) throw new DispatchApiContractError("start P1 dispatch");
  return result.data;
}
