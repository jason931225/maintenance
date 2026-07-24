import { describe, expect, it } from "vitest";

import {
  deriveEquipmentCapabilities,
  type EquipmentFeature,
  type EquipmentPolicyGate,
} from "./equipmentCapabilities";

function gateOf(granted: readonly EquipmentFeature[], expectBranch?: string): EquipmentPolicyGate {
  return {
    allows: (query) => {
      if (expectBranch !== undefined && query.branch !== expectBranch) return false;
      return granted.includes(query.feature);
    },
  };
}

describe("deriveEquipmentCapabilities", () => {
  it("maps each backend feature to exactly one capability", () => {
    expect(deriveEquipmentCapabilities(gateOf(["equipment_3r_observe"]), "b1")).toEqual({
      canObserve: true,
      canRegister: false,
      canQuote: false,
      canApprove: false,
      canDispatch: false,
      canInspect: false,
      canAssess: false,
      canDisposition: false,
    });
    expect(deriveEquipmentCapabilities(
      gateOf([
        "equipment_3r_registry",
        "equipment_3r_quote",
        "equipment_3r_approve",
        "equipment_3r_dispatch",
        "equipment_3r_inspect",
        "equipment_3r_assess",
        "equipment_3r_disposition",
        "equipment_3r_observe",
      ]),
      "b1",
    )).toEqual({
      canObserve: true,
      canRegister: true,
      canQuote: true,
      canApprove: true,
      canDispatch: true,
      canInspect: true,
      canAssess: true,
      canDisposition: true,
    });
  });

  it("queries the gate against the target branch (fail closed elsewhere)", () => {
    const gate = gateOf(["equipment_3r_observe"], "branch-1");
    expect(deriveEquipmentCapabilities(gate, "branch-1").canObserve).toBe(true);
    expect(deriveEquipmentCapabilities(gate, "branch-2").canObserve).toBe(false);
  });

  it("denies everything on an empty projection", () => {
    const denied = deriveEquipmentCapabilities(gateOf([]), "b1");
    expect(Object.values(denied).every((value) => !value)).toBe(true);
  });
});
