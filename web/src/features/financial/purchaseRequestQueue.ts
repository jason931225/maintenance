import type { ConsoleApiClient } from "../../api/client";
import type { PurchaseRequestSummary, PurchaseStatus } from "../../api/types";

export interface PurchaseRequestQueuePage {
  items: PurchaseRequestSummary[];
  limit: number;
  offset: number;
  total?: number;
}

export interface PurchaseRequestQueueFilter {
  branchId: string;
  statuses?: PurchaseStatus[];
  limit: number;
  offset: number;
}

type PurchaseRequestQueueApi = ConsoleApiClient & {
  GET(
    path: "/api/v1/financial/purchase-requests",
    options: {
      params: {
        query: {
          branch_id: string;
          /** openapi-fetch serializes this as repeated plain `status` keys. */
          status?: PurchaseStatus[];
          limit: number;
          offset: number;
        };
      };
    },
  ): Promise<{
    data?: PurchaseRequestQueuePage;
    error?: unknown;
    response?: Response;
  }>;
};

/**
 * The only temporary collection-route boundary until the backend lane owns the
 * generated-client update. `status` is intentionally an array so the client
 * emits `status=A&status=B`, never the rejected `status[]` convention.
 */
export function listPurchaseRequestQueue(
  api: ConsoleApiClient,
  filter: PurchaseRequestQueueFilter,
) {
  const queueApi = api as PurchaseRequestQueueApi;
  return queueApi.GET("/api/v1/financial/purchase-requests", {
    params: {
      query: {
        branch_id: filter.branchId,
        status: filter.statuses,
        limit: filter.limit,
        offset: filter.offset,
      },
    },
  });
}
