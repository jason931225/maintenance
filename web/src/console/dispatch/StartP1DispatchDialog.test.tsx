import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StartP1DispatchDialog } from "./StartP1DispatchDialog";

const summary = {
  id: "dispatch-1", work_order_id: "work-order-1", branch_id: "branch-1", status: "BROADCASTING" as const,
  accept_window_started_at: "2026-07-24T00:00:00Z", accept_window_ends_at: "2026-07-24T00:10:00Z",
  manual_call_required: false, target_count: 2, accepted_count: 0, declined_count: 0,
};

describe("StartP1DispatchDialog", () => {
  it("requires explicit confirmation and shows returned broadcast truth", async () => {
    const onConfirm = vi.fn().mockResolvedValue(summary);
    render(<StartP1DispatchDialog requestNo="WO-001" onCancel={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByRole("dialog", { name: "Start P1 emergency broadcast" })).toBeVisible();
    expect(screen.getByText(/No incident location or regional expansion will be inferred/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm P1 broadcast" }));
    expect(await screen.findByText("Broadcast started for WO-001.")).toBeVisible();
    expect(screen.getByText("BROADCASTING")).toBeVisible();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
