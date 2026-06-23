import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { WorkOrderList } from "./WorkOrderList";
import { workOrderListItems } from "../../test/fixtures";

// WorkOrderList rows deep-link to /work-orders/:id, so a router context is
// required to render the <Link>.
function renderList() {
  return render(
    <MemoryRouter>
      <WorkOrderList workOrders={workOrderListItems} />
    </MemoryRouter>,
  );
}

describe("WorkOrderList", () => {
  it("renders branch-scoped work orders from the read API schema", () => {
    renderList();

    expect(screen.getByRole("heading", { name: "작업지시 목록" })).toBeVisible();
    expect(screen.getByText("20260612-001")).toBeVisible();
    expect(screen.getByText("GTS25DE")).toBeVisible();
    expect(screen.getByText(/케이앤엘/)).toBeVisible();
    expect(screen.getByText(/2026-06-12 18:00/)).toBeVisible();
  });

  it("links each row to the work-order detail view", () => {
    renderList();

    expect(
      screen.getByRole("link", { name: "20260612-001" }),
    ).toHaveAttribute(
      "href",
      `/work-orders/${workOrderListItems[0].id}`,
    );
  });

  it("renders the site's representative contact with a tel link when present (#13)", () => {
    renderList();

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
