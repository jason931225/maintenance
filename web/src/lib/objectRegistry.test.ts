import { describe, expect, it } from "vitest";

import { kindFromCode, objectRegistry, workOrderCode, type ObjectKind } from "./objectRegistry";

const allKinds: ObjectKind[] = [
  "approval",
  "workOrder",
  "support",
  "attendance",
  "payroll",
  "contract",
  "journal",
  "intake",
  "person",
  "org",
];

describe("objectRegistry", () => {
  it("registers every object kind with a route and label formatter", () => {
    for (const kind of allKinds) {
      const entry = objectRegistry[kind];
      expect(entry.route({ id: "id-1", code: "X-1", name: "이름" })).toMatch(/^\//);
      expect(entry.formatLabel({ id: "id-1", code: "X-1", name: "이름" })).toBe("이름");
    }
  });

  it("never leaks a raw id/uuid as a label", () => {
    const uuid = "44444444-4444-4444-8444-444444444444";
    expect(objectRegistry.workOrder.formatLabel({ id: uuid, code: undefined, name: null })).not.toBe(uuid);
  });

  it.each([
    ["AP-3121", "approval"],
    ["WO-2643", "workOrder"],
    ["CS-991", "support"],
    ["AT-12", "attendance"],
    ["PS-202607", "payroll"],
    ["C-55", "contract"],
    ["JL-20260704-1", "journal"],
    ["IN-7", "intake"],
  ] as const)("resolves %s -> %s via kindFromCode", (code, kind) => {
    expect(kindFromCode(code)).toBe(kind);
  });

  it("returns undefined for unregistered prefixes and codeless strings", () => {
    expect(kindFromCode("ZZ-1")).toBeUndefined();
    expect(kindFromCode("noprefix")).toBeUndefined();
    expect(kindFromCode("-leading-dash")).toBeUndefined();
  });

  it("formats the design-grammar WO- prefix over the raw request_no", () => {
    expect(workOrderCode("20260704-001")).toBe("WO-20260704-001");
    expect(kindFromCode(workOrderCode("20260704-001"))).toBe("workOrder");
  });

  it("routes work orders by id (the real detail route), not by code", () => {
    expect(
      objectRegistry.workOrder.route({ id: "abc", code: "WO-20260704-001", name: null }),
    ).toBe("/work-orders/abc");
  });
});
