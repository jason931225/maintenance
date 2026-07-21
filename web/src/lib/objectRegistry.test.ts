import { describe, expect, it } from "vitest";

import {
  kindFromCode,
  objectRegistry,
  resolveActionInboxLinkRoute,
  workOrderCode,
  type ObjectKind,
} from "./objectRegistry";

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
      expect(entry.route({ id: "id-1", code: "X-1", name: "이름" })).toMatch(
        /^\//,
      );
      expect(entry.formatLabel({ id: "id-1", code: "X-1", name: "이름" })).toBe(
        "이름",
      );
    }
  });

  it("never leaks a raw id/uuid as a label", () => {
    const uuid = "44444444-4444-4444-8444-444444444444";
    expect(
      objectRegistry.workOrder.formatLabel({
        id: uuid,
        code: undefined,
        name: null,
      }),
    ).not.toBe(uuid);
  });

  it.each([
    ["AP-3121", "approval"],
    ["WO-2643", "workOrder"],
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

  it("routes approval runs and support tickets by authoritative ids without fabricating codes", () => {
    expect(objectRegistry.approval.route({ id: "run/id" })).toBe(
      "/approvals?run=run%2Fid",
    );
    expect(objectRegistry.support.route({ id: "ticket/id" })).toBe(
      "/support?ticket=ticket%2Fid",
    );
    expect(objectRegistry.support.codePrefix).toBeUndefined();
    expect(kindFromCode("CS-991")).toBeUndefined();
  });

  it("formats the design-grammar WO- prefix over the raw request_no", () => {
    expect(workOrderCode("20260704-001")).toBe("WO-20260704-001");
    expect(kindFromCode(workOrderCode("20260704-001"))).toBe("workOrder");
  });

  it("routes work orders by id (the real detail route), not by code", () => {
    expect(
      objectRegistry.workOrder.route({
        id: "abc",
        code: "WO-20260704-001",
        name: null,
      }),
    ).toBe("/work-orders/abc");
  });

  it("URL-encodes work-order route ids before interpolating the detail path", () => {
    expect(objectRegistry.workOrder.route({ id: "abc/def ?x=1" })).toBe(
      "/work-orders/abc%2Fdef%20%3Fx%3D1",
    );
  });

  it.each([
    ["approval_run", "run/value", "/approvals?run=run%2Fvalue"],
    ["work_order", "work order/value", "/work-orders/work%20order%2Fvalue"],
    ["support_ticket", "ticket/value", "/support?ticket=ticket%2Fvalue"],
  ] as const)(
    "resolves canonical action-inbox kind %s through the registry",
    (kind, id, route) => {
      expect(resolveActionInboxLinkRoute([{ kind, id }])).toBe(route);
    },
  );

  it("preserves server link order while skipping unknown kinds and blank ids", () => {
    expect(
      resolveActionInboxLinkRoute([
        { kind: "future_kind", id: "future-1" },
        { kind: "work_order", id: "   " },
        { kind: "support_ticket", id: " ticket-1 " },
        { kind: "approval_run", id: "run-ignored" },
      ]),
    ).toBe("/support?ticket=ticket-1");
  });

  it.each(["workflow_run", "person", "org_unit", "payroll_period"])(
    "keeps unsupported wire kind %s inert",
    (kind) => {
      expect(
        resolveActionInboxLinkRoute([{ kind, id: "source-1" }]),
      ).toBeUndefined();
    },
  );

  it("never trusts a server URL or treats an id code prefix as a kind", () => {
    expect(
      resolveActionInboxLinkRoute([
        {
          kind: "work_order",
          id: "wo-1",
          url: "https://attacker.invalid/phish",
        },
      ]),
    ).toBe("/work-orders/wo-1");
    expect(
      resolveActionInboxLinkRoute([
        {
          kind: "future_kind",
          id: "AP-3121",
          url: "https://attacker.invalid/phish",
        },
      ]),
    ).toBeUndefined();
  });
});
