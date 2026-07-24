import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { DispatchApiContractError } from "./dispatchApi";
import { startP1Dispatch } from "./startP1DispatchApi";

function client(POST: ReturnType<typeof vi.fn>): ConsoleApiClient {
  return { GET: vi.fn(), POST } as unknown as ConsoleApiClient;
}

const summary = {
  id: "dispatch-1", work_order_id: "work-order-1", branch_id: "branch-1", status: "BROADCASTING",
  accept_window_started_at: "2026-07-24T00:00:00Z", accept_window_ends_at: "2026-07-24T00:10:00Z",
  manual_call_required: false, target_count: 2, accepted_count: 0, declined_count: 0,
};

describe("startP1Dispatch", () => {
  it("uses the generated work-order path and exact no-location body", async () => {
    const POST = vi.fn().mockResolvedValue({ data: summary, response: new Response(null, { status: 200 }) });
    const controller = new AbortController();
    await expect(startP1Dispatch(client(POST), "work-order-1", controller.signal)).resolves.toEqual(summary);
    expect(POST).toHaveBeenCalledWith("/api/v1/work-orders/{workOrderId}/p1-dispatch", {
      params: { path: { workOrderId: "work-order-1" } }, body: { include_region: false }, signal: controller.signal,
    });
  });

  it("fails closed when a 2xx response is not a dispatch summary", async () => {
    const POST = vi.fn().mockResolvedValue({ data: { id: "dispatch-1" }, response: new Response(null, { status: 200 }) });
    await expect(startP1Dispatch(client(POST), "work-order-1")).rejects.toBeInstanceOf(DispatchApiContractError);
  });
});
