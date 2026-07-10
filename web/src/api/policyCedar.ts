// Cedar policy authoring + point-decision data module (§5a drafts/catalog,
// §5c simulate/authorize). Request bodies are the generated OpenAPI types.
// The OpenAPI declares these response bodies as untyped JSON objects (the
// backend serializes CatalogEntry / DraftRecord / DecisionResponse), so each
// reader narrows the generated `Record<string, unknown>` at the edge and
// fails closed on malformed payloads instead of guessing.

import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "./client";

export type PolicyNoCodeBlocks = components["schemas"]["PolicyNoCodeBlocks"];
export type PolicyNoCodeCondition =
  components["schemas"]["PolicyNoCodeCondition"];
export type PolicyCreateDraftRequest =
  components["schemas"]["PolicyCreateDraftRequest"];
export type PolicyUpdateDraftRequest =
  components["schemas"]["PolicyUpdateDraftRequest"];
export type PolicyReviewRequest = components["schemas"]["PolicyReviewRequest"];
export type PolicySimulateRequest =
  components["schemas"]["PolicySimulateRequest"];
export type PolicyAuthorizeRequest =
  components["schemas"]["PolicyAuthorizeRequest"];
export type PolicySimRequest = components["schemas"]["PolicySimRequest"];
export type PolicySimSubject = components["schemas"]["PolicySimSubject"];
export type PolicySimResource = components["schemas"]["PolicySimResource"];

/**
 * The tagged right-hand side the backend (de)serializes for a condition value
 * (serde `tag = "kind", content = "value"`). Narrows the generated loose
 * `PolicyNoCodeCondition["value"]`.
 */
export type PolicyConditionRhs =
  | { kind: "literal"; value: string }
  | { kind: "subject_attr"; value: string }
  | { kind: "bool"; value: boolean };

/** `cedar_policy_drafts.review_status` (four-eyes draft FSM). */
export type PolicyReviewStatus =
  | "draft"
  | "review_pending"
  | "rejected"
  | "approved_for_promotion";

/** Narrowed backend `CatalogEntry` (GET /policy/catalog row). */
export interface PolicyCatalogEntry {
  id: string;
  stable_key: string;
  title: string;
  effect: "permit" | "forbid";
  /** enforced | shadow | draft | review_pending | rejected | retired */
  status: string;
  source: string;
  validation_status: string;
  updated_at: string;
}

/** Narrowed backend `DraftRecord` (drafts CRUD / validate / submit / review). */
export interface PolicyDraft {
  id: string;
  draft_key: string;
  title: string;
  /** The draft's normalized no-code payload (effect/action/resource_type/conditions). */
  blocks: PolicyNoCodeBlocks;
  generated_policy_text: string;
  /** valid | invalid */
  validation_status: string;
  validation_errors: string[];
  review_status: PolicyReviewStatus;
  reviewer_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Narrowed backend `SimulationOutcome` (simulate/authorize `outcome`). */
export interface PolicySimulationOutcome {
  effect: "allow" | "deny";
  determining_policies: string[];
  errors: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

class PolicyApiError extends Error {}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyApiError(`unexpected ${what} payload`);
  }
  return value as Record<string, unknown>;
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new PolicyApiError(`missing field ${key}`);
  }
  return value;
}

function nullableStr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseEffect(value: string): "permit" | "forbid" {
  if (value !== "permit" && value !== "forbid") {
    throw new PolicyApiError(`unexpected effect ${value}`);
  }
  return value;
}

const REVIEW_STATUSES: readonly PolicyReviewStatus[] = [
  "draft",
  "review_pending",
  "rejected",
  "approved_for_promotion",
];

function parseReviewStatus(value: string): PolicyReviewStatus {
  const status = REVIEW_STATUSES.find((candidate) => candidate === value);
  if (!status) throw new PolicyApiError(`unexpected review_status ${value}`);
  return status;
}

function parseCondition(value: unknown): PolicyNoCodeCondition {
  const row = asRecord(value, "condition");
  const op = str(row, "op");
  if (op !== "eq" && op !== "ne" && op !== "contains") {
    throw new PolicyApiError(`unexpected condition op ${op}`);
  }
  return {
    attr: str(row, "attr"),
    op,
    value: asRecord(row.value, "condition value"),
  };
}

/** Parse the draft's `normalized_row` — the canonical no-code blocks payload. */
export function parsePolicyBlocks(value: unknown): PolicyNoCodeBlocks {
  const row = asRecord(value, "blocks");
  return {
    effect: parseEffect(str(row, "effect")),
    action: str(row, "action"),
    resource_type: str(row, "resource_type"),
    conditions: Array.isArray(row.conditions)
      ? row.conditions.map(parseCondition)
      : [],
  };
}

function parseCatalogEntry(value: unknown): PolicyCatalogEntry {
  const row = asRecord(value, "catalog entry");
  return {
    id: str(row, "id"),
    stable_key: str(row, "stable_key"),
    title: str(row, "title"),
    effect: parseEffect(str(row, "effect")),
    status: str(row, "status"),
    source: str(row, "source"),
    validation_status: str(row, "validation_status"),
    updated_at: str(row, "updated_at"),
  };
}

function parseDraft(value: unknown): PolicyDraft {
  const row = asRecord(value, "draft");
  return {
    id: str(row, "id"),
    draft_key: str(row, "draft_key"),
    title: str(row, "title"),
    blocks: parsePolicyBlocks(row.normalized_row),
    generated_policy_text: str(row, "generated_policy_text"),
    validation_status: str(row, "validation_status"),
    validation_errors: strArray(row.validation_errors),
    review_status: parseReviewStatus(str(row, "review_status")),
    reviewer_id: nullableStr(row, "reviewer_id"),
    created_by: str(row, "created_by"),
    created_at: str(row, "created_at"),
    updated_at: str(row, "updated_at"),
  };
}

function parseOutcome(value: unknown): PolicySimulationOutcome {
  const outcome = asRecord(asRecord(value, "decision").outcome, "outcome");
  const effect = str(outcome, "effect");
  if (effect !== "allow" && effect !== "deny") {
    throw new PolicyApiError(`unexpected decision effect ${effect}`);
  }
  return {
    effect,
    determining_policies: strArray(outcome.determining_policies),
    errors: strArray(outcome.errors),
    reason: str(outcome, "reason"),
  };
}

/** Extract the backend ErrorBody message; falls back to the HTTP failure. */
function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "error" in error) {
    const body = error.error;
    if (typeof body === "object" && body !== null && "message" in body) {
      const message = body.message;
      if (typeof message === "string" && message) return message;
    }
  }
  return "request failed";
}

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.data === undefined) {
    throw new PolicyApiError(errorMessage(result.error));
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function listPolicyCatalog(
  api: ConsoleApiClient,
  status?: string,
): Promise<PolicyCatalogEntry[]> {
  const result = await api.GET("/api/v1/policy/catalog", {
    params: { query: status ? { status } : {} },
  });
  return unwrap(result).map(parseCatalogEntry);
}

export async function listPolicyDrafts(
  api: ConsoleApiClient,
): Promise<PolicyDraft[]> {
  const result = await api.GET("/api/v1/policy/drafts");
  return unwrap(result).map(parseDraft);
}

export async function createPolicyDraft(
  api: ConsoleApiClient,
  body: PolicyCreateDraftRequest,
): Promise<PolicyDraft> {
  const result = await api.POST("/api/v1/policy/drafts", { body });
  return parseDraft(unwrap(result));
}

export async function getPolicyDraft(
  api: ConsoleApiClient,
  draftId: string,
): Promise<PolicyDraft> {
  const result = await api.GET("/api/v1/policy/drafts/{draft_id}", {
    params: { path: { draft_id: draftId } },
  });
  return parseDraft(unwrap(result));
}

export async function updatePolicyDraft(
  api: ConsoleApiClient,
  draftId: string,
  body: PolicyUpdateDraftRequest,
): Promise<PolicyDraft> {
  const result = await api.PUT("/api/v1/policy/drafts/{draft_id}", {
    params: { path: { draft_id: draftId } },
    body,
  });
  return parseDraft(unwrap(result));
}

export async function validatePolicyDraft(
  api: ConsoleApiClient,
  draftId: string,
): Promise<PolicyDraft> {
  const result = await api.POST("/api/v1/policy/drafts/{draft_id}/validate", {
    params: { path: { draft_id: draftId } },
  });
  return parseDraft(unwrap(result));
}

export async function submitPolicyDraft(
  api: ConsoleApiClient,
  draftId: string,
): Promise<PolicyDraft> {
  const result = await api.POST("/api/v1/policy/drafts/{draft_id}/submit", {
    params: { path: { draft_id: draftId } },
  });
  return parseDraft(unwrap(result));
}

export async function reviewPolicyDraft(
  api: ConsoleApiClient,
  draftId: string,
  body: PolicyReviewRequest,
): Promise<PolicyDraft> {
  const result = await api.POST("/api/v1/policy/drafts/{draft_id}/review", {
    params: { path: { draft_id: draftId } },
    body,
  });
  return parseDraft(unwrap(result));
}

export async function simulatePolicy(
  api: ConsoleApiClient,
  body: PolicySimulateRequest,
): Promise<PolicySimulationOutcome> {
  const result = await api.POST("/api/v1/policy/simulate", { body });
  return parseOutcome(unwrap(result));
}

export async function authorizePolicy(
  api: ConsoleApiClient,
  body: PolicyAuthorizeRequest,
): Promise<PolicySimulationOutcome> {
  const result = await api.POST("/api/v1/policy/authorize", { body });
  return parseOutcome(unwrap(result));
}
