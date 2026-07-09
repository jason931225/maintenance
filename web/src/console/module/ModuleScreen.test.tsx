import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ko } from "../../i18n/ko";
import { demoTickets, demoWorkOrders } from "../../test/module-fixtures";
import { PolicyGateProvider } from "../policy/PolicyGated";
import { ModuleScreen } from "./ModuleScreen";
import type { ModuleConfig } from "./config";
import { supportTicketModuleConfig, workOrderModuleConfig } from "./moduleConfigs";

const SP = ko.console.module.support;

function renderSupport(opts?: { decide?: (a: string) => boolean; initialOpenId?: string }) {
  return render(
    <PolicyGateProvider decide={opts?.decide ?? (() => true)}>
      <ModuleScreen
        config={supportTicketModuleConfig}
        rows={demoTickets}
        loadState="idle"
        initialOpenId={opts?.initialOpenId}
        onPrimaryAction={() => undefined}
      />
    </PolicyGateProvider>,
  );
}

function rowEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-row-id="${id}"]`);
  if (!el) throw new Error(`row ${id} not found`);
  return el as HTMLElement;
}

describe("ModuleScreen — list grammar", () => {
  it("navigates rows with J/K and opens the selected row with Enter", () => {
    const { container } = renderSupport();
    const grid = screen.getByRole("grid");

    fireEvent.keyDown(grid, { key: "j" }); // select first
    expect(rowEl(container, demoTickets[0].id).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(grid, { key: "j" }); // advance to second
    expect(rowEl(container, demoTickets[1].id).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(grid, { key: "k" }); // back to first
    expect(rowEl(container, demoTickets[0].id).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(grid, { key: "Enter" }); // open detail
    expect(screen.getByLabelText(demoTickets[0].title)).toBeInTheDocument();
  });

  it("clamps J at the last row and K at the first", () => {
    const { container } = renderSupport();
    const grid = screen.getByRole("grid");
    for (let i = 0; i < demoTickets.length + 3; i += 1) fireEvent.keyDown(grid, { key: "j" });
    expect(rowEl(container, demoTickets[demoTickets.length - 1].id).getAttribute("aria-selected")).toBe("true");
    for (let i = 0; i < demoTickets.length + 3; i += 1) fireEvent.keyDown(grid, { key: "k" });
    expect(rowEl(container, demoTickets[0].id).getAttribute("aria-selected")).toBe("true");
  });

  it("multi-attribute search narrows the list by title and requester", async () => {
    const user = userEvent.setup();
    renderSupport();
    expect(screen.getByText(demoTickets[0].title)).toBeInTheDocument();
    expect(screen.getByText(demoTickets[1].title)).toBeInTheDocument();

    await user.type(screen.getByLabelText(ko.console.search.label), "계약");
    // Only the "임대 계약 연장 요청" ticket matches.
    expect(screen.queryByText(demoTickets[0].title)).not.toBeInTheDocument();
    expect(screen.getByText(demoTickets[1].title)).toBeInTheDocument();
  });
});

describe("ModuleScreen — config-driven rendering (one component, two domains)", () => {
  it("renders the support config as a shared-track table", () => {
    const { container } = renderSupport();
    expect(screen.getByRole("grid")).toHaveAttribute("data-fidelity", "module-list");
    expect(screen.getByText(SP.title)).toBeInTheDocument();
    expect(screen.getByText(demoTickets[0].title)).toBeInTheDocument();
    // statbar derives counts from the rows ("전체" only appears here)
    const statbar = container.querySelector('[data-fidelity="module-statbar"]');
    expect(statbar).not.toBeNull();
    expect(within(statbar as HTMLElement).getByText(SP.stat.total)).toBeInTheDocument();
  });

  it("renders the work-order config as a kanban board through the SAME component", () => {
    render(
      <PolicyGateProvider decide={() => true}>
        <ModuleScreen config={workOrderModuleConfig} rows={demoWorkOrders} loadState="idle" />
      </PolicyGateProvider>,
    );
    const board = screen.getByRole("grid");
    expect(board).toHaveAttribute("data-fidelity", "module-lanes");
    // lanes come from the config's `field.lanes` derivation
    expect(within(board).getByText(ko.console.module.workOrder.lane.unassigned)).toBeInTheDocument();
    expect(within(board).getByText(ko.console.module.workOrder.lane.review)).toBeInTheDocument();
  });
});

describe("ModuleScreen — PolicyGated affordances (deny-by-omission)", () => {
  it("omits the detail primary action when the policy denies it", () => {
    renderSupport({ decide: () => false, initialOpenId: demoTickets[0].id });
    expect(screen.queryByText(SP.resolve)).not.toBeInTheDocument();
    expect(screen.queryByTestId("module-primary-action")).not.toBeInTheDocument();
  });

  it("renders the action when the policy permits it", () => {
    renderSupport({ decide: () => true, initialOpenId: demoTickets[0].id });
    expect(screen.getByText(SP.resolve)).toBeInTheDocument();
    expect(screen.getByTestId("module-primary-action")).toBeInTheDocument();
  });
});

describe("ModuleScreen — generic fields", () => {
  it("renders a progress bar for a `prog` field", () => {
    const progConfig: ModuleConfig<(typeof demoTickets)[number]> = {
      ...supportTicketModuleConfig,
      field: { kind: "prog", progress: () => ({ done: 1, total: 3 }) },
    };
    const { container } = render(
      <PolicyGateProvider decide={() => true}>
        <ModuleScreen config={progConfig} rows={demoTickets} loadState="idle" />
      </PolicyGateProvider>,
    );
    const prog = container.querySelector('[data-fidelity="module-prog"]');
    expect(prog?.textContent).toContain("1 / 3");
  });

  it("throws a dev-loud error for a declared-but-unimplemented field (no silent stub)", () => {
    const stockConfig: ModuleConfig<(typeof demoTickets)[number]> = {
      ...supportTicketModuleConfig,
      field: { kind: "stock" },
    };
    // Suppress React's error logging for the intentional throw.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <PolicyGateProvider decide={() => true}>
          <ModuleScreen config={stockConfig} rows={demoTickets} loadState="idle" />
        </PolicyGateProvider>,
      ),
    ).toThrow(/not yet implemented/);
    spy.mockRestore();
  });
});

describe("ModuleScreen — load states", () => {
  it("shows loading then error-with-retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <PolicyGateProvider decide={() => true}>
        <ModuleScreen config={supportTicketModuleConfig} rows={[]} loadState="loading" />
      </PolicyGateProvider>,
    );
    expect(screen.getByText(ko.console.module.list.loading)).toBeInTheDocument();

    rerender(
      <PolicyGateProvider decide={() => true}>
        <ModuleScreen config={supportTicketModuleConfig} rows={[]} loadState="error" onRetry={onRetry} />
      </PolicyGateProvider>,
    );
    fireEvent.click(screen.getByText(ko.console.module.list.retry));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
