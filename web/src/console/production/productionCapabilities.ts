export type ProductionFeature =
  | "daily_plan_request"
  | "daily_plan_review"
  | "org_wide_queue_triage";

/** Canonical policy gate exposes typed feature, permission, and branch queries. */
export interface ProductionPolicyGate {
  allows: (query: {
    feature: ProductionFeature;
    branch: string;
    minPermission: "allow";
  }) => boolean;
}

export interface ProductionCapabilities {
  canRead: boolean;
  canCreate: boolean;
  canRequestReview: boolean;
  canReview: boolean;
  canConfirm: boolean;
  canTriage: boolean;
}

/** Pure projection adapter matching the DailyPlan backend feature gates. */
export function deriveProductionCapabilities(
  gate: ProductionPolicyGate,
  branchId: string,
): ProductionCapabilities {
  const allows = (feature: ProductionFeature) =>
    gate.allows({ feature, branch: branchId, minPermission: "allow" });
  const canRequest = allows("daily_plan_request");
  const canReview = allows("daily_plan_review");
  const canTriage = allows("org_wide_queue_triage");
  return {
    canRead: canRequest || canReview || canTriage,
    canCreate: canRequest,
    canRequestReview: canRequest,
    canReview,
    canConfirm: canRequest,
    canTriage,
  };
}
