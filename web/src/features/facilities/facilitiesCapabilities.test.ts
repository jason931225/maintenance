import type { components } from "@maintenance/api-client-ts";
import { describe, expect, it } from "vitest";

import { deriveFacilitiesCapabilities, type FacilitiesFeature } from "./facilitiesCapabilities";

const branchA = "11111111-1111-4111-8111-111111111111";
const branchB = "22222222-2222-4222-8222-222222222222";
const actor = "operator-a";

type Scope = "all" | readonly string[];
type Query = {
  feature: FacilitiesFeature;
  branch?: string;
  minPermission: "allow";
  requireOrgWide?: boolean;
};

const selected = (
  status: components["schemas"]["FacilitiesCase"]["status"],
  branchId = branchA,
  assigneeId: string | null = actor,
): components["schemas"]["FacilitiesCase"] => ({
  id: "00000000-0000-4000-8000-000000000001",
  branchId,
  status,
  assigneeId,
  responseDueAt: "2026-07-23T00:00:00Z",
  completionDueAt: "2026-07-23T01:00:00Z",
  acceptanceDueAt: "2026-07-23T02:00:00Z",
  totalCostKrw: 0,
});

function gate(scopes: Partial<Record<FacilitiesFeature, Scope>>) {
  return {
    allows: (query: Query) => {
      const scope = scopes[query.feature];
      if (!scope) return false;
      if (query.requireOrgWide) return scope === "all";
      return scope === "all" || (typeof query.branch === "string" && scope.includes(query.branch));
    },
  };
}

describe("deriveFacilitiesCapabilities", () => {
  it("uses the server feature mapping and state constraints", () => {
    const dispatch = gate({ facilities_dispatch: "all" });
    expect(deriveFacilitiesCapabilities(dispatch, selected("DUE"), actor)).toMatchObject({
      canTriage: true,
      canAssign: false,
      canCreate: false,
    });
    expect(deriveFacilitiesCapabilities(dispatch, selected("SCHEDULED"), actor)).toMatchObject({
      canTriage: false,
      canAssign: true,
    });
  });

  it("requires the authenticated operator to be the assignee for execution and submission", () => {
    const execute = gate({ facilities_execute: "all" });
    expect(deriveFacilitiesCapabilities(execute, selected("ASSIGNED", branchA, "operator-b"), actor)).toMatchObject({
      canStart: false,
      canSubmit: false,
    });
    expect(deriveFacilitiesCapabilities(execute, selected("IN_PROGRESS"), actor)).toMatchObject({
      canStart: false,
      canSubmit: true,
    });
  });

  it("keeps observation independent from execution but still capability-gated", () => {
    expect(deriveFacilitiesCapabilities(gate({ facilities_observe: "all" }), selected("IN_PROGRESS", branchA, "operator-b"), actor)).toMatchObject({
      canObserve: true,
      canSubmit: false,
    });
  });

  it("does not render dispatch for a case outside the dispatch branch grant", () => {
    const capabilities = deriveFacilitiesCapabilities(
      gate({ facilities_observe: "all", facilities_dispatch: [branchA] }),
      selected("DUE", branchB),
      actor,
    );
    expect(capabilities.canTriage).toBe(false);
  });

  it("requires an organization-wide facilities manage grant for intake", () => {
    expect(deriveFacilitiesCapabilities(gate({ facilities_manage: [branchA] }), selected("DUE", branchA), actor).canCreate).toBe(false);
    expect(deriveFacilitiesCapabilities(gate({ facilities_manage: "all" }), selected("DUE", branchA), actor).canCreate).toBe(true);
  });

  it("does not render execute or acceptance controls outside their grant branch", () => {
    const scoped = gate({ facilities_execute: [branchA], facilities_accept: [branchA] });
    expect(deriveFacilitiesCapabilities(scoped, selected("ASSIGNED", branchB), actor).canStart).toBe(false);
    expect(deriveFacilitiesCapabilities(scoped, selected("IN_PROGRESS", branchB), actor).canSubmit).toBe(false);
    expect(deriveFacilitiesCapabilities(scoped, selected("AWAITING_ACCEPTANCE", branchB), actor).canAccept).toBe(false);
  });
});
