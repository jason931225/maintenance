import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { FinanceModuleScreen } from "./FinanceModuleScreen";
import { GenericModuleScreen } from "./GenericModuleScreen";
import { financeModuleScreen, FINANCE_MODULE_ACTIONS } from "./moduleScreens";
import type { ModuleScreenConfig } from "./types";

const allowGate: PolicyGate = { can: () => true };
const denyGate: PolicyGate = { can: () => false };

function renderFinance(gate: PolicyGate = allowGate) {
  return render(
    <PolicyGateProvider gate={gate}>
      <FinanceModuleScreen />
    </PolicyGateProvider>,
  );
}

const liveRowConfig: ModuleScreenConfig = {
  ...financeModuleScreen,
  id: "test-object-module",
  objectKind: "test_object",
  codePrefix: "OBJ-",
  emptyMode: "live",
  blockedChipKey: undefined,
  statbar: [],
  search: undefined,
  list: {
    ...financeModuleScreen.list,
    columns: [
      { key: "code", labelKey: "console.modules.finance.columns.code", variant: "mono" },
      { key: "status", labelKey: "console.modules.finance.columns.status", variant: "status" },
      { key: "links", labelKey: "console.modules.finance.columns.links", variant: "linkChips" },
    ],
  },
  detail: {
    fields: [
      { key: "code", labelKey: "console.modules.finance.columns.code" },
      { key: "title", labelKey: "console.modules.finance.columns.title" },
    ],
    linkChips: financeModuleScreen.detail.linkChips,
    actions: [
      {
        key: "openGraph",
        labelKey: "console.modules.finance.actions.openGraph",
        policyAction: FINANCE_MODULE_ACTIONS.graph,
      },
    ],
  },
  primaryAction: {
    key: "createVoucher",
    labelKey: "console.modules.finance.actions.createVoucher",
    policyAction: FINANCE_MODULE_ACTIONS.create,
    resourceKind: "test_object",
  },
  rows: [
    {
      id: "row-1",
      code: "OBJ-1",
      status: { labelKey: "console.modules.finance.statuses.active", tone: "ok" },
      cells: { title: "실개체" },
      detail: { title: "실개체" },
      linkChips: [
        {
          key: "graph",
          labelKey: "console.modules.finance.links.graph",
          tone: "info",
          kind: "object_graph",
          id: "graph-1",
          code: "OBJ-GRAPH",
          policyAction: FINANCE_MODULE_ACTIONS.graph,
          href: "#graph-1",
        },
      ],
    },
  ],
};

describe("FinanceModuleScreen", () => {
  it("renders the constrained finance shell without fake voucher rows or blocked actions", () => {
    const { container } = renderFinance();

    expect(screen.getByRole("heading", { name: "재무" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "콘솔 모듈" })).toBeVisible();
    expect(screen.getAllByText("전표 도메인 대기").length).toBeGreaterThan(0);
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.queryByLabelText("전표 검색")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "전표 생성" })).not.toBeInTheDocument();
    expect(screen.queryByText("검토 대기")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/VC-/);
  });

  it("omits the module when finance read policy is denied", () => {
    renderFinance(denyGate);

    expect(screen.queryByRole("heading", { name: "재무" })).not.toBeInTheDocument();
    expect(screen.queryByText("전표 도메인 대기")).not.toBeInTheDocument();
  });

  it("gates primary, row, detail, and link affordances through PolicyGated", () => {
    const readOnlyGate: PolicyGate = {
      can: (action) => action === FINANCE_MODULE_ACTIONS.read,
    };

    const { rerender } = render(
      <PolicyGateProvider gate={readOnlyGate}>
        <GenericModuleScreen config={liveRowConfig} />
      </PolicyGateProvider>,
    );

    expect(screen.getByRole("button", { name: "OBJ-1 상세 열기" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "전표 생성" })).not.toBeInTheDocument();
    expect(screen.queryByText("OBJ-GRAPH")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "그래프" })).not.toBeInTheDocument();

    rerender(
      <PolicyGateProvider gate={allowGate}>
        <GenericModuleScreen config={liveRowConfig} />
      </PolicyGateProvider>,
    );

    expect(screen.getByRole("button", { name: "전표 생성" })).toBeVisible();
    expect(screen.getAllByText("OBJ-GRAPH").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "그래프" })).toBeVisible();
  });
});
