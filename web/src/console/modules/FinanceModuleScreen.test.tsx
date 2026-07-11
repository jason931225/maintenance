import { render, screen, within } from "@testing-library/react";
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
  it("renders the final-shape finance shell (no blocked-domain placeholder) without fake voucher rows when no api/session backs it", () => {
    const { container } = renderFinance();

    expect(screen.getByRole("heading", { name: "재무" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "콘솔 모듈" })).toBeVisible();
    // The "전표 도메인 대기" blocked-until-backend placeholder is gone for good —
    // emptyMode is "live" now.
    expect(screen.queryAllByText("전표 도메인 대기")).toHaveLength(0);
    expect(screen.getByRole("table")).toBeVisible();
    // No api/session (this bare shell has neither) → the real 전표 기안 CTA still
    // renders (final shape), it is just inert until a session/api mounts it.
    expect(screen.getByRole("button", { name: "전표 생성" })).toBeVisible();
    // No rows without a real backend read — never fabricate display data.
    expect(container).not.toHaveTextContent(/VC-/);
  });

  it("omits the module when finance read policy is denied", () => {
    renderFinance(denyGate);

    expect(screen.queryByRole("heading", { name: "재무" })).not.toBeInTheDocument();
    expect(screen.queryByText("전표 도메인 대기")).not.toBeInTheDocument();
  });

  it("keeps code/identifier cells single-line so 전표 코드 never collapses to one char per line beside the detail split", () => {
    render(
      <PolicyGateProvider gate={allowGate}>
        <GenericModuleScreen config={liveRowConfig} />
      </PolicyGateProvider>,
    );

    const codeCell = screen.getByRole("button", { name: "OBJ-1 상세 열기" }).closest("td");
    expect(codeCell).not.toBeNull();
    expect(codeCell).toHaveStyle({ whiteSpace: "nowrap" });
  });

  it("wraps the free-text 내용 column instead of forcing 금액 off the visible list track (verdict r13 finance amount clips)", () => {
    const rowConfig: ModuleScreenConfig = {
      ...liveRowConfig,
      list: {
        ...liveRowConfig.list,
        columns: [
          { key: "code", labelKey: "console.modules.finance.columns.code" },
          { key: "title", labelKey: "console.modules.finance.columns.title", wrap: true },
          { key: "amount", labelKey: "console.modules.finance.columns.amount", align: "end" },
        ],
      },
      rows: [
        {
          id: "row-1",
          code: "OBJ-1",
          status: { labelKey: "console.modules.finance.statuses.active", tone: "ok" },
          cells: {
            title: "부산 지점 정기점검 부품비 — 유압 실린더/호스/베어링 일괄 교체",
            amount: "₩62,340,000",
          },
          detail: { title: "실개체" },
        },
      ],
    };

    render(
      <PolicyGateProvider gate={allowGate}>
        <GenericModuleScreen config={rowConfig} />
      </PolicyGateProvider>,
    );

    // The full, untruncated amount is in the DOM (CSS overflow, not JS
    // truncation, was the bug — assert both halves of the fix).
    const amountCell = screen.getByText("₩62,340,000").closest("td");
    expect(amountCell).not.toBeNull();
    expect(amountCell).toHaveStyle({ whiteSpace: "nowrap" });

    const titleCell = screen
      .getByText("부산 지점 정기점검 부품비 — 유압 실린더/호스/베어링 일괄 교체")
      .closest("td");
    expect(titleCell).not.toBeNull();
    expect(titleCell).toHaveStyle({ whiteSpace: "normal" });
  });

  it("folds status + source into the title cell as chips (titleMeta), matching the real financeModuleScreen list shape", () => {
    const rowConfig: ModuleScreenConfig = {
      ...liveRowConfig,
      list: {
        ...liveRowConfig.list,
        columns: financeModuleScreen.list.columns,
      },
      rows: [
        {
          id: "row-1",
          code: "VC-1001",
          status: { labelKey: "console.modules.finance.statuses.active", tone: "ok" },
          source: {
            labelKey: "console.modules.finance.links.purchase",
            tone: "info",
            code: "PS-9001",
            kind: "purchase_request",
            id: "ps-9001",
          },
          cells: { title: "임대료 지급", amount: "₩500,000" },
          detail: { title: "임대료 지급" },
        },
      ],
    };

    render(
      <PolicyGateProvider gate={allowGate}>
        <GenericModuleScreen config={rowConfig} />
      </PolicyGateProvider>,
    );

    const titleCell = within(screen.getByRole("table")).getByText("임대료 지급").closest("td");
    expect(titleCell).not.toBeNull();
    expect(titleCell).toHaveTextContent("활성");
    expect(titleCell).toHaveTextContent("PS-9001");
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
