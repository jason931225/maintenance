import type { components } from "@maintenance/api-client-ts";

type FacilitiesCase = components["schemas"]["FacilitiesCase"];

export type FacilitiesFeature =
  | "facilities_manage"
  | "facilities_dispatch"
  | "facilities_execute"
  | "facilities_accept"
  | "facilities_observe";

export interface FacilitiesPolicyGate {
  allows: (query: {
    feature: FacilitiesFeature;
    branch?: string;
    minPermission: "allow";
    requireOrgWide?: boolean;
  }) => boolean;
}

export interface FacilitiesCapabilities {
  canCreate: boolean;
  canTriage: boolean;
  canAssign: boolean;
  canStart: boolean;
  canObserve: boolean;
  canSubmit: boolean;
  canAccept: boolean;
}

/**
 * Maps the Facilities server feature names to exact lifecycle affordances.
 * The policy endpoint decides whether an affordance may render; the execution
 * steps additionally require that the active operator is the case assignee.
 */
export function deriveFacilitiesCapabilities(
  gate: FacilitiesPolicyGate,
  selected: FacilitiesCase | undefined,
  actorId: string | undefined,
): FacilitiesCapabilities {
  const selectedBranch = selected?.branchId;
  const allowsCase = (feature: FacilitiesFeature) =>
    typeof selectedBranch === "string" &&
    gate.allows({ feature, branch: selectedBranch, minPermission: "allow" });
  const isAssignee = Boolean(actorId && selected?.assigneeId === actorId);

  return {
    canCreate: gate.allows({
      feature: "facilities_manage",
      minPermission: "allow",
      requireOrgWide: true,
    }),
    canTriage: allowsCase("facilities_dispatch") && (selected?.status === "DUE" || selected?.status === "TRIAGED"),
    canAssign: allowsCase("facilities_dispatch") && selected?.status === "SCHEDULED",
    canStart: allowsCase("facilities_execute") && isAssignee && (selected?.status === "ASSIGNED" || selected?.status === "REWORK_REQUIRED"),
    canObserve: allowsCase("facilities_observe") && selected?.status === "IN_PROGRESS",
    canSubmit: allowsCase("facilities_execute") && isAssignee && selected?.status === "IN_PROGRESS",
    canAccept: allowsCase("facilities_accept") && selected?.status === "AWAITING_ACCEPTANCE",
  };
}
