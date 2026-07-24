import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { DispatchConsole } from "./DispatchConsole";

function result(data: unknown) {
  return { data, response: new Response(null, { status: 200 }) };
}

function client(GET: ReturnType<typeof vi.fn>, POST = vi.fn()): ConsoleApiClient {
  return { GET, POST } as unknown as ConsoleApiClient;
}

const queue = {
  items: [{
    work_order_id: "work-order-1", request_no: "WO-001", branch_id: "branch-1", status: "UNASSIGNED", priority: "P1",
    symptom: "Cooling failure", equipment_id: "equipment-1", customer_id: "customer-1", site_id: "site-1", updated_at: "2026-07-24T00:00:00Z",
    dispatch: { id: "dispatch-1", status: "MANAGER_FORCE_PENDING", accept_window_ends_at: "2026-07-24T00:10:00Z", target_count: 2, accepted_count: 0, declined_count: 1, manual_call_required: false },
  }],
  next_after: "next-page", stats: { unassigned_count: 1, sla_due_count: 1 },
};
const queueSecond = { ...queue, items: [{ ...queue.items[0], work_order_id: "work-order-2", request_no: "WO-002" }], next_after: undefined };
const summary = {
  id: "dispatch-1", work_order_id: "work-order-1", branch_id: "branch-1", status: "MANAGER_FORCE_PENDING",
  accept_window_started_at: "2026-07-24T00:00:00Z", accept_window_ends_at: "2026-07-24T00:10:00Z",
  manual_call_required: false, target_count: 2, accepted_count: 0, declined_count: 1,
};
const candidatePage = { items: [{ mechanic_id: "mechanic-7", score_milli: 950, gps_ranked: true, workload: {}, score_reason: "nearest available" }] };
const responsePage = { items: [{ dispatch_id: "dispatch-1", user_id: "mechanic-9", response: "DECLINE", responded_at: "2026-07-24T00:02:00Z", gps_ranked: true }] };

function respondingGet() {
  return vi.fn((path: string, options?: { params?: { query?: { after?: string } } }) => {
    if (path === "/api/v1/console/dispatch/queue") return Promise.resolve(result(options?.params?.query?.after ? queueSecond : queue));
    if (path === "/api/v1/p1-dispatches/{dispatchId}") return Promise.resolve(result(summary));
    if (path.endsWith("/candidates")) return Promise.resolve(result(candidatePage));
    if (path.endsWith("/responses")) return Promise.resolve(result(responsePage));
    throw new Error(`unexpected ${path}`);
  });
}

describe("DispatchConsole", () => {
  it("loads live queue rows, follows the opaque cursor, and renders selected P1 detail", async () => {
    const GET = respondingGet();
    render(<DispatchConsole api={client(GET)} />);
    expect(await screen.findByRole("button", { name: /WO-001/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /WO-001/i }));
    expect(await screen.findByRole("heading", { name: "Ranked candidates" })).toBeVisible();
    expect(screen.getByText("nearest available")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load next queue page" }));
    expect(await screen.findByRole("button", { name: /WO-002/i })).toBeVisible();
    expect(GET).toHaveBeenLastCalledWith("/api/v1/console/dispatch/queue", expect.objectContaining({
      params: { query: expect.objectContaining({ after: "next-page" }) },
    }));
  });

  it("keeps force assignment unavailable until a current candidate is selected and refreshes after mutation", async () => {
    const GET = respondingGet();
    const POST = vi.fn().mockResolvedValue(result(summary));
    render(<DispatchConsole api={client(GET, POST)} />);
    fireEvent.click(await screen.findByRole("button", { name: /WO-001/i }));
    const force = await screen.findByRole("button", { name: "Force assign selected candidate" });
    expect(force).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Select mechanic mechanic-7" }));
    expect(force).toBeEnabled();
    fireEvent.click(force);
    await waitFor(() => { expect(POST).toHaveBeenCalledWith("/api/v1/p1-dispatches/{dispatchId}/force-assign", {
      params: { path: { dispatchId: "dispatch-1" } }, body: { mechanic_id: "mechanic-7" },
    }); });
    await waitFor(() => { expect(GET.mock.calls.filter(([path]) => path === "/api/v1/console/dispatch/queue").length).toBeGreaterThan(1); });
  });

  it("shows an explicit denied state without rendering queue records", async () => {
    const GET = vi.fn().mockResolvedValue({ error: { error: { message: "denied" } }, response: new Response(null, { status: 403 }) });
    render(<DispatchConsole api={client(GET)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not authorized to read the dispatch queue");
    expect(screen.queryByRole("button", { name: /WO-/i })).not.toBeInTheDocument();
  });
});
