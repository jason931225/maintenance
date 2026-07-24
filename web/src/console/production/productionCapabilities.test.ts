import { describe, expect, it } from "vitest";

import { deriveProductionCapabilities } from "./productionCapabilities";

function projection(features: readonly string[], permission: "request_only" | "allow" = "allow") {
  return {
    allows: ({ feature, minPermission }: { feature: string; minPermission?: string }) =>
      features.includes(feature) && minPermission === permission,
  };
}

describe("deriveProductionCapabilities", () => {
  it("shows planner actions from DailyPlanRequest without consulting roles", () => {
    const result = deriveProductionCapabilities(projection(["daily_plan_request"]), "branch-1");
    expect(result).toMatchObject({ canRead: true, canCreate: true, canRequestReview: true, canReview: false });
  });

  it("shows reviewer actions from DailyPlanReview", () => {
    const result = deriveProductionCapabilities(projection(["daily_plan_review"]), "branch-1");
    expect(result).toMatchObject({ canRead: true, canCreate: false, canReview: true, canConfirm: false });
  });

  it("lets org-wide triage read without inventing mutation actions", () => {
    const result = deriveProductionCapabilities(projection(["org_wide_queue_triage"]), "branch-1");
    expect(result).toMatchObject({ canRead: true, canCreate: false, canReview: false, canConfirm: false, canTriage: true });
  });

  it("does not expose an endpoint control to request-only grants", () => {
    const result = deriveProductionCapabilities(
      projection(["daily_plan_request"], "request_only"),
      "branch-1",
    );
    expect(result).toMatchObject({ canRead: false, canCreate: false, canRequestReview: false });
  });
});
