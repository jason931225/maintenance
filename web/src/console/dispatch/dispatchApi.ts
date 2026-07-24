import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

export type DispatchQueueStatus = components["schemas"]["DispatchQueueStatus"];
export type DispatchQueueItem = components["schemas"]["DispatchQueueItem"];
export type DispatchQueuePage = components["schemas"]["DispatchQueuePage"];
export type P1DispatchSummary = components["schemas"]["P1DispatchSummary"];
export type DispatchCandidate = components["schemas"]["DispatchCandidateSummary"];
export type P1DispatchResponse = components["schemas"]["P1DispatchResponseSummary"];
export type DispatchResponseKind = components["schemas"]["DispatchResponseKind"];
type ErrorBody = components["schemas"]["ErrorBody"];

export const DISPATCH_QUEUE_STATUSES = [
  "RECEIVED",
  "UNASSIGNED",
  "ASSIGNED",
  "IN_PROGRESS",
  "PART_WAITING",
  "DELAYED",
] as const satisfies readonly DispatchQueueStatus[];

export interface DispatchQueueFilters {
  status: DispatchQueueStatus[];
  after?: string;
}

/** A 2xx response that violates the generated transport contract. */
export class DispatchApiContractError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} returned an invalid response`);
    this.name = "DispatchApiContractError";
  }
}

/** Typed non-success response retained for denied/error UI states. */
export class DispatchApiError extends Error {
  constructor(readonly status: number, body?: ErrorBody) {
    super(body?.error.message ?? `Dispatch request failed (${String(status)})`);
    this.name = "DispatchApiError";
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
  return value === undefined || isString(value);
}


function isDispatchStatus(value: unknown): boolean {
  return value === "BROADCASTING" || value === "AUTO_ASSIGNED" || value === "MANAGER_FORCE_PENDING";
}

function isResponseKind(value: unknown): value is DispatchResponseKind {
  return value === "ACCEPT" || value === "DECLINE";
}

function isErrorBody(value: unknown): value is ErrorBody {
  return isRecord(value) && isRecord(value.error) && isString(value.error.message);
}

function isQueueDispatch(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && isDispatchStatus(value.status)
    && isString(value.accept_window_ends_at)
    && isNumber(value.target_count)
    && isNumber(value.accepted_count)
    && isNumber(value.declined_count)
    && typeof value.manual_call_required === "boolean";
}

function isQueueItem(value: unknown): value is DispatchQueueItem {
  return isRecord(value)
    && isString(value.work_order_id)
    && isString(value.request_no)
    && isString(value.branch_id)
    && isString(value.status)
    && isString(value.priority)
    && isString(value.symptom)
    && isString(value.equipment_id)
    && isString(value.customer_id)
    && isString(value.site_id)
    && isOptionalString(value.target_due_at)
    && isOptionalString(value.assigned_mechanic_id)
    && (value.dispatch === undefined || isQueueDispatch(value.dispatch))
    && isString(value.updated_at);
}

function isQueuePage(value: unknown): value is DispatchQueuePage {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every(isQueueItem)
    && isOptionalString(value.next_after)
    && isRecord(value.stats)
    && isNumber(value.stats.unassigned_count)
    && isNumber(value.stats.sla_due_count);
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

function isCandidate(value: unknown): value is DispatchCandidate {
  return isRecord(value)
    && isString(value.mechanic_id)
    && isNumber(value.score_milli)
    && typeof value.gps_ranked === "boolean"
    && (value.distance_meters === undefined || isNumber(value.distance_meters))
    && isOptionalString(value.location_recorded_at)
    && isRecord(value.workload)
    && isString(value.score_reason)
    && (value.response === undefined || isResponseKind(value.response))
    && isOptionalString(value.responded_at);
}

function isCandidatePage(value: unknown): value is { items: DispatchCandidate[] } {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isCandidate);
}

function isResponse(value: unknown): value is P1DispatchResponse {
  return isRecord(value)
    && isString(value.dispatch_id)
    && isString(value.user_id)
    && isResponseKind(value.response)
    && isString(value.responded_at)
    && (value.score_milli === undefined || isNumber(value.score_milli))
    && typeof value.gps_ranked === "boolean"
    && (value.distance_meters === undefined || isNumber(value.distance_meters))
    && isOptionalString(value.score_reason);
}

function isResponsePage(value: unknown): value is { items: P1DispatchResponse[] } {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isResponse);
}

function requireData<T>(
  operation: string,
  result: { data?: unknown; error?: unknown; response: Response },
  valid: (value: unknown) => value is T,
): T {
  if (result.data == null) {
    throw new DispatchApiError(result.response.status, isErrorBody(result.error) ? result.error : undefined);
  }
  if (!valid(result.data)) throw new DispatchApiContractError(operation);
  return result.data;
}

export function isDispatchAccessDenied(error: unknown): boolean {
  return error instanceof DispatchApiError && (error.status === 401 || error.status === 403);
}

export async function listDispatchQueue(
  api: ConsoleApiClient,
  filters: DispatchQueueFilters,
  signal?: AbortSignal,
): Promise<DispatchQueuePage> {
  return requireData(
    "dispatch queue",
    await api.GET("/api/v1/console/dispatch/queue", {
      params: { query: { status: filters.status, limit: 50, after: filters.after } },
      querySerializer: { array: { style: "form", explode: false } },
      signal,
    }),
    isQueuePage,
  );
}

export async function getP1Dispatch(
  api: ConsoleApiClient,
  dispatchId: string,
  signal?: AbortSignal,
): Promise<P1DispatchSummary> {
  return requireData(
    "P1 dispatch",
    await api.GET("/api/v1/p1-dispatches/{dispatchId}", { params: { path: { dispatchId } }, signal }),
    isSummary,
  );
}

export async function listP1DispatchCandidates(
  api: ConsoleApiClient,
  dispatchId: string,
  signal?: AbortSignal,
): Promise<DispatchCandidate[]> {
  return requireData(
    "P1 dispatch candidates",
    await api.GET("/api/v1/p1-dispatches/{dispatchId}/candidates", { params: { path: { dispatchId } }, signal }),
    isCandidatePage,
  ).items;
}

export async function listP1DispatchResponses(
  api: ConsoleApiClient,
  dispatchId: string,
  signal?: AbortSignal,
): Promise<P1DispatchResponse[]> {
  return requireData(
    "P1 dispatch responses",
    await api.GET("/api/v1/p1-dispatches/{dispatchId}/responses", { params: { path: { dispatchId } }, signal }),
    isResponsePage,
  ).items;
}

export async function respondToP1Dispatch(
  api: ConsoleApiClient,
  dispatchId: string,
  response: DispatchResponseKind,
): Promise<P1DispatchSummary> {
  return requireData(
    "P1 dispatch response",
    await api.POST("/api/v1/p1-dispatches/{dispatchId}/responses", {
      params: { path: { dispatchId } },
      body: { response },
    }),
    isSummary,
  );
}

export async function forceAssignP1Dispatch(
  api: ConsoleApiClient,
  dispatchId: string,
  mechanicId: string,
): Promise<P1DispatchSummary> {
  return requireData(
    "P1 dispatch force assignment",
    await api.POST("/api/v1/p1-dispatches/{dispatchId}/force-assign", {
      params: { path: { dispatchId } },
      body: { mechanic_id: mechanicId },
    }),
    isSummary,
  );
}
