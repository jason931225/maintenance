import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { productionStrings as text } from "../../i18n/production";
import type { DailyPlan } from "./productionApi";
import type { ProductionCapabilities } from "./productionCapabilities";
import { ProductionScreen } from "./ProductionScreen";

const planner: ProductionCapabilities = { canRead: true, canCreate: true, canRequestReview: true, canReview: false, canConfirm: true, canTriage: false };
const reviewer: ProductionCapabilities = { canRead: true, canCreate: false, canRequestReview: false, canReview: true, canConfirm: false, canTriage: false };
const denied: ProductionCapabilities = { canRead: false, canCreate: false, canRequestReview: false, canReview: false, canConfirm: false, canTriage: false };
const plan = (status: DailyPlan["status"] = "DRAFT", branchId = "branch-1"): DailyPlan => ({
  id: "plan-1", branch_id: branchId, mechanic_id: "mechanic-1", plan_date: "2026-07-23", status,
  items: [{ sort_order: 1, description: "현장 점검", work_order_id: "work-1" }],
});

function ok<T>(data: T) {
  return { data, response: new Response(null, { status: 200 }) };
}

function client() {
  return { GET: vi.fn(), POST: vi.fn() } as unknown as ConsoleApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderScreen(capabilities = planner, sessionKey = "session-a", api = client(), branchId = "branch-1") {
  return render(<ProductionScreen api={api} branchId={branchId} actorId="mechanic-1" capabilities={capabilities} sessionKey={sessionKey} />);
}

describe("ProductionScreen", () => {
  it("denies an unauthorized user before fetching or exposing actions", () => {
    const api = client();
    renderScreen(denied, "session-a", api);
    expect(screen.getByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("button", { name: text.create })).toBeNull();
    expect(api.GET).not.toHaveBeenCalled();
  });

  it("retries an initial error and renders the backend list", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValueOnce(ok(undefined)).mockResolvedValueOnce(ok({ items: [plan()] }));
    renderScreen(planner, "session-a", api);
    expect(await screen.findByRole("alert")).toHaveTextContent("Production request failed (200)");
    await userEvent.click(screen.getByRole("button", { name: text.retry }));
    expect(await screen.findByRole("button", { name: /2026-07-23/ })).toBeVisible();
    expect(api.GET).toHaveBeenCalledTimes(2);
  });

  it("uses native keyboard activation to reveal a selected plan and planner action", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ items: [plan()] }));
    renderScreen(planner, "session-a", api);
    const choice = await screen.findByRole("button", { name: /2026-07-23/ });
    expect(choice).toHaveTextContent(text.status.DRAFT);
    expect(screen.queryByText("DRAFT")).toBeNull();
    choice.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: text.requestReview })).toBeVisible();
  });

  it("offers review controls only to the effective reviewer capability", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ items: [plan("REQUESTED")] }));
    renderScreen(reviewer, "session-a", api);
    await userEvent.click(await screen.findByRole("button", { name: /2026-07-23/ }));
    expect(screen.getByRole("button", { name: text.approve })).toBeVisible();
    expect(screen.queryByRole("button", { name: text.create })).toBeNull();
  });

  it("reconciles a write from the returned backend plan rather than a local success state", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ items: [plan()] }));
    vi.mocked(api.POST).mockResolvedValue(ok(plan("REQUESTED")));
    renderScreen(planner, "session-a", api);
    await userEvent.click(await screen.findByRole("button", { name: /2026-07-23/ }));
    await userEvent.click(screen.getByRole("button", { name: text.requestReview }));
    await waitFor(() => { expect(screen.getAllByText(text.status.REQUESTED)).not.toHaveLength(0); });
    expect(screen.queryByRole("button", { name: text.requestReview })).toBeNull();
  });

  it("fences stale list responses when the authenticated API client changes", async () => {
    const first = deferred<ReturnType<typeof ok<{ items: DailyPlan[] }>>>();
    const apiA = client();
    const apiB = client();
    vi.mocked(apiA.GET).mockReturnValue(first.promise);
    vi.mocked(apiB.GET).mockResolvedValue(ok({ items: [plan("REQUESTED")] }));
    const view = renderScreen(planner, "session-a", apiA);
    await waitFor(() => { expect(apiA.GET).toHaveBeenCalledTimes(1); });
    view.rerender(<ProductionScreen api={apiB} branchId="branch-1" actorId="mechanic-1" capabilities={reviewer} sessionKey="session-a" />);
    expect(await screen.findByRole("button", { name: /2026-07-23/ })).toHaveTextContent(text.status.REQUESTED);
    first.resolve(ok({ items: [plan()] }));
    await waitFor(() => { expect(screen.getByRole("button", { name: /2026-07-23/ })).toHaveTextContent(text.status.REQUESTED); });
  });

  it("filters mixed branch results before presenting the queue", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ items: [plan(), { ...plan("REQUESTED"), id: "other-plan", branch_id: "branch-2" }] }));
    renderScreen(planner, "session-a", api);
    expect(await screen.findByRole("button", { name: /2026-07-23/ })).toBeVisible();
    expect(screen.queryByText(text.status.REQUESTED)).toBeNull();
  });
});
