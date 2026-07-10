import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { WindowManagerProvider } from "../window";
import { GenericModuleScreen } from "./GenericModuleScreen";
import { assetModuleScreen } from "./moduleScreens";
import { choiceStatus } from "./typeRegistry";
import type { ModuleRow, ModuleScreenConfig } from "./types";

const allowGate: PolicyGate = { can: () => true };

const rows: ModuleRow[] = [
  {
    id: "eq-1",
    code: "EQ-1",
    title: "지게차 A",
    status: choiceStatus("equipment", "status", "rented"),
    cells: { model: "ZX-9" },
  },
  {
    id: "eq-2",
    code: "EQ-2",
    title: "지게차 B",
    status: choiceStatus("equipment", "status", "spare"),
    cells: { model: "ZX-5" },
  },
  {
    id: "eq-3",
    code: "EQ-3",
    title: "지게차 C",
    // Registry-unknown status: the board must keep the row visible, not drop it.
    status: { labelKey: "custom-state", tone: "neutral" },
    cells: {},
  },
];

const staticAsset: ModuleScreenConfig = { ...assetModuleScreen, dataAdapter: undefined, rows };
const lanesAsset: ModuleScreenConfig = {
  ...staticAsset,
  list: { ...staticAsset.list, display: "lanes" },
};

function renderScreen(config: ModuleScreenConfig, withWindows = false) {
  const body = (
    <PolicyGateProvider gate={allowGate}>
      <GenericModuleScreen config={config} />
    </PolicyGateProvider>
  );
  return render(withWindows ? <WindowManagerProvider>{body}</WindowManagerProvider> : body);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("module engine (registry-driven GenericModuleScreen)", () => {
  it("derives column labels, variants, and status chips from ONT_TYPES", () => {
    renderScreen(staticAsset);

    // No labelKey in config — the header text can only come from the registry.
    expect(screen.getByRole("columnheader", { name: "호기 번호" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "상태" })).toBeVisible();
    expect(screen.getAllByText("임대").length).toBeGreaterThan(0);

    // Rows are §4-20 drag sources.
    const codeButton = screen.getByRole("button", { name: "EQ-1 상세 열기" });
    expect(codeButton).toHaveAttribute("draggable", "true");
    expect(codeButton).toHaveAttribute("data-obj-code", "EQ-1");
  });

  it("renders registry-driven kanban lanes; a card click selects the row", () => {
    renderScreen(lanesAsset);

    const rentedLane = screen.getByRole("region", { name: "임대" });
    expect(within(rentedLane).getByRole("button", { name: /EQ-1/ })).toBeVisible();
    const spareLane = screen.getByRole("region", { name: "예비" });
    expect(within(spareLane).getByRole("button", { name: /EQ-2/ })).toBeVisible();
    // Unknown-status row lands in the trailing lane instead of disappearing.
    expect(screen.getByRole("button", { name: /EQ-3/ })).toBeVisible();

    fireEvent.click(within(spareLane).getByRole("button", { name: /EQ-2/ }));
    expect(screen.getByRole("button", { name: /EQ-2/, pressed: true })).toBeVisible();

    // §4-25 ⑧ display alternates: the toggle switches back to the table.
    const toggles = screen.getByRole("group");
    fireEvent.click(within(toggles).getAllByRole("button")[0]);
    expect(screen.getByRole("table")).toBeVisible();
  });

  it("opens the row's ObjectCard as the right pin on row select (§4.7-3)", () => {
    renderScreen(staticAsset, true);

    fireEvent.click(screen.getByRole("button", { name: "EQ-1 상세 열기" }));
    const card = screen.getByLabelText(ko.console.objectcard.panel("지게차 A"));
    expect(card).toBeVisible();
    expect(within(card).getAllByText("ZX-9").length).toBeGreaterThan(0);
  });

  it("round-trips surface→type: the OT chip opens the type's ObjectCard", () => {
    renderScreen(staticAsset, true);

    fireEvent.click(screen.getByRole("button", { name: /OT-EQUIPMENT/ }));
    const card = screen.getByLabelText(ko.console.objectcard.panel("장비"));
    expect(card).toBeVisible();
    // Schema round-trip: the type card lists registry-defined properties.
    expect(within(card).getByText("호기 번호")).toBeVisible();
  });

  it("keeps rendering when a column references an unknown registry field", () => {
    const withUnknown: ModuleScreenConfig = {
      ...staticAsset,
      list: {
        ...staticAsset.list,
        columns: [...staticAsset.list.columns, { key: "hologram" }],
      },
    };
    renderScreen(withUnknown);

    expect(screen.getByRole("columnheader", { name: "hologram" })).toBeVisible();
    expect(screen.getByRole("button", { name: "EQ-1 상세 열기" })).toBeVisible();
  });
});
