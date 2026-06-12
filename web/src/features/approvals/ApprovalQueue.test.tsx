import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApprovalQueue } from "./ApprovalQueue";
import { workOrderListItems } from "../../test/fixtures";

describe("ApprovalQueue", () => {
  it("renders pending approval items and sends approval and reject actions with memo state", async () => {
    const user = userEvent.setup();
    const approve = vi.fn().mockResolvedValue(undefined);
    const reject = vi.fn().mockResolvedValue(undefined);

    render(
      <ApprovalQueue
        workOrders={workOrderListItems}
        onApprove={approve}
        onReject={reject}
      />,
    );

    expect(screen.getByText("20260612-002")).toBeVisible();
    expect(screen.queryByText("20260612-003")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("검토 메모"), "증빙 확인 완료");
    await user.click(screen.getByRole("button", { name: "20260612-002 승인" }));
    await user.click(screen.getByRole("button", { name: "20260612-002 반려" }));

    expect(approve).toHaveBeenCalledWith(workOrderListItems[1].id);
    expect(reject).toHaveBeenCalledWith(workOrderListItems[1].id, "증빙 확인 완료");
    expect(screen.getByDisplayValue("증빙 확인 완료")).toBeVisible();
  });
});
