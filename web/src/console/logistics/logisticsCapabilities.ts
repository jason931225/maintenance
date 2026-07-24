export type LogisticsFeature =
  | "logistics_receive"
  | "logistics_putaway"
  | "logistics_release"
  | "logistics_pick_pack"
  | "logistics_dispatch"
  | "logistics_pod"
  | "logistics_settle";

/** Canonical policy gate exposes typed feature, permission, and branch queries. */
export interface LogisticsPolicyGate {
  allows: (query: {
    feature: LogisticsFeature;
    branch: string;
    minPermission: "allow";
  }) => boolean;
}

export interface LogisticsCapabilities {
  canRead: boolean;
  canReceive: boolean;
  canPutaway: boolean;
  canRelease: boolean;
  canPickPack: boolean;
  canDispatch: boolean;
  canPod: boolean;
  canSettle: boolean;
}

/**
 * Pure projection adapter over the grant-only logistics feature gates.
 * Deny-by-omission: nothing granted on the branch → the module renders its
 * denied state, fetches nothing, and offers no controls.
 */
export function deriveLogisticsCapabilities(
  gate: LogisticsPolicyGate,
  branchId: string,
): LogisticsCapabilities {
  const allows = (feature: LogisticsFeature) =>
    gate.allows({ feature, branch: branchId, minPermission: "allow" });
  const canReceive = allows("logistics_receive");
  const canPutaway = allows("logistics_putaway");
  const canRelease = allows("logistics_release");
  const canPickPack = allows("logistics_pick_pack");
  const canDispatch = allows("logistics_dispatch");
  const canPod = allows("logistics_pod");
  const canSettle = allows("logistics_settle");
  return {
    canRead:
      canReceive || canPutaway || canRelease || canPickPack || canDispatch || canPod || canSettle,
    canReceive,
    canPutaway,
    canRelease,
    canPickPack,
    canDispatch,
    canPod,
    canSettle,
  };
}
