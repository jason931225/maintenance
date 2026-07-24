import { describe, expect, it } from "vitest";

import { deriveProductionCapabilities } from "./productionCapabilities";

describe("deriveProductionCapabilities", () => {
  it("shows planner actions from canonical effective feature grants, not roles", () => {
    const result = deriveProductionCapabilities({ featureGrants: ["daily_plan_request"] });
    expect(result).toMatchObject({ canRead: true, canCreate: true, canRequestReview: true, canReview: false });
  });

  it("shows reviewer actions from DailyPlanReview", () => {
    const result = deriveProductionCapabilities({ featureGrants: ["daily_plan_review"] });
    expect(result).toMatchObject({ canRead: true, canCreate: false, canReview: true, canConfirm: false });
  });

  it("lets org-wide triage read without inventing mutation actions", () => {
    const result = deriveProductionCapabilities({ featureGrants: ["org_wide_queue_triage"] });
    expect(result).toMatchObject({ canRead: true, canCreate: false, canReview: false, canConfirm: false, canTriage: true });
  });

  it("denies request-only policy output when it has no effective action grant", () => {
    const result = deriveProductionCapabilities({ featureGrants: [] });
    expect(result).toMatchObject({ canRead: false, canCreate: false, canRequestReview: false });
  });
});
