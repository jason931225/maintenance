import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { productionStrings as text } from "../../i18n/production";
import { productionApi, type DailyPlan } from "./productionApi";
import type { ProductionCapabilities } from "./productionCapabilities";
import { ProductionScreen } from "./ProductionScreen";

const planner: ProductionCapabilities = { canRead: true, canCreate: true, canRequestReview: true, canReview: false, canConfirm: true, canTriage: false };
const reviewer: ProductionCapabilities = { canRead: true, canCreate: false, canRequestReview: false, canReview: true, canConfirm: false, canTriage: false };
const denied: ProductionCapabilities = { canRead: false, canCreate: false, canRequestReview: false, canReview: false, canConfirm: false, canTriage: false };
const plan = (status: DailyPlan["status"] = "DRAFT"): DailyPlan => ({
  id: "plan-1", branch_id: "branch-1", mechanic_id: "mechanic-1", plan_date: "2026-07-23", status,
  items: [{ sort_order: 1, description: "현장 점검", work_order_id: "work-1" }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderScreen(capabilities = planner, sessionKey = "session-a") {
  return render(<ProductionScreen branchId="branch-1" actorId="mechanic-1" capabilities={capabilities} sessionKey={sessionKey} />);
}

describe("ProductionScreen", () => {
  afterEach(() => vi.restoreAllMocks());

  it("denies an unauthorized user before fetching or exposing actions", () => {
    const list = vi.spyOn(productionApi, "list");
    renderScreen(denied);
    expect(screen.getByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("button", { name: text.create })).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("retries an initial error and renders the backend list", async () => {
    const list = vi.spyOn(productionApi, "list")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ items: [plan()] });
    renderScreen();
    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
    await userEvent.click(screen.getByRole("button", { name: text.retry }));
    expect(await screen.findByRole("button", { name: /2026-07-23/ })).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("uses native keyboard activation to reveal a selected plan and planner action", async () => {
    vi.spyOn(productionApi, "list").mockResolvedValue({ items: [plan()] });
    renderScreen();
    const choice = await screen.findByRole("button", { name: /2026-07-23/ });
    choice.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: text.requestReview })).toBeVisible();
    expect(choice).toHaveAttribute("aria-pressed", "true");
  });

  it("offers review controls only to the effective reviewer capability", async () => {
    vi.spyOn(productionApi, "list").mockResolvedValue({ items: [plan("REQUESTED")] });
    renderScreen(reviewer);
    await userEvent.click(await screen.findByRole("button", { name: /2026-07-23/ }));
    expect(screen.getByRole("button", { name: text.approve })).toBeVisible();
    expect(screen.getByRole("button", { name: text.reject })).toBeVisible();
    expect(screen.queryByRole("button", { name: text.create })).toBeNull();
  });

  it("reconciles a write from the returned backend plan rather than a local success state", async () => {
    vi.spyOn(productionApi, "list").mockResolvedValue({ items: [plan()] });
    vi.spyOn(productionApi, "requestReview").mockResolvedValue(plan("REQUESTED"));
    renderScreen();
    await userEvent.click(await screen.findByRole("button", { name: /2026-07-23/ }));
    await userEvent.click(screen.getByRole("button", { name: text.requestReview }));
    await waitFor(() => expect(screen.getAllByText("REQUESTED")).not.toHaveLength(0));
    expect(screen.queryByRole("button", { name: text.requestReview })).toBeNull();
  });

  it("ignores a stale list result after the effective session changes", async () => {
    const first = deferred<{ items: DailyPlan[] }>();
    const second = deferred<{ items: DailyPlan[] }>();
    vi.spyOn(productionApi, "list")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = renderScreen(planner, "session-a");
    view.rerender(<ProductionScreen branchId="branch-1" actorId="mechanic-1" capabilities={reviewer} sessionKey="session-b" />);
    first.resolve({ items: [plan()] });
    second.resolve({ items: [plan("REQUESTED")] });
    expect(await screen.findByRole("button", { name: /2026-07-23/ })).toHaveTextContent("REQUESTED");
    expect(screen.queryByRole("button", { name: text.create })).toBeNull();
  });
});
