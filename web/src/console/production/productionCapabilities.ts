export type ProductionFeature =
  | "daily_plan_request"
  | "daily_plan_review"
  | "org_wide_queue_triage";

/** Canonical console authz output. Only effective feature grants can expose UI. */
export interface ProductionGrantSource {
  featureGrants: readonly string[];
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
  grants: ProductionGrantSource,
): ProductionCapabilities {
  // `useConsoleAuthz` is deny-by-omission. Request-only/limited entries are
  // deliberately not translated into these effective action grants.
  const allows = (feature: ProductionFeature) => grants.featureGrants.includes(feature);
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
