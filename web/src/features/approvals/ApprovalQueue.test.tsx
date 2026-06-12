import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApprovalQueue } from "./ApprovalQueue";
import { workOrders } from "../../test/fixtures";

describe("ApprovalQueue", () => {
  it("renders pending approval items and sends approvals with memo text retained in UI state", async () => {
    const user = userEvent.setup();
    const approve = vi.fn().mockResolvedValue(undefined);

    render(<ApprovalQueue workOrders={workOrders} onApprove={approve} />);

    expect(screen.getByText("20260612-002")).toBeVisible();
    expect(screen.queryByText("20260612-003")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("승인 메모"), "증빙 확인 완료");
    await user.click(screen.getByRole("button", { name: "20260612-002 승인" }));

    expect(approve).toHaveBeenCalledWith(workOrders[1].id);
    expect(screen.getByDisplayValue("증빙 확인 완료")).toBeVisible();
  });
});
