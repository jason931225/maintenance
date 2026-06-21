import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorkOrderList } from "./WorkOrderList";
import { workOrderListItems } from "../../test/fixtures";

describe("WorkOrderList", () => {
  it("renders branch-scoped work orders from the read API schema", () => {
    render(<WorkOrderList workOrders={workOrderListItems} />);

    expect(screen.getByRole("heading", { name: "작업지시 목록" })).toBeVisible();
    expect(screen.getByText("20260612-001")).toBeVisible();
    expect(screen.getByText("GTS25DE")).toBeVisible();
    expect(screen.getByText(/케이앤엘/)).toBeVisible();
    expect(screen.getByText(/2026-06-12 09:00/)).toBeVisible();
  });

  it("renders the site's representative contact with a tel link when present (#13)", () => {
    render(<WorkOrderList workOrders={workOrderListItems} />);

    // The first work order's site has a registered contact (name + phone); the
    // phone renders as a single tel: link, and the second order's null contact
    // renders nothing.
    expect(screen.getByText(/현장담당 김씨/)).toBeVisible();
    const tel = screen.getByRole("link", { name: "010-2625-0987" });
    expect(tel).toHaveAttribute("href", "tel:010-2625-0987");
    expect(screen.getAllByRole("link", { name: /010-2625-0987/ })).toHaveLength(
      1,
    );
  });
});
