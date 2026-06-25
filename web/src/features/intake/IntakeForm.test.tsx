import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
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

// The success banner deep-links to the work-order detail via <Link>, so the
// form must render inside a router context.
function renderForm(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("IntakeForm", () => {
  it("validates required fields and submits createWorkOrder through the generated API client", async () => {
    const user = userEvent.setup();
    const createWorkOrder = vi.fn().mockResolvedValue(workOrders[0]);
    const lookup = vi.fn();

    renderForm(
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
    // The submitter cannot set 중요도; priority is server-assigned and the
    // request carries no priority field (admin classifies the intake afterward).
    expect("priority" in firstCall).toBe(false);
  });

  it("reads the request_no back and deep-links to the work-order detail on success", async () => {
    const user = userEvent.setup();
    const createWorkOrder = vi.fn().mockResolvedValue(workOrders[0]);

    renderForm(
      <IntakeForm
        branchId={branchId}
        onCreateWorkOrder={createWorkOrder}
        equipmentLookupState={readyEquipment}
      />,
    );

    await user.type(screen.getByLabelText(/호기/), "290");
    await user.type(screen.getByLabelText(/고장내용/), "유압 누유");
    await user.type(screen.getByLabelText(/정비문의/), "010-2625-0987");
    await user.click(screen.getByRole("button", { name: "접수 저장" }));

    // The success banner reads the returned request_no back to the caller and
    // links to the new detail view (the intake dead-end fix).
    const banner = await screen.findByRole("status");
    expect(within(banner).getByText(/20260612-001/)).toBeVisible();
    const link = within(banner).getByRole("link", { name: "작업지시 보기" });
    expect(link).toHaveAttribute(
      "href",
      `/work-orders/${workOrders[0].id}`,
    );

    // The equipment context (호기) is preserved instead of full-reset, while the
    // per-request 고장내용 field is cleared for the next intake.
    expect(screen.getByLabelText(/호기/)).toHaveValue("290");
    expect(screen.getByLabelText(/고장내용/)).toHaveValue("");
  });

  it("does not expose a priority control or auto-filled priority hint to the submitter", () => {
    renderForm(
      <IntakeForm
        branchId={branchId}
        onCreateWorkOrder={vi.fn()}
        equipmentLookupState={readyEquipment}
      />,
    );

    // No 중요도/우선순위 selector and no "P2 권장"/"P1 권장" recommendation badge.
    expect(screen.queryByText("P2 권장")).not.toBeInTheDocument();
    expect(screen.queryByText("P1 권장")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/중요도/)).not.toBeInTheDocument();
  });

  it("marks the required fields with a visible asterisk and aria-required", () => {
    renderForm(
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

    renderForm(
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
