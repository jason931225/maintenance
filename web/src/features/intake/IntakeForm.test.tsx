import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { IntakeForm } from "./IntakeForm";
import type { CreateWorkOrderRequest } from "../../api/types";
import { branchId, equipmentLookup, workOrders } from "../../test/fixtures";

const readyEquipment = {
  status: "ready" as const,
  equipment: {
    managementNo: "290",
    model: "GTS25DE",
    customerName: "케이앤엘",
    siteName: "본사",
    maker: "현대",
    vin: "VIN-12345",
    vehicleRegistrationNo: "12가3456",
  },
};

describe("IntakeForm", () => {
  it("validates required fields and submits createWorkOrder through the generated API client", async () => {
    const user = userEvent.setup();
    const createWorkOrder = vi.fn().mockResolvedValue(workOrders[0]);
    const lookup = vi.fn();

    render(
      <IntakeForm
        branchId={branchId}
        onCreateWorkOrder={createWorkOrder}
        onManagementNoChange={lookup}
        equipmentSuggestions={[equipmentLookup]}
        equipmentLookupState={readyEquipment}
      />,
    );

    // The required fields surface validation errors; 요청일자 defaults to today.
    await user.click(screen.getByRole("button", { name: "접수 저장" }));
    expect(await screen.findByText("호기를 입력하세요.")).toBeVisible();
    expect(screen.getByText("고장내용을 입력하세요.")).toBeVisible();
    expect(screen.getByText("정비문의 연락처를 입력하세요.")).toBeVisible();

    await user.type(screen.getByLabelText(/호기/), "#290");
    await user.type(screen.getByLabelText(/고장내용/), "유압 누유로 즉시 점검 필요");
    await user.type(screen.getByLabelText(/정비문의/), "010-2625-0987");
    await user.click(screen.getByRole("button", { name: "접수 저장" }));

    expect(lookup).toHaveBeenLastCalledWith("#290");
    expect(createWorkOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        branch_id: branchId,
        management_no: "#290",
        symptom: "유압 누유로 즉시 점검 필요",
        // 요청일자 + 정비문의 are folded into the structured customer_request.
        customer_request: expect.stringContaining("[정비문의: 010-2625-0987]"),
        target_due_at: undefined,
      }),
    );
    const firstCall = createWorkOrder.mock.calls[0][0] as CreateWorkOrderRequest;
    expect(firstCall.customer_request).toMatch(/\[요청일자: \d{4}-\d{2}-\d{2}\]/);
    expect(await screen.findByText("P1 권장")).toBeVisible();
  });

  it("marks the required fields with a visible asterisk and aria-required", () => {
    render(
      <IntakeForm
        branchId={branchId}
        onCreateWorkOrder={vi.fn()}
        equipmentLookupState={readyEquipment}
      />,
    );

    expect(screen.getByLabelText(/호기/)).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByLabelText(/요청일자/)).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByLabelText(/고장내용/)).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByLabelText(/정비문의/)).toHaveAttribute(
      "aria-required",
      "true",
    );
    // Required fields render a visible "*" marker (4 of them).
    expect(screen.getAllByText("*")).toHaveLength(4);
  });

  it("surfaces vehicle fields and records the maintenance category in customer_request", async () => {
    const user = userEvent.setup();
    const createWorkOrder = vi.fn().mockResolvedValue(workOrders[0]);

    render(
      <IntakeForm
        branchId={branchId}
        onCreateWorkOrder={createWorkOrder}
        equipmentLookupState={readyEquipment}
      />,
    );

    // Vehicle (차량) fields from the equipment master are surfaced.
    expect(screen.getByText("VIN-12345")).toBeVisible();
    expect(screen.getByText("12가3456")).toBeVisible();
    expect(screen.getByText("현대")).toBeVisible();

    await user.type(screen.getByLabelText(/호기/), "290");
    await user.type(screen.getByLabelText(/고장내용/), "정기 점검");
    await user.type(screen.getByLabelText(/정비문의/), "010-2625-0987");
    await user.selectOptions(screen.getByLabelText("정비 분류"), "REGULAR");
    await user.type(screen.getByLabelText("고객 요청사항"), "오전 방문 요청");
    await user.click(screen.getByRole("button", { name: "접수 저장" }));

    const sentCall = createWorkOrder.mock.calls[0][0] as CreateWorkOrderRequest;
    const sentRequest = sentCall.customer_request ?? "";
    expect(sentRequest).toContain("[정비 분류: 정기 점검]");
    expect(sentRequest).toContain("[정비문의: 010-2625-0987]");
    expect(sentRequest).toContain("오전 방문 요청");
  });
});
