// Ontology registry + instance REST — GET/POST /api/v1/ontology/object-types,
// PUT /api/v1/ontology/object-types/{key} (stage v+1 revision), and the
// instance reads (list / card / as-of / history / traverse).
//
// Requests are the generated typed client's schemas (CreateObjectTypeDraft) and
// every call goes through the typed openapi-fetch paths, so URLs, params and
// bodies are compile-checked. The openapi declares these READ responses as
// free-form JSON objects; the authoritative wire shape is the backend's serde
// output (crates/ontology/adapter-postgres ObjectTypeSummary/ObjectTypeDetail/
// InstanceState/RevisionSummary/TraversalGraph) — same convention as
// api/ontologyActions.ts. wire-pending: HANDOFF §ontology-response-schemas —
// openapi.yaml should type these response bodies so the narrowing interfaces
// below become generated.
import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "./client";
import { ApiCallError } from "./ontologyActions";

export type CreateObjectTypeDraft =
  components["schemas"]["CreateObjectTypeDraft"];
type ErrorBody = components["schemas"]["ErrorBody"];

/** §3a schema lifecycle (serde snake_case of SchemaLifecycleState). */
export type WireSchemaLifecycle =
  | "draft"
  | "review_pending"
  | "published"
  | "superseded"
  | "retired";

/** §3b instance lifecycle (serde snake_case of InstanceLifecycleState). */
export type WireInstanceLifecycle =
  | "draft"
  | "active"
  | "locked"
  | "archived"
  | "disposed";

/** ObjectTypeSummary — one ont_object_types head row. */
export interface ObjectTypeSummaryWire {
  id: string;
  stable_key: string;
  title: string;
  backing_kind: "projected" | "instance";
  schema_version: number;
  lifecycle_state: WireSchemaLifecycle;
}

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
export interface RevisionWire {
  id: string;
  instance_id: string;
  version: number;
  attributes: Record<string, unknown>;
  valid_from: string;
  valid_to: string | null;
  action_type_id: string | null;
  actor: string | null;
  reason: string | null;
  prev_hash: string;
  row_hash: string;
}

export interface InstanceHeadWire {
  id: string;
  object_type_id: string;
  title: string;
  current_revision_id: string | null;
  lifecycle_state: WireInstanceLifecycle;
}

/** InstanceState — head + the effective revision. */
export interface InstanceStateWire {
  instance: InstanceHeadWire;
  revision: RevisionWire;
}

export interface TraversalNodeWire {
  instance_id: string;
  object_type_id: string;
  title: string;
  lifecycle_state: WireInstanceLifecycle;
  depth: number;
}

export interface TraversalEdgeWire {
  id: string;
  link_type_id: string;
  from_instance_id: string;
  to_instance_id: string;
}

export interface TraversalGraphWire {
  root: string;
  nodes: TraversalNodeWire[];
  edges: TraversalEdgeWire[];
}

function throwing(status: number, error: ErrorBody | undefined): never {
  throw new ApiCallError(status, error);
}

/** GET /api/v1/ontology/object-types — the tenant's registry heads. */
export async function listObjectTypes(
  api: ConsoleApiClient,
): Promise<ObjectTypeSummaryWire[]> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/object-types",
  );
  if (!data) throwing(response.status, error);
  return data as unknown as ObjectTypeSummaryWire[];
}

/** GET /api/v1/ontology/object-types/{key} — def + children (head or pinned version). */
export async function getObjectType(
  api: ConsoleApiClient,
  key: string,
  version?: number,
): Promise<ObjectTypeDetailWire> {
  const { data, error, response } = await api.GET(
    "/api/v1/ontology/object-types/{key}",
    {
      params: {
        path: { key },
        query: version === undefined ? {} : { version },
      },
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
  return data as unknown as ObjectTypeSummaryWire;
}

/** PUT /api/v1/ontology/object-types/{key} — stage a v+1 schema revision. */
export async function stageObjectTypeRevision(
  api: ConsoleApiClient,
  key: string,
  draft: CreateObjectTypeDraft,
): Promise<ObjectTypeSummaryWire> {
  const { data, error, response } = await api.PUT(
    "/api/v1/ontology/object-types/{key}",
    { params: { path: { key } }, body: draft },
  );
  if (!data) throwing(response.status, error);
  return data as unknown as ObjectTypeSummaryWire;
}

/** GET /api/v1/ontology/instances?type= — current-state instances of one type version. */
export async function listInstances(
  api: ConsoleApiClient,
  objectTypeVersionId: string,
): Promise<InstanceStateWire[]> {
  const { data, error, response } = await api.GET("/api/v1/ontology/instances", {
    params: { query: { type: objectTypeVersionId } },
  });
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
