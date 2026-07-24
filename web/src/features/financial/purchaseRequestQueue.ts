import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";
import type { PurchaseStatus } from "../../api/types";

export type PurchaseRequestQueuePage =
  components["schemas"]["PurchaseRequestPage"];

export interface PurchaseRequestQueueFilter {
  branchId: string;
  statuses?: PurchaseStatus[];
  limit: number;
  offset: number;
}

/**
 * Generated OpenAPI now owns this route and page schema. An array value is
 * serialized by the shared client as repeated plain `status` query keys.
 */
export function listPurchaseRequestQueue(
  api: ConsoleApiClient,
  filter: PurchaseRequestQueueFilter,
  signal?: AbortSignal,
) {
  return api.GET("/api/v1/financial/purchase-requests", {
    params: {
      query: {
        branch_id: filter.branchId,
        status: filter.statuses,
        limit: filter.limit,
        offset: filter.offset,
      },
    },
    signal,
  });
}
