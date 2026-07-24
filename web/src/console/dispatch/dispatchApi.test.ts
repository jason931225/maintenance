import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import {
  DispatchApiContractError,
  forceAssignP1Dispatch,
  listDispatchQueue,
  respondToP1Dispatch,
} from "./dispatchApi";

function response(data: unknown) {
  return { data, response: new Response(null, { status: 200 }) };
}

function client(get = vi.fn(), post = vi.fn()): ConsoleApiClient {
  return { GET: get, POST: post } as unknown as ConsoleApiClient;
}

const queuePage = {
  items: [{
    work_order_id: "work-order-1", request_no: "WO-001", branch_id: "branch-1", status: "UNASSIGNED", priority: "P1",
    symptom: "Cooling failure", equipment_id: "equipment-1", customer_id: "customer-1", site_id: "site-1", updated_at: "2026-07-24T00:00:00Z",
  }],
  next_after: "opaque-next-token",
  stats: { unassigned_count: 1, sla_due_count: 0 },
};

const summary = {
  id: "dispatch-1", work_order_id: "work-order-1", branch_id: "branch-1", status: "MANAGER_FORCE_PENDING",
  accept_window_started_at: "2026-07-24T00:00:00Z", accept_window_ends_at: "2026-07-24T00:10:00Z",
  manual_call_required: false, target_count: 2, accepted_count: 0, declined_count: 1,
};

describe("dispatchApi", () => {
  it("uses the generated queue path with typed status filters and opaque cursor", async () => {
    const GET = vi.fn().mockResolvedValue(response(queuePage));
    await expect(listDispatchQueue(client(GET), { status: ["UNASSIGNED", "DELAYED"], after: "opaque-input" })).resolves.toEqual(queuePage);
    expect(GET).toHaveBeenCalledWith("/api/v1/console/dispatch/queue", expect.objectContaining({
      params: { query: { status: ["UNASSIGNED", "DELAYED"], limit: 50, after: "opaque-input" } },
      querySerializer: { array: { style: "form", explode: false } },
    }));
  });

  it("fails closed when a queue page omits a required work-order field", async () => {
    const malformed = { ...queuePage, items: [{ ...queuePage.items[0], symptom: undefined }] };
    await expect(listDispatchQueue(client(vi.fn().mockResolvedValue(response(malformed))), { status: [] })).rejects.toBeInstanceOf(DispatchApiContractError);
  });

  it("sends only generated response and force-assignment bodies", async () => {
    const POST = vi.fn().mockResolvedValue(response(summary));
    const api = client(vi.fn(), POST);
    await expect(respondToP1Dispatch(api, "dispatch-1", "ACCEPT")).resolves.toEqual(summary);
    await expect(forceAssignP1Dispatch(api, "dispatch-1", "mechanic-7")).resolves.toEqual(summary);
    expect(POST).toHaveBeenNthCalledWith(1, "/api/v1/p1-dispatches/{dispatchId}/responses", {
      params: { path: { dispatchId: "dispatch-1" } }, body: { response: "ACCEPT" },
    });
    expect(POST).toHaveBeenNthCalledWith(2, "/api/v1/p1-dispatches/{dispatchId}/force-assign", {
      params: { path: { dispatchId: "dispatch-1" } }, body: { mechanic_id: "mechanic-7" },
    });
  });
});
