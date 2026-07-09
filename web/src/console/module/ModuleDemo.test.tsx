import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { demoTickets, demoWorkOrders } from "../../test/module-fixtures";
import { ModuleDemo, type ModuleDemoState } from "./ModuleDemo";

function renderState(state: ModuleDemoState) {
  return render(<ModuleDemo state={state} tickets={demoTickets} workOrders={demoWorkOrders} />);
}

describe("ModuleDemo (fidelity states)", () => {
  it("renders the list state as a shared-track table", () => {
    const { container } = renderState("list");
    expect(container.querySelector('[data-fidelity="module-list"]')).toBeInTheDocument();
    expect(container.querySelector('[data-fidelity="module-lanes"]')).not.toBeInTheDocument();
  });

  it("renders the detail-open state with a detail panel", () => {
    const { container } = renderState("detail-open");
    expect(container.querySelector('[data-fidelity="module-detail"]')).toBeInTheDocument();
    expect(container.querySelector('[data-fidelity="module-list"]')).toBeInTheDocument();
  });

  it("renders the lanes state as a kanban board", () => {
    const { container } = renderState("lanes");
    expect(container.querySelector('[data-fidelity="module-lanes"]')).toBeInTheDocument();
    expect(container.querySelector('[data-fidelity="module-list"]')).not.toBeInTheDocument();
  });
});
