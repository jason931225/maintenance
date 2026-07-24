import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

// Response contracts are the generated client types (openapi.yaml declares the
// logistics response schemas since the CAP-LOGISTICS-PILOT openapi manifest was
// applied). The aggregate status unions below stay hand-written: each response
// narrows to the statuses that operation can produce, while the screen tracks
// rows across their whole lifecycle.

export type AsnStatus = "EXPECTED" | "PARTIAL_RECEIVED" | "RECEIVED" | "PUTAWAY";
export type FulfillmentStatus =
  | "RELEASED"
  | "PICKED"
  | "SHORT_PICK"
  | "PACKED"
  | "DISPATCHED"
  | "DELIVERED"
  | "SETTLED";
export type ShipmentStatus = "DISPATCHED" | "DELIVERED" | "SETTLED";
export type SlaAssessment = "MET" | "BREACHED";

export interface CreateAsnInput {
  branchId: string;
  warehouseCode: string;
  externalReference: string;
  sku: string;
  expectedQuantity: number;
}

export type AsnCreated = components["schemas"]["LogisticsAsnCreated"];

export type ReceiptResult = components["schemas"]["LogisticsAsnReceipt"];

export type PutawayResult = components["schemas"]["LogisticsAsnPutaway"];

export interface ReleaseFulfillmentInput {
  branchId: string;
  warehouseCode: string;
  sku: string;
  requestedQuantity: number;
  dueAt: string;
}

export type FulfillmentReleased = components["schemas"]["LogisticsFulfillmentReleased"];

export type PickResult = components["schemas"]["LogisticsFulfillmentPicked"];

export type PackResult = components["schemas"]["LogisticsFulfillmentPacked"];

export type DispatchResult = components["schemas"]["LogisticsShipmentDispatched"];

export type PodResult = components["schemas"]["LogisticsPodVerified"];

export type SettlementResult = components["schemas"]["LogisticsShipmentSettlement"];

export class LogisticsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LogisticsApiError";
  }
}

function message(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Logistics request failed (${String(status)})`;
}

function requireData(result: { data?: unknown; error?: unknown; response: Response }): unknown {
  if (result.data !== undefined) return result.data;
  throw new LogisticsApiError(message(result.error, result.response.status), result.response.status);
}

/** One idempotency key per submit intent; reuse it across retries of that intent. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Wire encoding for the backend's datetime fields (`dueAt`, `confirmedAt`,
 * `settledAt`). The deployed rest crate deserializes them as plain
 * `time::OffsetDateTime` WITHOUT `time::serde::rfc3339` — deviating from the
 * repo convention — so the only accepted wire form (and the one openapi.yaml
 * now declares as LogisticsTimeTuple) is time's default serde tuple
 * `[year, ordinal-day, hour, minute, second, nanosecond, offset_h, offset_m, offset_s]`
 * (verified against time 0.3.47 with the workspace feature set; RFC3339
 * strings are rejected with 422). Encoded in UTC, so the offset is always 0.
 * Drop this encoder when the backend adds the rfc3339 annotations (divergence
 * flagged in docs/evidence/console/CAP-LOGISTICS-PILOT/manifests/openapi.json).
 */
export function toTimeWire(
  iso: string,
): [number, number, number, number, number, number, 0, 0, 0] {
  const at = new Date(iso);
  const ordinal =
    Math.floor(
      (Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) -
        Date.UTC(at.getUTCFullYear(), 0, 1)) /
        86_400_000,
    ) + 1;
  return [
    at.getUTCFullYear(),
    ordinal,
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds() * 1_000_000,
    0,
    0,
    0,
  ];
}

/** Logistics-pilot transport bound to the authenticated ConsoleApiClient. */
export function createLogisticsApi(api: ConsoleApiClient) {
  return {
    createAsn: async (input: CreateAsnInput, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/logistics/asns", { body: input, signal });
      return requireData(response) as AsnCreated;
    },
    receive: async (
      asnId: string,
      input: { branchId: string; receivedQuantity: number },
      idempotencyKey: string,
      signal?: AbortSignal,
    ) => {
      const response = await api.POST("/api/v1/logistics/asns/{asn_id}/receipts", {
        params: { path: { asn_id: asnId }, header: { "Idempotency-Key": idempotencyKey } },
        body: input,
        signal,
      });
      return requireData(response) as ReceiptResult;
    },
    putaway: async (asnId: string, input: { branchId: string }, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/logistics/asns/{asn_id}/putaway", {
        params: { path: { asn_id: asnId } },
        body: input,
        signal,
      });
      return requireData(response) as PutawayResult;
    },
    release: async (input: ReleaseFulfillmentInput, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/logistics/fulfillments", {
        body: { ...input, dueAt: toTimeWire(input.dueAt) },
        signal,
      });
      return requireData(response) as FulfillmentReleased;
    },
    pick: async (
      fulfillmentId: string,
      input: { branchId: string; pickedQuantity: number },
      signal?: AbortSignal,
    ) => {
      const response = await api.POST("/api/v1/logistics/fulfillments/{fulfillment_id}/pick", {
        params: { path: { fulfillment_id: fulfillmentId } },
        body: input,
        signal,
      });
      return requireData(response) as PickResult;
    },
    pack: async (fulfillmentId: string, input: { branchId: string }, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/logistics/fulfillments/{fulfillment_id}/pack", {
        params: { path: { fulfillment_id: fulfillmentId } },
        body: input,
        signal,
      });
      return requireData(response) as PackResult;
    },
    dispatch: async (
      fulfillmentId: string,
      input: { branchId: string; carrierName: string; vehicleReference: string },
      signal?: AbortSignal,
    ) => {
      const response = await api.POST("/api/v1/logistics/fulfillments/{fulfillment_id}/dispatch", {
        params: { path: { fulfillment_id: fulfillmentId } },
        body: input,
        signal,
      });
      return requireData(response) as DispatchResult;
    },
    pod: async (
      shipmentId: string,
      input: { branchId: string; recipientName: string; evidenceReference: string; confirmedAt: string },
      signal?: AbortSignal,
    ) => {
      const response = await api.POST("/api/v1/logistics/shipments/{shipment_id}/pod", {
        params: { path: { shipment_id: shipmentId } },
        body: { ...input, confirmedAt: toTimeWire(input.confirmedAt) },
        signal,
      });
      return requireData(response) as PodResult;
    },
    settle: async (
      shipmentId: string,
      input: { branchId: string; currencyCode: "KRW"; amountMinor: number; settledAt: string },
      signal?: AbortSignal,
    ) => {
      const response = await api.POST("/api/v1/logistics/shipments/{shipment_id}/settlements", {
        params: { path: { shipment_id: shipmentId } },
        body: { ...input, settledAt: toTimeWire(input.settledAt) },
        signal,
      });
      return requireData(response) as SettlementResult;
    },
  };
}

export type LogisticsApi = ReturnType<typeof createLogisticsApi>;
