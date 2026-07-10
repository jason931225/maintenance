import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import { DENY_ALL, PolicyGateProvider, type PolicyGate } from "../policy";
import { CONFIG_CONSOLE_STRINGS as S, seedConfigConsoleStrings } from "./strings";
import type { OntInstanceRow, OntObjectTypeDef } from "./types";

// Seed the real key path before the editor module (which reads it at module
// scope) is evaluated; post-wire-up this is a no-op.
seedConfigConsoleStrings(ko);
const { DashboardEditor } = await import("./DashboardEditor");

// Mocked API payloads, already mapped through the ontology view-model mappers
// (ConfigConsolePage.test.tsx covers the transport; here the editor is fed the
// same shapes it receives at runtime).
const REGISTRY: readonly OntObjectTypeDef[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    key: "work_order",
    title: "작업 지시",
    properties: [
      {
        id: "prop-wo-priority",
        key: "priority",
        title: "우선순위",
        type: "choice",
        config: {
          choices: [
            { id: "pri-urgent", name: "긴급", color: "danger" },
            { id: "pri-normal", name: "보통" },
            { id: "pri-low", name: "낮음" },
          ],
        },
      },
      { id: "prop-wo-due", key: "due", title: "기한", type: "date" },
    ],
    actions: [],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    key: "approval",
    title: "결재",
    properties: [
      {
        id: "prop-ap-kind",
        key: "kind",
        title: "유형",
        type: "choice",
        config: {
          choices: [
            { id: "apk-expense", name: "지출" },
            { id: "apk-leave", name: "휴가" },
            { id: "apk-layout", name: "레이아웃" },
          ],
        },
      },
    ],
    actions: [],
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    key: "equipment",
    title: "장비",
    properties: [
      {
        id: "prop-eq-category",
        key: "category",
        title: "분류",
        type: "choice",
        config: {
          choices: [
            { id: "eqc-forklift", name: "지게차" },
            { id: "eqc-crane", name: "크레인" },
          ],
        },
      },
    ],
    actions: [],
  },
];

const ROWS: readonly OntInstanceRow[] = [
  { id: "wo-4101", code: "WO-4101", objectType: "work_order", lifecycleState: "active", attributes: { priority: "pri-urgent", due: "2026-07-10" } },
  { id: "wo-4102", code: "WO-4102", objectType: "work_order", lifecycleState: "active", attributes: { priority: "pri-urgent", due: "2026-07-11" } },
  { id: "wo-4103", code: "WO-4103", objectType: "work_order", lifecycleState: "active", attributes: { priority: "pri-normal", due: "2026-07-14" } },
  { id: "wo-4104", code: "WO-4104", objectType: "work_order", lifecycleState: "draft", attributes: { priority: "pri-normal", due: "2026-07-15" } },
  { id: "wo-4105", code: "WO-4105", objectType: "work_order", lifecycleState: "active", attributes: { priority: "pri-normal", due: "2026-07-17" } },
  { id: "wo-4106", code: "WO-4106", objectType: "work_order", lifecycleState: "active", attributes: { priority: "pri-low", due: "2026-07-21" } },
  { id: "ap-3130", code: "AP-3130", objectType: "approval", lifecycleState: "active", attributes: { kind: "apk-expense" } },
  { id: "ap-3131", code: "AP-3131", objectType: "approval", lifecycleState: "active", attributes: { kind: "apk-expense" } },
  { id: "ap-3132", code: "AP-3132", objectType: "approval", lifecycleState: "active", attributes: { kind: "apk-leave" } },
  { id: "ap-3133", code: "AP-3133", objectType: "approval", lifecycleState: "draft", attributes: { kind: "apk-leave" } },
  { id: "ap-3134", code: "AP-3134", objectType: "approval", lifecycleState: "active", attributes: { kind: "apk-layout" } },
  { id: "eq-118", code: "EQ-118", objectType: "equipment", lifecycleState: "active", attributes: { category: "eqc-forklift" } },
  { id: "eq-119", code: "EQ-119", objectType: "equipment", lifecycleState: "active", attributes: { category: "eqc-forklift" } },
  { id: "eq-120", code: "EQ-120", objectType: "equipment", lifecycleState: "locked", attributes: { category: "eqc-forklift" } },
  { id: "eq-121", code: "EQ-121", objectType: "equipment", lifecycleState: "active", attributes: { category: "eqc-crane" } },
];

const allowGate: PolicyGate = { can: () => true };

function renderEditor(gate: PolicyGate = allowGate) {
  return render(
    <PolicyGateProvider gate={gate}>
      <DashboardEditor registry={REGISTRY} rows={ROWS} />
    </PolicyGateProvider>,
  );
}

describe("DashboardEditor default preset", () => {
  it("renders live counts computed over the stub ontQuery sample", () => {
    renderEditor();
    // work_order total 6 (live-count slot + stat bar), grouped: 긴급 2 / 보통 3 / 낮음 1.
    expect(screen.getAllByRole("button", { name: S.widget.totalAria("작업 지시", 6) })).toHaveLength(2);
    expect(screen.getByRole("button", { name: S.widget.countAria("긴급", 2) })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.widget.countAria("보통", 3) })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.widget.countAria("낮음", 1) })).toBeTruthy();
    // stat bar totals for the other object types.
    expect(screen.getByRole("button", { name: S.widget.totalAria("결재", 5) })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.widget.totalAria("장비", 4) })).toBeTruthy();
    // chart over approval kind.
    expect(screen.getByRole("list", { name: S.widget.chartAria("결재") })).toBeTruthy();
  });

  it("drill click opens the filtered result panel (inline fallback without a window shell)", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.widget.countAria("긴급", 2) }));
    const panel = screen.getByRole("article", { name: S.drill.panelTitle });
    expect(within(panel).getByText(S.drill.countChip(2))).toBeTruthy();
    const list = within(panel).getByRole("list", { name: S.drill.listAria });
    expect(within(list).getByText("WO-4101")).toBeTruthy();
    expect(within(list).getByText("WO-4102")).toBeTruthy();
    expect(within(list).queryByText("WO-4103")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: S.drill.close }));
    expect(screen.queryByRole("article", { name: S.drill.panelTitle })).toBeNull();
  });

  it("opens a drill result as its object card via a keyboard-operable button", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.widget.countAria("긴급", 2) }));
    const panel = screen.getByRole("article", { name: S.drill.panelTitle });
    fireEvent.click(within(panel).getByRole("button", { name: S.drill.openObject("WO-4101") }));
    // §4.7-3 right pin degrades to the inline aside without a window shell.
    // The card is built from the real row: title = instance title, properties
    // resolve choice ids through the registry.
    const card = screen.getByRole("article", { name: ko.console.objectcard.panel("WO-4101") });
    expect(within(card).getByText("긴급")).toBeTruthy();
  });
});

describe("DashboardEditor config mode (§4-22 add-anything)", () => {
  it("adds a widget to the empty slot via the in-place +위젯 path", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.slot.addAria(4) }));
    // adding enters config mode and fills the slot with a default live count.
    expect(screen.getByRole("button", { name: S.config.toggleAria })).toHaveProperty(
      "ariaPressed",
      "true",
    );
    const slot = screen.getByRole("region", { name: S.slot.aria(4) });
    expect(within(slot).getByRole("combobox", { name: S.slot.presetAria(4) })).toBeTruthy();
    expect(
      within(slot).getByRole("button", { name: S.widget.totalAria("작업 지시", 6) }),
    ).toBeTruthy();
  });

  it("retypes a slot via the preset select and removes it via 위젯 제거", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.config.toggleAria }));
    const slot = screen.getByRole("region", { name: S.slot.aria(1) });
    fireEvent.change(within(slot).getByRole("combobox", { name: S.slot.presetAria(1) }), {
      target: { value: "chart" },
    });
    expect(within(slot).getByRole("list", { name: S.widget.chartAria("작업 지시") })).toBeTruthy();
    fireEvent.click(within(slot).getByRole("button", { name: S.slot.removeAria(1) }));
    expect(within(slot).getByRole("button", { name: S.slot.addAria(1) })).toBeTruthy();
  });

  it("restores the shipped default layout", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.config.toggleAria }));
    const slot = screen.getByRole("region", { name: S.slot.aria(1) });
    fireEvent.click(within(slot).getByRole("button", { name: S.slot.removeAria(1) }));
    fireEvent.click(screen.getByRole("button", { name: S.config.restore }));
    expect(
      within(screen.getByRole("region", { name: S.slot.aria(1) })).getByRole("button", {
        name: S.widget.totalAria("작업 지시", 6),
      }),
    ).toBeTruthy();
  });
});

describe("DashboardEditor 저장 (personal view, §3.9.0-①)", () => {
  it("requires the audited change reason before saving, then flags 저장됨", () => {
    renderEditor();
    const save = screen.getByRole("button", { name: S.save.action });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByRole("textbox", { name: S.save.comment }), {
      target: { value: "슬롯 정리" },
    });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    expect(screen.getByText(S.chips.saved)).toBeTruthy();
    // the audited comment is consumed by the save.
    expect(screen.getByRole("textbox", { name: S.save.comment })).toHaveProperty("value", "");
  });
});

describe("DashboardEditor 팀 배포 — 결재 (shared layout deploy)", () => {
  it("opens the AP- prefill with the serialized doc and flips to 결재 대기 on 상신", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.deploy.action }));
    const panel = screen.getByRole("article", { name: S.deploy.panelTitle });
    expect(within(panel).getByText(S.deploy.prefillCode)).toBeTruthy();
    expect(within(panel).getByText(S.deploy.widgetsValue(3))).toBeTruthy();
    const json = within(panel).getByLabelText(S.deploy.docAria).textContent;
    expect(JSON.parse(json)).toMatchObject({ screen: "config-console", version: 1 });
    fireEvent.click(within(panel).getByRole("button", { name: S.deploy.submit }));
    expect(screen.queryByRole("article", { name: S.deploy.panelTitle })).toBeNull();
    expect(screen.getByText(S.chips.deployPending)).toBeTruthy();
  });
});

describe("DashboardEditor deny-by-omission", () => {
  it("renders no configure/save/deploy affordances under DENY_ALL", () => {
    renderEditor(DENY_ALL);
    expect(screen.queryByRole("button", { name: S.config.toggleAria })).toBeNull();
    expect(screen.queryByRole("button", { name: S.save.action })).toBeNull();
    expect(screen.queryByRole("button", { name: S.deploy.action })).toBeNull();
    expect(screen.queryByRole("button", { name: S.slot.addAria(4) })).toBeNull();
    // read surfaces stay: the live numbers still render and drill.
    expect(
      screen.getAllByRole("button", { name: S.widget.totalAria("작업 지시", 6) }).length,
    ).toBeGreaterThan(0);
  });
});
