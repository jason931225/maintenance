import { describe, expect, it } from "vitest";

import { deriveProductionCapabilities } from "./productionCapabilities";

describe("deriveProductionCapabilities", () => {
  const gate = (allows: (feature: string, branch: string) => boolean) => ({
    allows: ({ feature, branch }: { feature: string; branch: string }) => allows(feature, branch),
  });

  it("shows planner actions from canonical effective feature grants, not roles", () => {
    const result = deriveProductionCapabilities(gate((feature) => feature === "daily_plan_request"), "branch-1");
    expect(result).toMatchObject({ canRead: true, canCreate: true, canRequestReview: true, canReview: false });
  });

  it("shows reviewer actions from DailyPlanReview", () => {
    const result = deriveProductionCapabilities(gate((feature) => feature === "daily_plan_review"), "branch-1");
    expect(result).toMatchObject({ canRead: true, canCreate: false, canReview: true, canConfirm: false });
  });

  it("lets org-wide triage read without inventing mutation actions", () => {
    const result = deriveProductionCapabilities(gate((feature) => feature === "org_wide_queue_triage"), "branch-1");
    expect(result).toMatchObject({ canRead: true, canCreate: false, canReview: false, canConfirm: false, canTriage: true });
  });

  it("denies request-only policy output when it has no effective action grant", () => {
    const result = deriveProductionCapabilities(gate(() => false), "branch-1");
    expect(result).toMatchObject({ canRead: false, canCreate: false, canRequestReview: false });
  });
});
