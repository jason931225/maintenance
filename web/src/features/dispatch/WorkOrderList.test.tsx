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
});
