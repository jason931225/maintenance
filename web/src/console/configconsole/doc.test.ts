import { describe, expect, it } from "vitest";

import {
  computeCounts,
  computeDist,
  DASHBOARD_SLOT_COUNT,
  defaultDashboardDoc,
  drillRows,
  emptyDashboardDoc,
  isDuplicateWidget,
  parseDashboardDoc,
  serializeDashboardDoc,
  setSlotWidget,
} from "./doc";
import type { OntInstanceRow, OntObjectTypeDef, WidgetConfig } from "./types";

// Registry/rows fixtures in the mapped API payload shape (see api.ts).
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
    ],
    actions: [],
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    key: "equipment",
    title: "장비",
    properties: [],
    actions: [],
  },
];

function workOrderRow(n: number, priority: string): OntInstanceRow {
  return {
    id: `wo-${String(n)}`,
    code: `WO-${String(n)}`,
    objectType: "work_order",
    lifecycleState: "active",
    attributes: { priority },
  };
}

const ROWS: readonly OntInstanceRow[] = [
  workOrderRow(4101, "pri-urgent"),
  workOrderRow(4102, "pri-urgent"),
  workOrderRow(4103, "pri-normal"),
  workOrderRow(4104, "pri-normal"),
  workOrderRow(4105, "pri-normal"),
  workOrderRow(4106, "pri-low"),
  { id: "eq-118", code: "EQ-118", objectType: "equipment", lifecycleState: "active", attributes: {} },
  { id: "eq-119", code: "EQ-119", objectType: "equipment", lifecycleState: "active", attributes: {} },
  { id: "eq-120", code: "EQ-120", objectType: "equipment", lifecycleState: "locked", attributes: {} },
  { id: "eq-121", code: "EQ-121", objectType: "equipment", lifecycleState: "active", attributes: {} },
];

describe("dashboard doc model", () => {
  it("emptyDashboardDoc has exactly DASHBOARD_SLOT_COUNT empty slots", () => {
    const doc = emptyDashboardDoc();
    expect(doc.slots).toHaveLength(DASHBOARD_SLOT_COUNT);
    expect(doc.slots.every((slot) => slot.widget === null)).toBe(true);
  });

  it("setSlotWidget updates only the target slot, immutably", () => {
    const doc = emptyDashboardDoc();
    const widget: WidgetConfig = { kind: "count", bind: { objectType: "work_order" } };
    const next = setSlotWidget(doc, "slot-2", widget);
    expect(next).not.toBe(doc);
    expect(doc.slots[1]?.widget).toBeNull();
    expect(next.slots[1]?.widget).toEqual(widget);
    expect(next.slots[0]?.widget).toBeNull();
  });

  it("serialize → parse round-trips the shipped default doc", () => {
    const doc = defaultDashboardDoc();
    expect(parseDashboardDoc(serializeDashboardDoc(doc))).toEqual(doc);
  });

  it("parse degrades an unknown widget kind to an empty slot (forward-compat)", () => {
    const doc = parseDashboardDoc(
      JSON.stringify({
        version: 1,
        screen: "config-console",
        slots: [{ id: "slot-1", widget: { kind: "hologram", bind: { objectType: "work_order" } } }],
      }),
    );
    expect(doc).not.toBeNull();
    expect(doc?.slots).toHaveLength(DASHBOARD_SLOT_COUNT);
    expect(doc?.slots[0]?.widget).toBeNull();
  });

  it("parse normalizes missing/extra slots to exactly DASHBOARD_SLOT_COUNT", () => {
    const short = parseDashboardDoc(JSON.stringify({ version: 1, screen: "s", slots: [] }));
    expect(short?.slots).toHaveLength(DASHBOARD_SLOT_COUNT);
    const long = parseDashboardDoc(
      JSON.stringify({
        version: 1,
        screen: "s",
        slots: Array.from({ length: 9 }, (_, i) => ({ id: `x-${String(i)}`, widget: null })),
      }),
    );
    expect(long?.slots).toHaveLength(DASHBOARD_SLOT_COUNT);
  });

  it("parse rejects payloads that are not a doc at all", () => {
    expect(parseDashboardDoc("not json")).toBeNull();
    expect(parseDashboardDoc(JSON.stringify(["nope"]))).toBeNull();
    expect(parseDashboardDoc(JSON.stringify({ screen: "s" }))).toBeNull();
  });
});

describe("computeCounts", () => {
  it("counts the total without groupBy", () => {
    const result = computeCounts(ROWS, "work_order", undefined, REGISTRY);
    expect(result.total).toBe(6);
    expect(result.groups).toHaveLength(0);
  });

  it("groups per choice value in registry order with real counts", () => {
    const result = computeCounts(ROWS, "work_order", "priority", REGISTRY);
    expect(result.total).toBe(6);
    expect(result.groups).toEqual([
      { id: "pri-urgent", label: "긴급", count: 2 },
      { id: "pri-normal", label: "보통", count: 3 },
      { id: "pri-low", label: "낮음", count: 1 },
    ]);
  });

  it("degrades an unknown choice id to a raw-id group instead of dropping it", () => {
    const rows: OntInstanceRow[] = [
      ...ROWS,
      {
        id: "wo-x",
        code: "WO-X",
        objectType: "work_order",
        lifecycleState: "active",
        attributes: { priority: "pri-ghost" },
      },
    ];
    const result = computeCounts(rows, "work_order", "priority", REGISTRY);
    expect(result.groups.at(-1)).toEqual({ id: "pri-ghost", label: "pri-ghost", count: 1 });
  });

  it("skips rows with a null/missing group value but keeps them in the total", () => {
    const rows: OntInstanceRow[] = [
      {
        id: "wo-n",
        code: "WO-N",
        objectType: "work_order",
        lifecycleState: "active",
        attributes: { priority: null },
      },
    ];
    const result = computeCounts(rows, "work_order", "priority", REGISTRY);
    expect(result.total).toBe(1);
    expect(result.groups.reduce((sum, group) => sum + group.count, 0)).toBe(0);
  });
});

describe("drillRows", () => {
  it("filters by object type alone", () => {
    expect(drillRows(ROWS, { objectType: "equipment" })).toHaveLength(4);
  });

  it("filters by field + choice id", () => {
    const matched = drillRows(ROWS, {
      objectType: "work_order",
      field: "priority",
      choiceId: "pri-urgent",
    });
    expect(matched.map((row) => row.code)).toEqual(["WO-4101", "WO-4102"]);
  });

  it("filters by lifecycleState (dist widget drill)", () => {
    const matched = drillRows(ROWS, { objectType: "equipment", lifecycleState: "locked" });
    expect(matched.map((row) => row.code)).toEqual(["EQ-120"]);
  });
});

describe("computeDist", () => {
  it("groups instance counts by lifecycle_state, top-4, without fabricating labels", () => {
    const result = computeDist(ROWS, "equipment");
    expect(result.total).toBe(4);
    expect(result.groups).toEqual([
      { id: "active", label: "active", count: 3 },
      { id: "locked", label: "locked", count: 1 },
    ]);
  });
});

describe("isDuplicateWidget", () => {
  it("flags a widget with the same kind+bind already on the doc (add-widget dedup guard)", () => {
    const doc = setSlotWidget(emptyDashboardDoc(), "slot-1", {
      kind: "count",
      bind: { objectType: "work_order" },
    });
    expect(isDuplicateWidget(doc, { kind: "count", bind: { objectType: "work_order" } })).toBe(true);
    expect(isDuplicateWidget(doc, { kind: "count", bind: { objectType: "equipment" } })).toBe(false);
    expect(isDuplicateWidget(doc, { kind: "dist", bind: { objectType: "work_order" } })).toBe(false);
  });
});
