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

  it("is a manager queue surface and does not impersonate a technician offer response", async () => {
    const GET = respondingGet();
    render(<DispatchConsole api={client(GET)} />);
    fireEvent.click(await screen.findByRole("button", { name: /WO-001/i }));
    await screen.findByRole("heading", { name: "P1 dispatch" });
    expect(screen.queryByRole("button", { name: "Accept broadcast" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline broadcast" })).not.toBeInTheDocument();
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

  it("keeps declined candidates audit-visible but unavailable for force assignment", async () => {
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/console/dispatch/queue") return Promise.resolve(result(queue));
      if (path === "/api/v1/p1-dispatches/{dispatchId}") return Promise.resolve(result(summary));
      if (path.endsWith("/candidates")) return Promise.resolve(result({ items: [{ ...candidatePage.items[0], response: "DECLINE" }] }));
      if (path.endsWith("/responses")) return Promise.resolve(result(responsePage));
      throw new Error(`unexpected ${path}`);
    });
    render(<DispatchConsole api={client(GET)} />);
    fireEvent.click(await screen.findByRole("button", { name: /WO-001/i }));
    const declined = await screen.findByRole("radio", { name: "Select mechanic mechanic-7" });
    expect(declined).toBeDisabled();
    expect(screen.getAllByText("DECLINE").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Force assign selected candidate" })).toBeDisabled();
  });

  it("invalidates stale detail when a retained work order changes P1 dispatch authority", async () => {
    let queueCalls = 0;
    let firstSummaryResolve: ((value: ReturnType<typeof result>) => void) | undefined;
    let summaryCalls = 0;
    const firstSummary = new Promise<ReturnType<typeof result>>((resolve) => { firstSummaryResolve = resolve; });
    const nextSummary = { ...summary, id: "dispatch-2", status: "BROADCASTING" };
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/console/dispatch/queue") {
        queueCalls += 1;
        return Promise.resolve(result(queueCalls === 1 ? queue : {
          ...queue,
          items: [{ ...queue.items[0], dispatch: { ...queue.items[0].dispatch, id: "dispatch-2", status: "BROADCASTING" } }],
        }));
      }
      if (path === "/api/v1/p1-dispatches/{dispatchId}") {
        summaryCalls += 1;
        return summaryCalls === 1 ? firstSummary : Promise.resolve(result(nextSummary));
      }
      if (path.endsWith("/candidates")) return Promise.resolve(result(candidatePage));
      if (path.endsWith("/responses")) return Promise.resolve(result(responsePage));
      throw new Error(`unexpected ${path}`);
    });
    render(<DispatchConsole api={client(GET)} />);
    fireEvent.click(await screen.findByRole("button", { name: /WO-001/i }));
    await waitFor(() => { expect(GET).toHaveBeenCalledWith("/api/v1/p1-dispatches/{dispatchId}", expect.anything()); });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => { expect(GET.mock.calls.filter(([path]) => path === "/api/v1/p1-dispatches/{dispatchId}").length).toBeGreaterThan(1); });
    firstSummaryResolve?.(result(summary));
    expect((await screen.findAllByText("BROADCASTING")).length).toBeGreaterThan(0);
    expect(screen.queryByText("MANAGER_FORCE_PENDING")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force assign selected candidate" })).not.toBeInTheDocument();
  });

  it("clears selected detail when a refreshed queue no longer contains its work order", async () => {
    let queueCalls = 0;
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/console/dispatch/queue") {
        queueCalls += 1;
        return Promise.resolve(result(queueCalls === 1 ? queue : { items: [], stats: { unassigned_count: 0, sla_due_count: 0 } }));
      }
      if (path === "/api/v1/p1-dispatches/{dispatchId}") return Promise.resolve(result(summary));
      if (path.endsWith("/candidates")) return Promise.resolve(result(candidatePage));
      if (path.endsWith("/responses")) return Promise.resolve(result(responsePage));
      throw new Error(`unexpected ${path}`);
    });
    render(<DispatchConsole api={client(GET)} />);
    fireEvent.click(await screen.findByRole("button", { name: /WO-001/i }));
    expect(await screen.findByRole("heading", { name: "P1 dispatch" })).toBeVisible();
    fireEvent.click(screen.getByLabelText("Received"));
    await waitFor(() => { expect(screen.queryByRole("heading", { name: "P1 dispatch" })).not.toBeInTheDocument(); });
    expect(screen.getByText("No work orders match the selected dispatch statuses.")).toBeVisible();
  });

  it.each([401, 403])("contains force-assignment authorization status %s as a fail-closed user-visible state", async (status) => {
    const GET = respondingGet();
    const POST = vi.fn().mockResolvedValue({ error: { error: { message: "denied" } }, response: new Response(null, { status }) });
    render(<DispatchConsole api={client(GET, POST)} />);
    fireEvent.click(await screen.findByRole("button", { name: /WO-001/i }));
    fireEvent.click(await screen.findByRole("radio", { name: "Select mechanic mechanic-7" }));
    fireEvent.click(screen.getByRole("button", { name: "Force assign selected candidate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not authorized to force assign");
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it.each([409, 500])("contains force-assignment status %s without an unhandled mutation", async (status) => {
    const GET = respondingGet();
    const POST = vi.fn().mockResolvedValue({ error: { error: { message: "conflict" } }, response: new Response(null, { status }) });
    render(<DispatchConsole api={client(GET, POST)} />);
    fireEvent.click(await screen.findByRole("button", { name: /WO-001/i }));
    fireEvent.click(await screen.findByRole("radio", { name: "Select mechanic mechanic-7" }));
    fireEvent.click(screen.getByRole("button", { name: "Force assign selected candidate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Force assignment was not confirmed");
  });

  it("contains a force-assignment network failure", async () => {
    const GET = respondingGet();
    const POST = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    render(<DispatchConsole api={client(GET, POST)} />);
    fireEvent.click(await screen.findByRole("button", { name: /WO-001/i }));
    fireEvent.click(await screen.findByRole("radio", { name: "Select mechanic mechanic-7" }));
    fireEvent.click(screen.getByRole("button", { name: "Force assign selected candidate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Force assignment was not confirmed");
  });

  it("shows an explicit denied state without rendering queue records", async () => {
    const GET = vi.fn().mockResolvedValue({ error: { error: { message: "denied" } }, response: new Response(null, { status: 403 }) });
    render(<DispatchConsole api={client(GET)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not authorized to read the dispatch queue");
    expect(screen.queryByRole("button", { name: /WO-/i })).not.toBeInTheDocument();
  });
});
