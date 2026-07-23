// Ontology registry + instance REST — GET/POST /api/v1/ontology/object-types,
// PUT /api/v1/ontology/object-types/{key} (stage v+1 revision), the
// instance reads (list / card / as-of / history / traverse), the dynamic-layer
// acting-read, code resolve, and the instance lifecycle commit.
//
// Requests are the generated typed client's schemas (CreateObjectTypeDraft) and
// every call goes through the typed openapi-fetch paths, so URLs, params and
// bodies are compile-checked. The object-type registry reads are still
// declared free-form in the openapi (ObjectTypeSummary/ObjectTypeDetail schema
// components are contracted in the ontology openapi fragment and adopted at
// consolidation client-regen — until then the casts below narrow the payload);
// the instance reads
// (InstanceHead/RevisionSummary/InstanceState/Traversal*) and the
// acting/resolve/lifecycle payloads DO have real generated schema components
// (be2-ont-gaps), so those casts narrow to the generated types below instead
// of hand-duplicated interfaces.
import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "./client";
import {
  ApiCallError,
  parseGateChain,
  type GateChain,
} from "./ontologyActions";

export type CreateObjectTypeDraft =
  components["schemas"]["CreateObjectTypeDraft"];
type ErrorBody = components["schemas"]["ErrorBody"];

/** §3a schema lifecycle (serde snake_case of SchemaLifecycleState). */
export type WireSchemaLifecycle =
  "draft" | "review_pending" | "published" | "superseded" | "retired";

/** §3b instance lifecycle (serde snake_case of InstanceLifecycleState). */
export type WireInstanceLifecycle =
  "draft" | "active" | "locked" | "archived" | "disposed";

/** ObjectTypeSummary — one ont_object_types head row. */
export interface ObjectTypeSummaryWire {
  id: string;
  stable_key: string;
  title: string;
  backing_kind: "projected" | "instance";
  schema_version: number;
  lifecycle_state: WireSchemaLifecycle;
  key_write_revision: number;
  key_write_etag: string;
}

/** ActingRule — one automation or PBAC policy acting on the instance's type (§2 dynamics). */
export type ActingRuleWire = components["schemas"]["ActingRule"];

/** ResolvedInstance — a code resolved to its identity (run-log/code chip targets). */
export type ResolvedInstanceWire = components["schemas"]["ResolvedInstance"];

/** PropertyDefSummary. `field_type` is the raw stored §3c tag. */
export interface PropertyDefWire {
  id: string;
  key: string;
  title: string;
  field_type: string;
  config: unknown;
  backing_column: string | null;
  required: boolean;
  in_property_policy: boolean;
}

export interface LinkTypeWire {
  id: string;
  stable_key: string;
  title: string;
  reverse_title: string | null;
  to_object_type_id: string | null;
  cardinality: "one_one" | "one_many" | "many_many";
  traversable: boolean;
}

export interface ActionTypeWire {
  id: string;
  stable_key: string;
  title: string;
  params_schema: unknown;
  edits: unknown;
  submission_criteria: unknown;
  side_effects: unknown;
  dispatch: "projected_usecase" | "instance_revision";
  dispatch_target: string | null;
  control_points: unknown;
}

export interface AnalyticWire {
  id: string;
  key: string;
  title: string;
  formula: unknown;
  result_type: unknown;
}

/** ObjectTypeDetail — the summary plus its full child snapshot. */
export interface ObjectTypeDetailWire {
  object_type: ObjectTypeSummaryWire;
  title_property_key: string | null;
  backing_table: string | null;
  primary_key_property: string | null;
  properties: PropertyDefWire[];
  links: LinkTypeWire[];
  actions: ActionTypeWire[];
  analytics: AnalyticWire[];
}

/** RevisionSummary — one fixity-chained ont_instance_revisions row. */
export type RevisionWire = components["schemas"]["RevisionSummary"];

export type InstanceHeadWire = components["schemas"]["InstanceHead"];

/** InstanceState — head + the effective revision. */
export type InstanceStateWire = components["schemas"]["InstanceState"];

export type TraversalNodeWire = components["schemas"]["TraversalNode"];

export type TraversalEdgeWire = components["schemas"]["TraversalEdge"];

export type TraversalGraphWire = components["schemas"]["TraversalGraph"];

export interface ObjectTypeWriteVersion {
  etag: string;
  keyWriteRevision: number;
}

export interface ObjectTypeWriteReceipt {
  objectType: ObjectTypeSummaryWire;
  writeVersion: ObjectTypeWriteVersion;
}

export class OntologyWritePreconditionError extends Error {
  readonly current: ObjectTypeWriteVersion;

  constructor(current: ObjectTypeWriteVersion) {
    super(
      "The ontology object type changed; rebase on the current server version.",
    );
    this.name = "OntologyWritePreconditionError";
    this.current = current;
  }
}

function writeVersionFromSummary(
  summary: ObjectTypeSummaryWire,
  response: Response,
): ObjectTypeWriteVersion {
  const etag = response.headers.get("etag");
  if (etag === null || etag !== summary.key_write_etag) {
    throw new Error(
      "Ontology write response omitted or mismatched its strong ETag",
    );
  }
  return {
    etag,
    keyWriteRevision: summary.key_write_revision,
  };
}

function throwing(status: number, error: ErrorBody | undefined): never {
  throw new ApiCallError(status, error);
}

/** GET /api/v1/ontology/object-types — the tenant's registry heads. */
export async function listObjectTypes(
  api: ConsoleApiClient,
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<ObjectTypeSummaryWire[]> {
  const { data, error, response } = await api.GET("/api/v1/ontology/object-types", {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.forceRefresh ? { headers: { "Cache-Control": "no-store" } } : {}),
  });
  if (!data) throwing(response.status, error);
  return data as unknown as ObjectTypeSummaryWire[];
}

/** GET /api/v1/ontology/object-types/{key} — def + children (head or pinned version). */
export async function getObjectType(
  api: ConsoleApiClient,
  key: string,
  version?: number,
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<ObjectTypeDetailWire> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/object-types/{key}",
    {
      params: {
        path: { key },
        query: version === undefined ? {} : { version },
      },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.forceRefresh ? { headers: { "Cache-Control": "no-store" } } : {}),
    },
  );
  if (!data) throwing(response.status, error);
  return data as unknown as ObjectTypeDetailWire;
}

/** POST /api/v1/ontology/object-types — create a DRAFT type (schema v1). */
export async function createObjectType(
  api: ConsoleApiClient,
  draft: CreateObjectTypeDraft,
): Promise<ObjectTypeSummaryWire> {
  const { data, error, response } = await api.POST(
    "/api/v1/ontology/object-types",
    { body: draft },
  );
  if (!data) throwing(response.status, error);
  return data;
}

/** PUT /api/v1/ontology/object-types/{key} — stage a v+1 schema revision. */
export async function stageObjectTypeRevision(
  api: ConsoleApiClient,
  key: string,
  draft: CreateObjectTypeDraft,
  options: {
    expected: ObjectTypeWriteVersion;
    signal: AbortSignal;
  },
): Promise<ObjectTypeWriteReceipt> {
  const { data, error, response } = await api.PUT(
    "/api/v1/ontology/object-types/{key}",
    {
      params: {
        path: { key },
        header: { "If-Match": options.expected.etag },
      },
      body: draft,
      signal: options.signal,
    },
  );
  if (!data) {
    const currentRevision =
      "current_key_write_revision" in error.error
        ? error.error.current_key_write_revision
        : undefined;
    const currentEtag = response.headers.get("etag");
    if (
      response.status === 412 &&
      currentEtag !== null &&
      typeof currentRevision === "number" &&
      Number.isSafeInteger(currentRevision) &&
      currentRevision >= 1
    ) {
      throw new OntologyWritePreconditionError({
        etag: currentEtag,
        keyWriteRevision: currentRevision,
      });
    }
    throwing(response.status, error);
  }
  const objectType = data;
  return {
    objectType,
    writeVersion: writeVersionFromSummary(objectType, response),
  };
}

/** GET /api/v1/ontology/instances?type= — current-state instances of one type version. */
export async function listInstances(
  api: ConsoleApiClient,
  objectTypeVersionId: string,
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<InstanceStateWire[]> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/instances",
    {
      params: { query: { type: objectTypeVersionId } },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.forceRefresh
        ? { headers: { "Cache-Control": "no-store" } }
        : {}),
    },
  );
  if (!data) throwing(response.status, error);
  return data as unknown as InstanceStateWire[];
}

/** GET /api/v1/ontology/instances/{id} — one instance card (current or as-of). */
export async function getInstance(
  api: ConsoleApiClient,
  id: string,
  asOf?: string,
): Promise<InstanceStateWire> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/instances/{id}",
    {
      params: {
        path: { id },
        query: asOf === undefined ? {} : { as_of: asOf },
      },
    },
  );
  if (!data) throwing(response.status, error);
  return data as unknown as InstanceStateWire;
}

/** GET /api/v1/ontology/instances/{id}/history — fixity-chained revisions. */
export async function getInstanceHistory(
  api: ConsoleApiClient,
  id: string,
): Promise<RevisionWire[]> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/instances/{id}/history",
    { params: { path: { id } } },
  );
  if (!data) throwing(response.status, error);
  return data as unknown as RevisionWire[];
}

/** GET /api/v1/ontology/instances/{id}/traverse — depth-bounded search-around. */
export async function traverseInstance(
  api: ConsoleApiClient,
  id: string,
  options: { linkType?: string; depth?: number } = {},
): Promise<TraversalGraphWire> {
  const query: { link_type?: string; depth?: number } = {};
  if (options.linkType !== undefined) query.link_type = options.linkType;
  if (options.depth !== undefined) query.depth = options.depth;
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/instances/{id}/traverse",
    { params: { path: { id }, query } },
  );
  if (!data) throwing(response.status, error);
  return data as unknown as TraversalGraphWire;
}

/** Genesis prev_hash of every instance's first revision (64 hex zeros). */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Per-revision fixity-chain linkage from the API payload: a revision is
 * verified when its prev_hash matches the previous revision's row_hash
 * (genesis for v1) and it carries a row_hash. Input order does not matter.
 */
export function revisionHashVerified(
  history: RevisionWire[],
): Map<number, boolean> {
  const byVersion = [...history].sort((a, b) => a.version - b.version);
  const verified = new Map<number, boolean>();
  let previousRowHash = GENESIS_HASH;
  for (const revision of byVersion) {
    verified.set(
      revision.version,
      revision.row_hash.length > 0 && revision.prev_hash === previousRowHash,
    );
    previousRowHash = revision.row_hash;
  }
  return verified;
}

// ── Dynamic layer + lifecycle commit (be2-ont-gaps) ────────────────────────

/** GET /api/v1/ontology/instances/{id}/acting — automations + policies bound to the instance's type (§2 dynamics). */
export async function getInstanceActing(
  api: ConsoleApiClient,
  id: string,
): Promise<ActingRuleWire[]> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/instances/{id}/acting",
    { params: { path: { id } } },
  );
  if (!data) throwing(response.status, error);
  return data;
}

/**
 * GET /api/v1/ontology/object-types/{key}/acting — automations + policies bound
 * to the TYPE (the 자동화 subtab, which is type-centric and may show a type with
 * no instances). Same `ActingRule[]` payload as the instance-keyed read; the
 * path is now in the generated client (ontology fragment merged), so it goes
 * through the typed `api.GET` directly like its instance-keyed sibling.
 */
export async function getObjectTypeActing(
  api: ConsoleApiClient,
  key: string,
): Promise<ActingRuleWire[]> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/object-types/{key}/acting",
    { params: { path: { key } } },
  );
  if (!data) throwing(response.status, error);
  return data;
}

/**
 * GET /api/v1/ontology/resolve?code= — run-log/code chip target lookup.
 * Deny-by-omission: an unknown or cross-tenant code resolves to `null`
 * (never thrown), so callers can't distinguish "doesn't exist" from
 * "not yours" — a 404 renders as unresolved, never as a fabricated title.
 */
export async function resolveInstanceCode(
  api: ConsoleApiClient,
  code: string,
): Promise<ResolvedInstanceWire | null> {
  const { data, error, response } = await api.GET("/api/v1/ontology/resolve", {
    params: { query: { code } },
  });
  if (data) return data;
  if (response.status === 404) return null;
  throwing(response.status, error);
}

export type LifecycleRequestBody = components["schemas"]["LifecycleRequest"];

export interface LifecycleCommitResult {
  instance: InstanceHeadWire;
  gates: GateChain;
}

/** POST /api/v1/ontology/instances/{id}/lifecycle — commit an FSM edge (§3b), gate-chain fail-closed. */
export async function commitInstanceLifecycle(
  api: ConsoleApiClient,
  id: string,
  body: LifecycleRequestBody,
): Promise<LifecycleCommitResult> {
  const { data, error, response } = await api.POST(
    "/api/v1/ontology/instances/{id}/lifecycle",
    { params: { path: { id } }, body },
  );
  if (!data) throw new ApiCallError(response.status, error);
  return { instance: data.instance, gates: parseGateChain(data.gates) };
}
