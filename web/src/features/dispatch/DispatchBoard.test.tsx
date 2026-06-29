import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DispatchBoard } from "./DispatchBoard";
import { primaryMechanicId, workOrderListItems } from "../../test/fixtures";

describe("DispatchBoard", () => {
  it("groups work orders by dispatch status and assigns a dropped card through the callback", async () => {
    const user = userEvent.setup();
    const assign = vi.fn().mockResolvedValue(true);

    render(
      <DispatchBoard
        workOrders={workOrderListItems}
        selectedMechanicId={primaryMechanicId}
        onAssignWorkOrder={assign}
      />,
    );

    expect(screen.getByRole("heading", { name: "접수 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "배정 1" })).toBeVisible();
    expect(screen.getAllByText("이 단계의 작업이 없습니다.").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("20260612-001")).toBeVisible();
    expect(screen.getByText("D-25-290 · 290")).toBeVisible();
    expect(screen.getByText("케이앤엘 / 본사")).toBeVisible();
    expect(screen.getByText("긴급")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "20260612-001 배정" }));

    expect(assign).toHaveBeenCalledWith(
      workOrderListItems[0].id,
      primaryMechanicId,
    );
  });
});
