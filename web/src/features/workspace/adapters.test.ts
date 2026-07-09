import { describe, expect, it } from "vitest";

import { candidateToPin } from "./adapters";

describe("candidateToPin", () => {
  it("builds a pinnable person object with refId + route (the pin fetch records the view-audit)", () => {
    const pin = candidateToPin({ kind: "person", code: "u-1", label: "홍길동" });
    expect(pin).toMatchObject({ kind: "person", code: "u-1", title: "홍길동", refId: "u-1" });
    expect(pin?.href).toContain("person=u-1");
  });

  it("uses the backend id (not the display code) as refId for a work order", () => {
    const pin = candidateToPin({ kind: "workOrder", code: "WO-1", id: "uuid-1", label: "x" });
    expect(pin?.refId).toBe("uuid-1");
    expect(pin?.href).toContain("uuid-1");
  });

  it("returns null for a kind that is not pinnable", () => {
    expect(candidateToPin({ kind: "payroll", code: "PS-1", label: "x" })).toBeNull();
  });
});
