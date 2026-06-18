import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { IntakeForm } from "./IntakeForm";
import { branchId, equipmentLookup, workOrders } from "../../test/fixtures";

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
        equipmentLookupState={{
          status: "ready",
          equipment: {
            managementNo: "290",
            model: "GTS25DE",
            customerName: "케이앤엘",
            siteName: "본사",
            maker: "현대",
            vin: "VIN-12345",
            vehicleRegistrationNo: "12가3456",
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "접수 저장" }));
    expect(await screen.findByText("호기를 입력하세요.")).toBeVisible();
    expect(screen.getByText("고장내용을 입력하세요.")).toBeVisible();

    await user.type(screen.getByLabelText("호기"), "#290");
    await user.type(screen.getByLabelText("고장내용"), "유압 누유로 즉시 점검 필요");
    await user.click(screen.getByRole("button", { name: "접수 저장" }));

    expect(lookup).toHaveBeenLastCalledWith("#290");
    expect(createWorkOrder).toHaveBeenCalledWith({
      branch_id: branchId,
      management_no: "#290",
      symptom: "유압 누유로 즉시 점검 필요",
      customer_request: undefined,
      target_due_at: undefined,
    });
    expect(await screen.findByText("P1 권장")).toBeVisible();
  });

  it("surfaces vehicle fields and records the maintenance category in customer_request", async () => {
    const user = userEvent.setup();
    const createWorkOrder = vi.fn().mockResolvedValue(workOrders[0]);

    render(
      <IntakeForm
        branchId={branchId}
        onCreateWorkOrder={createWorkOrder}
        equipmentLookupState={{
          status: "ready",
          equipment: {
            managementNo: "290",
            model: "GTS25DE",
            customerName: "케이앤엘",
            siteName: "본사",
            maker: "현대",
            vin: "VIN-12345",
            vehicleRegistrationNo: "12가3456",
          },
        }}
      />,
    );

    // Vehicle (차량) fields from the equipment master are surfaced.
    expect(screen.getByText("VIN-12345")).toBeVisible();
    expect(screen.getByText("12가3456")).toBeVisible();
    expect(screen.getByText("현대")).toBeVisible();

    await user.type(screen.getByLabelText("호기"), "290");
    await user.type(screen.getByLabelText("고장내용"), "정기 점검");
    await user.selectOptions(screen.getByLabelText("정비 분류"), "REGULAR");
    await user.type(screen.getByLabelText("고객 요청사항"), "오전 방문 요청");
    await user.click(screen.getByRole("button", { name: "접수 저장" }));

    expect(createWorkOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        management_no: "290",
        symptom: "정기 점검",
        customer_request: "[정비 분류: 정기 점검] 오전 방문 요청",
      }),
    );
  });
});
