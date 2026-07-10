// Governance REST — POST /api/v1/governance/{overrides,approvals/decide,
// lifecycle/transitions,lifecycle/preflight}.
//
// Requests are the generated typed client's schemas. Responses are declared
// free-form in the openapi; the authoritative wire shapes are the backend's
// serde output (crates/governance/application OverrideSummary /
// ApprovalSummary / LifecycleTransitionConfig and crates/governance/rest
// PreflightResponse). Parsing is fail-closed.
import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "./client";
import { ApiCallError, parseGateChain, type GateChain } from "./ontologyActions";

export interface GovernanceCreateApprovalRequest {
  request_ref: string;
  kind: string;
  payload_summary?: Record<string, unknown>;
}

/** gov_approvals row opened (pending) — createGovernanceApproval response. */
export interface ApprovalPending {
  id: string;
  requestRef: string;
  kind: string;
  requestedBy: string;
  payloadSummary: Record<string, unknown>;
  createdAt: string;
}

export type GovernanceOpenOverrideRequest =
  components["schemas"]["GovernanceOpenOverrideRequest"];
export type GovernanceDecideApprovalRequest =
  components["schemas"]["GovernanceDecideApprovalRequest"];
export type GovernanceConfigureTransitionRequest =
  components["schemas"]["GovernanceConfigureTransitionRequest"];
export type GovernanceLifecyclePreflightRequest =
  components["schemas"]["GovernanceLifecyclePreflightRequest"];
/** SCREAMING_SNAKE lifecycle state ("DRAFT" | "ACTIVE" | ...). */
export type WireLifecycleState = components["schemas"]["LifecycleState"];

/** gov_overrides row opened for a post-draft edit (OverrideSummary). */
export interface OverridePending {
  id: string;
  targetType: string;
  targetId: string;
  /** Requester — four-eyes: the approver must differ from this principal. */
  actor: string;
  reason: string;
  createdAt: string;
}

/** gov_approvals decision row (ApprovalSummary). */
export interface ApprovalDecided {
  id: string;
  requestRef: string;
  kind: string;
  requestedBy: string;
  approverId: string;
  decision: "approved" | "rejected";
  decidedAt: string;
}

/** Lifecycle-edge gate preflight; an unconfigured edge is fail-closed. */
export interface LifecyclePreflight {
  configured: boolean;
  gates: GateChain;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** POST /api/v1/governance/approvals — open a pending four-eyes approval request. */
export async function createGovernanceApproval(
  api: ConsoleApiClient,
  body: GovernanceCreateApprovalRequest,
): Promise<ApprovalPending> {
  const { data, error, response } = await api.POST("/api/v1/governance/approvals", {
    body,
  });
  if (!data) throw new ApiCallError(response.status, error);
  const payload: Record<string, unknown> = data;
  return {
    id: str(payload.id),
    requestRef: str(payload.request_ref),
    kind: str(payload.kind),
    requestedBy: str(payload.requested_by),
    payloadSummary: isRecord(payload.payload_summary) ? payload.payload_summary : {},
    createdAt: str(payload.created_at),
  };
}

/** Open a post-draft override (reason + before-snapshot, append-only). */
export async function openGovernanceOverride(
  api: ConsoleApiClient,
  body: GovernanceOpenOverrideRequest,
): Promise<OverridePending> {
  const { data, error, response } = await api.POST(
    "/api/v1/governance/overrides",
    { body },
  );
  if (!data) throw new ApiCallError(response.status, error);
  const payload: Record<string, unknown> = data;
  return {
    id: str(payload.id),
    targetType: str(payload.target_type),
    targetId: str(payload.target_id),
    actor: str(payload.actor),
    reason: str(payload.reason),
    createdAt: str(payload.created_at),
  };
}

/**
 * Record a four-eyes decision. The server rejects a self-approval
 * (approver == requester) — surfaced as the thrown ApiCallError's message.
 */
export async function decideGovernanceApproval(
  api: ConsoleApiClient,
  body: GovernanceDecideApprovalRequest,
): Promise<ApprovalDecided> {
  const { data, error, response } = await api.POST(
    "/api/v1/governance/approvals/decide",
    { body },
  );
  if (!data) throw new ApiCallError(response.status, error);
  const payload: Record<string, unknown> = data;
  const decision = payload.decision === "approved" ? "approved" : "rejected";
  return {
    id: str(payload.id),
    requestRef: str(payload.request_ref),
    kind: str(payload.kind),
    requestedBy: str(payload.requested_by),
    approverId: str(payload.approver_id),
    decision,
    decidedAt: str(payload.decided_at),
  };
}

/** Preflight one lifecycle edge's gate chain — commits nothing, fail-closed. */
export async function preflightLifecycleTransition(
  api: ConsoleApiClient,
  body: GovernanceLifecyclePreflightRequest,
): Promise<LifecyclePreflight> {
  const { data, error, response } = await api.POST(
    "/api/v1/governance/lifecycle/preflight",
    { body },
  );
  if (!data) throw new ApiCallError(response.status, error);
  const payload: Record<string, unknown> = data;
  return {
    configured: payload.configured === true,
    gates: parseGateChain(payload.outcome),
  };
}

/** Configure the requirements of one object-type lifecycle edge. */
export async function configureLifecycleTransition(
  api: ConsoleApiClient,
  body: GovernanceConfigureTransitionRequest,
): Promise<GovernanceConfigureTransitionRequest> {
  const { data, error, response } = await api.POST(
    "/api/v1/governance/lifecycle/transitions",
    { body },
  );
  if (!data) throw new ApiCallError(response.status, error);
  const payload: Record<string, unknown> = data;
  const requirements = isRecord(payload.requirements) ? payload.requirements : {};
  return {
    object_type_id: str(payload.object_type_id),
    from_state: (str(payload.from_state) || body.from_state) as WireLifecycleState,
    to_state: (str(payload.to_state) || body.to_state) as WireLifecycleState,
    requires_reason: requirements.requires_reason === true,
    requires_four_eyes: requirements.requires_four_eyes === true,
    requires_checklist: requirements.requires_checklist === true,
  };
}
