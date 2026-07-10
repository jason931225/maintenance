// Ontology action REST — POST /api/v1/ontology/actions/{key}/preflight|execute
// plus the revision-history read the card refreshes after a commit.
//
// Requests are the generated typed client's schemas (OntologyActionRequest).
// The openapi declares the responses as free-form JSON objects; the
// authoritative wire shape is the backend's serde output
// (crates/ontology/rest PreflightOutcome/ExecuteOutcome and
// crates/governance/domain GateChainOutcome). Parsing here is fail-closed:
// anything malformed reads as a denied gate chain, never a silent allow.
import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "./client";

export type OntologyActionRequest =
  components["schemas"]["OntologyActionRequest"];
type ErrorBody = components["schemas"]["ErrorBody"];

/** §16 gate kinds, in the backend's fixed evaluation order. */
export type GateKind =
  | "authority"
  | "self_checklist"
  | "four_eyes"
  | "egress_dlp";

export const GATE_ORDER: readonly GateKind[] = [
  "authority",
  "self_checklist",
  "four_eyes",
  "egress_dlp",
];

export type GateStatusKind =
  | "not_required"
  | "satisfied"
  | "pending"
  | "denied";

export interface GateLine {
  gate: GateKind;
  status: GateStatusKind;
  reason?: string;
}

export interface GateChain {
  allow: boolean;
  gates: GateLine[];
}

export interface ActionPreflight {
  wouldExecute: boolean;
  gates: GateChain;
  criteriaOk: boolean;
  criteriaError?: string;
}

/** The instance state an execute commits (ontology InstanceState). */
export interface ExecutedInstance {
  instanceId: string;
  title: string;
  lifecycleState: string;
  version: number;
  attributes: Record<string, unknown>;
}

export interface ActionExecuteResult {
  instance: ExecutedInstance;
  gates: GateChain;
}

/** One ont_instance_revisions row (RevisionSummary). */
export interface InstanceRevision {
  version: number;
  validFrom: string;
  actor: string | null;
  reason: string | null;
  actionTypeId: string | null;
  prevHash: string;
  rowHash: string;
}

/** Typed API failure carrying the server's error body when present. */
export class ApiCallError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, body?: ErrorBody) {
    super(body?.error.message ?? `request failed (${String(status)})`);
    this.name = "ApiCallError";
    this.status = status;
    this.code = body?.error.code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGateKind(value: unknown): value is GateKind {
  return (GATE_ORDER as readonly unknown[]).includes(value);
}

function isGateStatusKind(value: unknown): value is GateStatusKind {
  return (
    value === "not_required" ||
    value === "satisfied" ||
    value === "pending" ||
    value === "denied"
  );
}

const DENIED_UNPARSED: GateLine[] = GATE_ORDER.map((gate) => ({
  gate,
  status: "denied",
  reason: "fail-closed: gate outcome missing from the response",
}));

/**
 * Parse a GateChainOutcome (`{gates: [{gate, status: {status, reason?}}], allow}`).
 * Fail-closed: a malformed payload yields `allow: false` with denied gates.
 */
export function parseGateChain(value: unknown): GateChain {
  if (!isRecord(value) || !Array.isArray(value.gates)) {
    return { allow: false, gates: DENIED_UNPARSED };
  }
  const gates: GateLine[] = [];
  for (const entry of value.gates) {
    if (!isRecord(entry) || !isGateKind(entry.gate) || !isRecord(entry.status)) {
      return { allow: false, gates: DENIED_UNPARSED };
    }
    const status = entry.status.status;
    if (!isGateStatusKind(status)) {
      return { allow: false, gates: DENIED_UNPARSED };
    }
    gates.push({
      gate: entry.gate,
      status,
      reason:
        typeof entry.status.reason === "string" ? entry.status.reason : undefined,
    });
  }
  // Never trust a bare `allow: true` over the per-gate lines.
  const allow =
    value.allow === true && gates.every((g) => g.status === "not_required" || g.status === "satisfied");
  return { allow, gates };
}

function parseExecutedInstance(value: unknown): ExecutedInstance {
  const state = isRecord(value) ? value : {};
  const head = isRecord(state.instance) ? state.instance : {};
  const revision = isRecord(state.revision) ? state.revision : {};
  return {
    instanceId: typeof head.id === "string" ? head.id : "",
    title: typeof head.title === "string" ? head.title : "",
    lifecycleState:
      typeof head.lifecycle_state === "string" ? head.lifecycle_state : "",
    version: typeof revision.version === "number" ? revision.version : 0,
    attributes: isRecord(revision.attributes) ? revision.attributes : {},
  };
}

/** Preflight the §16 gate chain for one action — commits nothing. */
export async function preflightOntologyAction(
  api: ConsoleApiClient,
  actionKey: string,
  body: OntologyActionRequest,
): Promise<ActionPreflight> {
  const { data, error, response } = await api.POST(
    "/api/v1/ontology/actions/{action_key}/preflight",
    { params: { path: { action_key: actionKey } }, body },
  );
  if (!data) throw new ApiCallError(response.status, error);
  const payload: Record<string, unknown> = data;
  const gates = parseGateChain(payload.gates);
  const criteriaOk = payload.criteria_ok === true;
  return {
    // Fail-closed: only an explicit true is executable.
    wouldExecute: payload.would_execute === true && gates.allow && criteriaOk,
    gates,
    criteriaOk,
    criteriaError:
      typeof payload.criteria_error === "string"
        ? payload.criteria_error
        : undefined,
  };
}

/** Execute an action through the single audited mutation path. */
export async function executeOntologyAction(
  api: ConsoleApiClient,
  actionKey: string,
  body: OntologyActionRequest,
): Promise<ActionExecuteResult> {
  const { data, error, response } = await api.POST(
    "/api/v1/ontology/actions/{action_key}/execute",
    { params: { path: { action_key: actionKey } }, body },
  );
  if (!data) throw new ApiCallError(response.status, error);
  const payload: Record<string, unknown> = data;
  return {
    instance: parseExecutedInstance(payload.instance),
    gates: parseGateChain(payload.gates),
  };
}

/** GET /api/v1/ontology/instances/{id}/history — the fixity-chained timeline. */
export async function fetchInstanceHistory(
  api: ConsoleApiClient,
  instanceId: string,
): Promise<InstanceRevision[]> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/instances/{id}/history",
    { params: { path: { id: instanceId } } },
  );
  if (!data) throw new ApiCallError(response.status, error);
  const revisions: InstanceRevision[] = [];
  for (const row of data) {
    if (!isRecord(row) || typeof row.version !== "number") continue;
    revisions.push({
      version: row.version,
      validFrom: typeof row.valid_from === "string" ? row.valid_from : "",
      actor: typeof row.actor === "string" ? row.actor : null,
      reason: typeof row.reason === "string" ? row.reason : null,
      actionTypeId:
        typeof row.action_type_id === "string" ? row.action_type_id : null,
      prevHash: typeof row.prev_hash === "string" ? row.prev_hash : "",
      rowHash: typeof row.row_hash === "string" ? row.row_hash : "",
    });
  }
  return revisions.sort((a, b) => b.version - a.version);
}
