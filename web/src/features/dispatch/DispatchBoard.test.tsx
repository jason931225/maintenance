import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DispatchBoard } from "./DispatchBoard";
import { primaryMechanicId, workOrders } from "../../test/fixtures";

describe("DispatchBoard", () => {
  it("groups work orders by dispatch status and assigns a dropped card through the callback", async () => {
    const user = userEvent.setup();
    const assign = vi.fn().mockResolvedValue(undefined);

    render(
      <DispatchBoard
        workOrders={workOrders}
        selectedMechanicId={primaryMechanicId}
        onAssignWorkOrder={assign}
      />,
    );

    expect(screen.getByRole("heading", { name: "접수" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "배정" })).toBeVisible();
    expect(screen.getByText("20260612-001")).toBeVisible();
    expect(screen.getByText("P1")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "20260612-001 배정" }));

    expect(assign).toHaveBeenCalledWith(workOrders[0].id, primaryMechanicId);
  });
});
