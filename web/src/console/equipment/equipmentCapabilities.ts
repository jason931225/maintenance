/** Feature keys mirror the backend equipment-3r feature catalog verbatim. */
export type EquipmentFeature =
  | "equipment_3r_registry"
  | "equipment_3r_quote"
  | "equipment_3r_approve"
  | "equipment_3r_dispatch"
  | "equipment_3r_inspect"
  | "equipment_3r_assess"
  | "equipment_3r_disposition"
  | "equipment_3r_observe";

/** Canonical policy gate surface (structural subset of console/policy PolicyGate). */
export interface EquipmentPolicyGate {
  allows: (query: {
    feature: EquipmentFeature;
    branch: string;
    minPermission: "allow";
  }) => boolean;
}

export interface EquipmentCapabilities {
  canObserve: boolean;
  canRegister: boolean;
  canQuote: boolean;
  canApprove: boolean;
  canDispatch: boolean;
  canInspect: boolean;
  canAssess: boolean;
  canDisposition: boolean;
}

/** Pure projection adapter matching the equipment-3r backend feature gates. */
export function deriveEquipmentCapabilities(
  gate: EquipmentPolicyGate,
  branchId: string,
): EquipmentCapabilities {
  const allows = (feature: EquipmentFeature) =>
    gate.allows({ feature, branch: branchId, minPermission: "allow" });
  return {
    canObserve: allows("equipment_3r_observe"),
    canRegister: allows("equipment_3r_registry"),
    canQuote: allows("equipment_3r_quote"),
    canApprove: allows("equipment_3r_approve"),
    canDispatch: allows("equipment_3r_dispatch"),
    canInspect: allows("equipment_3r_inspect"),
    canAssess: allows("equipment_3r_assess"),
    canDisposition: allows("equipment_3r_disposition"),
  };
}
