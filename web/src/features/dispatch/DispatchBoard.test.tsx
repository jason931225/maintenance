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

  it("keeps long work-order labels inside each Kanban card", () => {
    const longRequestNo = "20260629-001-EXTRA-LONG-DISPATCH-REFERENCE";
    const longEquipment = "EXP30-20260629-EXTRA-LONG-MANAGEMENT-NUMBER";
    render(
      <DispatchBoard
        workOrders={[
          {
            ...workOrderListItems[0],
            request_no: longRequestNo,
            equipment: {
              ...workOrderListItems[0].equipment,
              equipment_no: longEquipment,
              management_no: "LONG-MGMT-001",
            },
            customer: {
              ...workOrderListItems[0].customer,
              name: "아주긴고객명아주긴고객명아주긴고객명",
            },
            site: {
              ...workOrderListItems[0].site,
              name: "아주긴현장명아주긴현장명아주긴현장명",
            },
          },
        ]}
        selectedMechanicId={primaryMechanicId}
        onAssignWorkOrder={vi.fn().mockResolvedValue(true)}
        onSelectWorkOrder={vi.fn()}
      />,
    );

    const card = screen.getByText(longRequestNo).closest("article");
    expect(card).toHaveClass("min-w-0", "overflow-hidden");
    expect(screen.getByText(longRequestNo)).toHaveClass("break-all");
    expect(screen.getByText(/EXP30-20260629/)).toHaveClass("break-words");
    expect(
      screen.getByRole("button", { name: `${longRequestNo} 배차 제어` }),
    ).toHaveClass("whitespace-normal");
  });
});
