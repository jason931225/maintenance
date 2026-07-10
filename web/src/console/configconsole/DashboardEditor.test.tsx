import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { DENY_ALL, PolicyGateProvider, type PolicyGate } from "../policy";
import { configConsoleStrings, CONFIG_CONSOLE_STRINGS as S, seedConfigConsoleStrings } from "./strings";
import type { OntInstanceRow, OntObjectTypeDef } from "./types";

// Seed the real key path before the editor module (which reads it at module
// scope) is evaluated; post-wire-up this is a no-op.
seedConfigConsoleStrings(ko);
const { DashboardEditor } = await import("./DashboardEditor");

const T = configConsoleStrings();

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

/** Real REST shapes (api/ontology.ts + api/ontologyActions.ts + api/governance.ts). */
function mockApi(): ConsoleApiClient {
  return {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/ontology/object-types/{key}") {
        return Promise.resolve({
          data: {
            object_type: { id: "console-view-type", stable_key: "console_view", title: "콘솔 뷰", backing_kind: "instance", schema_version: 1, lifecycle_state: "published" },
            title_property_key: "screen_key",
            backing_table: null,
            primary_key_property: null,
            properties: [],
            links: [],
            actions: [],
            analytics: [],
          },
          error: undefined,
          response: { status: 200 },
        });
      }
      return Promise.resolve({ data: [], error: undefined, response: { status: 200 } });
    }),
    POST: vi.fn((path: string) => {
      if (path === "/api/v1/ontology/actions/{action_key}/execute") {
        return Promise.resolve({
          data: {
            instance: {
              instance: { id: "cv-1", title: "config-console", lifecycle_state: "active" },
              revision: { version: 1, attributes: {} },
            },
            gates: { allow: true, gates: [] },
          },
          error: undefined,
          response: { status: 200 },
        });
      }
      if (path === "/api/v1/governance/approvals") {
        return Promise.resolve({
          data: {
            id: "appr-1",
            request_ref: "cv-1",
            kind: "console_view.deploy",
            requested_by: "u1",
            payload_summary: {},
            created_at: "2026-07-10T00:00:00Z",
          },
          error: undefined,
          response: { status: 201 },
        });
      }
      return Promise.resolve({ data: undefined, error: { error: { code: "unmocked", message: "unmocked" } }, response: { status: 500 } });
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ConsoleApiClient;
}

function renderEditor(gate: PolicyGate = allowGate, api: ConsoleApiClient = mockApi()) {
  return render(
    <PolicyGateProvider gate={gate}>
      <DashboardEditor registry={REGISTRY} rows={ROWS} api={api} />
    </PolicyGateProvider>,
  );
}

describe("DashboardEditor default preset (count + dist)", () => {
  it("renders the count widget computed over the real rows", () => {
    renderEditor();
    // work_order total 6, grouped: 긴급 2 / 보통 3 / 낮음 1.
    expect(screen.getByRole("button", { name: S.widget.totalAria("작업 지시", 6) })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.widget.countAria("긴급", 2) })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.widget.countAria("보통", 3) })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.widget.countAria("낮음", 1) })).toBeTruthy();
  });

  it("renders the dist widget grouped by real lifecycle_state, never a fabricated field", () => {
    renderEditor();
    // approval: 4 active / 1 draft (§3b lifecycle, not a choice field).
    expect(screen.getByRole("list", { name: S.widget.chartAria("결재") })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.widget.countAria("활성", 4) })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.widget.countAria("초안", 1) })).toBeTruthy();
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

  it("dist drill filters by lifecycle_state", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.widget.countAria("초안", 1) }));
    const panel = screen.getByRole("article", { name: S.drill.panelTitle });
    const list = within(panel).getByRole("list", { name: S.drill.listAria });
    expect(within(list).getByText("AP-3133")).toBeTruthy();
  });

  it("opens a drill result as its object card via a keyboard-operable button", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.widget.countAria("긴급", 2) }));
    const panel = screen.getByRole("article", { name: S.drill.panelTitle });
    fireEvent.click(within(panel).getByRole("button", { name: S.drill.openObject("WO-4101") }));
    const card = screen.getByRole("article", { name: ko.console.objectcard.panel("WO-4101") });
    expect(within(card).getByText("긴급")).toBeTruthy();
  });
});

describe("DashboardEditor config mode (§4-22 add-anything, design delta 94+96)", () => {
  it("the empty slot's add strip offers all 3 kinds and fills a default widget", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.config.toggleAria }));
    const slot = screen.getByRole("region", { name: S.slot.aria(2) });
    const addButtons = within(slot).getAllByRole("button", { name: S.slot.addAria(2) });
    expect(addButtons.map((button) => button.textContent)).toEqual([
      T.widgetKinds.count,
      T.widgetKinds.trend,
      T.widgetKinds.dist,
    ]);
    // dist(work_order) — count(work_order,priority) is already slot-1's widget.
    fireEvent.click(addButtons[2]);
    expect(within(slot).getByRole("combobox", { name: S.slot.presetAria(2) })).toBeTruthy();
  });

  it("the add strip blocks a duplicate kind+bind widget (dedup guard)", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.config.toggleAria }));
    const slot = screen.getByRole("region", { name: S.slot.aria(2) });
    // slot-1 already has count(work_order, priority) — the default count add
    // targets the same first registry type + first choice, so it collides.
    fireEvent.click(within(slot).getAllByRole("button", { name: S.slot.addAria(2) })[0]);
    expect(screen.getByText(T.slot.dedupBlocked)).toBeTruthy();
  });

  it("retypes a slot via the preset select and removes it via 위젯 제거", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: S.config.toggleAria }));
    const slot = screen.getByRole("region", { name: S.slot.aria(1) });
    fireEvent.change(within(slot).getByRole("combobox", { name: S.slot.presetAria(1) }), {
      target: { value: "dist" },
    });
    expect(within(slot).getByRole("list", { name: S.widget.chartAria("작업 지시") })).toBeTruthy();
    fireEvent.click(within(slot).getByRole("button", { name: S.slot.removeAria(1) }));
    expect(within(slot).getAllByRole("button", { name: S.slot.addAria(1) })).toHaveLength(3);
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

describe("DashboardEditor 저장 (personal view → real console_view instance, §3.9.0-①)", () => {
  it("requires the audited change reason, then persists via ontology actions REST and flags 저장됨", async () => {
    const api = mockApi();
    renderEditor(allowGate, api);
    const save = screen.getByRole("button", { name: S.save.action });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByRole("textbox", { name: S.save.comment }), {
      target: { value: "슬롯 정리" },
    });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    expect(await screen.findByText(S.chips.saved)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: S.save.comment })).toHaveProperty("value", "");
    expect(api.POST).toHaveBeenCalledWith(
      "/api/v1/ontology/actions/{action_key}/execute",
      expect.objectContaining({ params: { path: { action_key: "create" } } }),
    );
  });
});

describe("DashboardEditor 팀 배포 — 결재 (real console_view(team) + governance approval)", () => {
  it("opens the prefill with the serialized doc and flips to 결재 대기 on 상신", async () => {
    const api = mockApi();
    renderEditor(allowGate, api);
    fireEvent.click(screen.getByRole("button", { name: S.deploy.action }));
    const panel = screen.getByRole("article", { name: S.deploy.panelTitle });
    expect(within(panel).getByText(S.deploy.prefillCode)).toBeTruthy();
    const json = within(panel).getByLabelText(S.deploy.docAria).textContent;
    expect(JSON.parse(json)).toMatchObject({ screen: "config-console", version: 1 });
    fireEvent.click(within(panel).getByRole("button", { name: S.deploy.submit }));
    expect(screen.queryByRole("article", { name: S.deploy.panelTitle })).toBeNull();
    expect(await screen.findByText(S.chips.deployPending)).toBeTruthy();
    expect(api.POST).toHaveBeenCalledWith("/api/v1/governance/approvals", expect.anything());
  });
});

describe("DashboardEditor deny-by-omission", () => {
  it("renders no configure/save/deploy affordances under DENY_ALL", () => {
    renderEditor(DENY_ALL);
    expect(screen.queryByRole("button", { name: S.config.toggleAria })).toBeNull();
    expect(screen.queryByRole("button", { name: S.save.action })).toBeNull();
    expect(screen.queryByRole("button", { name: S.deploy.action })).toBeNull();
    expect(screen.queryAllByRole("button", { name: S.slot.addAria(2) })).toHaveLength(0);
    // read surfaces stay: the live numbers still render and drill.
    expect(screen.getByRole("button", { name: S.widget.totalAria("작업 지시", 6) })).toBeTruthy();
  });
});
