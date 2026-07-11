// Wire ↔ view mapping for the Ontology Manager: the api/ontology.ts payloads
// (backend serde shapes) onto the §18 editor view types and the ObjectCard
// descriptor, plus the faithful CreateObjectTypeDraft round-trip used to stage
// a v+1 revision (server-side config/formula JSON is passed through verbatim so
// staging never wipes fields the editor does not surface).
import {
  revisionHashVerified,
  type CreateObjectTypeDraft,
  type InstanceStateWire,
  type ObjectTypeDetailWire,
  type RevisionWire,
  type TraversalGraphWire,
} from "../../api/ontology";
import type {
  ObjectCardDescriptor,
  ObjectCardLifecycleStep,
  ObjectCardRelation,
  ObjectCardRevision,
  ObjectLifecycleState,
} from "../objectcard";
import {
  FIELD_KINDS,
  type FieldKind,
  type OntInstanceRow,
  type OntObjectTypeDef,
} from "./types";

/** Short display handle for a UUID (drag-token code). API-derived, no fabrication.
 * Native ontology instance UUIDs share a long all-zero prefix
 * (00000000-…-000000a90001), so a plain leading slice collapses every instance
 * to "00000000"; dropping the dashes + leading-zero padding first keeps the
 * token distinct (mirrors explore/shortId). */
export function instanceCode(id: string): string {
  const hex = id.replace(/-/g, "");
  const distinguishing = hex.replace(/^0+/, "") || hex;
  return distinguishing.slice(0, 8).toUpperCase();
}

// `YYYY-MM-DD HH:mm` in KST — mirrors lib/datetime's formatKoreanDateTime,
// re-implemented locally because console/ modules may not import src/lib/.
const AT_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts: Record<string, string> = {};
  for (const part of AT_FORMAT.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// ponytail: clamp unknown §3c field tags to the closest editor kind (the
// backend reader degrades the same way); a dedicated "unknown" renderer can
// replace this if authoring ever surfaces exotic tags.
export function fieldKindOf(rawTag: string): FieldKind {
  if ((FIELD_KINDS as readonly string[]).includes(rawTag)) {
    return rawTag as FieldKind;
  }
  switch (rawTag) {
    case "integer":
    case "decimal":
      return "number";
    case "timestamp":
      return "datetime";
    case "reference":
      return "object_ref";
    default:
      return "text";
  }
}

function formulaText(formula: unknown): string {
  return typeof formula === "string" ? formula : JSON.stringify(formula ?? "");
}

/** InstanceState → one 인스턴스 subtab row. */
export function instanceRowFromState(state: InstanceStateWire): OntInstanceRow {
  return {
    id: state.instance.id,
    code: instanceCode(state.instance.id),
    title: state.instance.title,
    lifecycleState: state.instance.lifecycle_state,
  };
}

/**
 * ObjectTypeDetail (+ its instances) → the editor's view def.
 * `typeKeyById` resolves link targets (to_object_type_id → stable_key).
 */
export function objectTypeDefFromDetail(
  detail: ObjectTypeDetailWire,
  instances: InstanceStateWire[],
  typeKeyById: ReadonlyMap<string, string>,
): OntObjectTypeDef {
  const head = detail.object_type;
  return {
    id: head.id,
    stableKey: head.stable_key,
    code: head.stable_key,
    title: head.title,
    backingKind: head.backing_kind,
    backingTable: detail.backing_table,
    primaryKeyProperty: detail.primary_key_property,
    titlePropertyKey: detail.title_property_key,
    schemaVersion: head.schema_version,
    lifecycleState: head.lifecycle_state,
    properties: detail.properties.map((property) => ({
      key: property.key,
      title: property.title,
      type: fieldKindOf(property.field_type),
      required: property.required,
      inPropertyPolicy: property.in_property_policy || undefined,
    })),
    links: detail.links.map((link) => ({
      stableKey: link.stable_key,
      title: link.title,
      toTypeKey:
        (link.to_object_type_id
          ? typeKeyById.get(link.to_object_type_id)
          : undefined) ??
        link.to_object_type_id ??
        "",
      cardinality: link.cardinality,
    })),
    actions: detail.actions.map((action) => ({
      stableKey: action.stable_key,
      title: action.title,
      dispatch: action.dispatch,
    })),
    analytics: detail.analytics.map((analytic) => ({
      key: analytic.key,
      title: analytic.title,
      formula: formulaText(analytic.formula),
    })),
    instances: instances.map(instanceRowFromState),
    // Acting automation/policy bindings have no registry read yet.
    // wire-pending: HANDOFF §ontology-acting GET /api/v1/ontology/object-types/{key}/acting
    acting: [],
  };
}

/**
 * Staged editor view → the CreateObjectTypeDraft the PUT stage-revision call
 * sends. Children the server already knows are copied verbatim from the wire
 * detail (config / params_schema / formula JSON untouched); children the
 * editor appended are mapped from their view defs. `typeIdByKey` resolves new
 * link targets back to object-type ids.
 */
export function stagedRevisionDraft(
  detail: ObjectTypeDetailWire,
  staged: OntObjectTypeDef,
  typeIdByKey: ReadonlyMap<string, string>,
): CreateObjectTypeDraft {
  const knownProperties = new Set(detail.properties.map((p) => p.key));
  const knownLinks = new Set(detail.links.map((l) => l.stable_key));
  const knownActions = new Set(detail.actions.map((a) => a.stable_key));
  const knownAnalytics = new Set(detail.analytics.map((a) => a.key));

  return {
    stable_key: detail.object_type.stable_key,
    title: staged.title,
    ...(detail.title_property_key
      ? { title_property_key: detail.title_property_key }
      : {}),
    backing_kind: detail.object_type.backing_kind,
    ...(detail.backing_table ? { backing_table: detail.backing_table } : {}),
    ...(detail.primary_key_property
      ? { primary_key_property: detail.primary_key_property }
      : {}),
    properties: [
      ...detail.properties.map((property) => ({
        key: property.key,
        title: property.title,
        field_type: property.field_type,
        config: property.config,
        backing_column: property.backing_column,
        required: property.required,
        in_property_policy: property.in_property_policy,
      })),
      ...staged.properties
        .filter((property) => !knownProperties.has(property.key))
        .map((property) => ({
          key: property.key,
          title: property.title,
          field_type: property.type,
          required: property.required,
          in_property_policy: property.inPropertyPolicy ?? false,
        })),
    ],
    links: [
      ...detail.links.map((link) => ({
        stable_key: link.stable_key,
        title: link.title,
        reverse_title: link.reverse_title,
        to_object_type_id: link.to_object_type_id,
        cardinality: link.cardinality,
        traversable: link.traversable,
      })),
      ...staged.links
        .filter((link) => !knownLinks.has(link.stableKey))
        .map((link) => ({
          stable_key: link.stableKey,
          title: link.title,
          to_object_type_id: typeIdByKey.get(link.toTypeKey) ?? null,
          // The DB CHECK admits one_one|one_many|many_many; the add form no
          // longer offers the UI-only many_one sugar.
          cardinality: link.cardinality === "many_one" ? "one_many" : link.cardinality,
        })),
    ],
    actions: [
      ...detail.actions.map((action) => ({
        stable_key: action.stable_key,
        title: action.title,
        params_schema: action.params_schema,
        edits: action.edits,
        submission_criteria: action.submission_criteria,
        side_effects: action.side_effects,
        dispatch: action.dispatch,
        dispatch_target: action.dispatch_target,
        control_points: action.control_points,
      })),
      ...staged.actions
        .filter((action) => !knownActions.has(action.stableKey))
        .map((action) => ({
          stable_key: action.stableKey,
          title: action.title,
          dispatch: action.dispatch,
        })),
    ],
    analytics: [
      ...detail.analytics.map((analytic) => ({
        key: analytic.key,
        title: analytic.title,
        formula: analytic.formula,
        result_type: analytic.result_type,
      })),
      ...staged.analytics
        .filter((analytic) => !knownAnalytics.has(analytic.key))
        .map((analytic) => ({
          key: analytic.key,
          title: analytic.title,
          formula: analytic.formula,
        })),
    ],
  };
}

/** FSM stepper for the card: draft → active → (locked) → archived → disposed. */
export function lifecycleStepsOf(
  state: ObjectLifecycleState,
): ObjectCardLifecycleStep[] {
  const order: ObjectLifecycleState[] =
    state === "locked"
      ? ["draft", "active", "locked", "archived", "disposed"]
      : ["draft", "active", "archived", "disposed"];
  const currentIndex = order.indexOf(state);
  return order.map((step, index) => ({
    state: step,
    reached: index <= currentIndex,
    current: index === currentIndex,
  }));
}

/** API history → the card's hash-verified timeline (newest first). */
export function revisionsFromHistory(
  history: RevisionWire[],
): ObjectCardRevision[] {
  const verified = revisionHashVerified(history);
  return [...history]
    .sort((a, b) => b.version - a.version)
    .map((revision) => ({
      version: revision.version,
      at: formatAt(revision.valid_from),
      actor: revision.actor ? instanceCode(revision.actor) : "",
      reason: revision.reason ?? undefined,
      hashVerified: verified.get(revision.version) ?? false,
      action: revision.action_type_id ? instanceCode(revision.action_type_id) : undefined,
    }));
}

function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * The full ObjectCard descriptor from API data only: instance state + history
 * + a depth-1 traversal (relations) + the type detail (property/action defs).
 */
export function objectCardDescriptorFrom({
  state,
  history,
  neighbors,
  detail,
  linkTitleById,
}: {
  state: InstanceStateWire;
  history: RevisionWire[];
  neighbors?: TraversalGraphWire;
  detail?: ObjectTypeDetailWire;
  linkTitleById?: ReadonlyMap<string, string>;
}): ObjectCardDescriptor {
  const head = state.instance;
  const attributes = state.revision.attributes;

  const relations: ObjectCardRelation[] = [];
  if (neighbors) {
    const titleByInstance = new Map(
      neighbors.nodes.map((node) => [node.instance_id, node.title]),
    );
    const cardinalityByLinkType = new Map(
      (detail?.links ?? []).map((link) => [link.id, link.cardinality]),
    );
    for (const edge of neighbors.edges) {
      const outgoing = edge.from_instance_id === head.id;
      const incoming = edge.to_instance_id === head.id;
      if (!outgoing && !incoming) continue;
      const farId = outgoing ? edge.to_instance_id : edge.from_instance_id;
      relations.push({
        linkId: edge.id,
        linkType: linkTitleById?.get(edge.link_type_id) ?? edge.link_type_id,
        direction: outgoing ? "to" : "from",
        cardinality: cardinalityByLinkType.get(edge.link_type_id) ?? "one_many",
        code: instanceCode(farId),
        title: titleByInstance.get(farId) ?? instanceCode(farId),
      });
    }
  }

  return {
    id: head.id,
    code: instanceCode(head.id),
    title: head.title,
    objectType: detail
      ? { key: detail.object_type.stable_key, title: detail.object_type.title }
      : { key: head.object_type_id, title: instanceCode(head.object_type_id) },
    lifecycleState: head.lifecycle_state,
    schemaVersion: detail?.object_type.schema_version,
    properties: (detail?.properties ?? []).map((property) => ({
      key: property.key,
      title: property.title,
      type: property.field_type,
      // null ⇒ property-policy denied / absent server-side (deny-by-omission).
      value: displayValue(attributes[property.key]),
      inPropertyPolicy: property.in_property_policy || undefined,
      required: property.required,
    })),
    relations,
    lifecycle: lifecycleStepsOf(head.lifecycle_state),
    history: revisionsFromHistory(history),
    actions: (detail?.actions ?? []).map((action) => ({
      key: action.stable_key,
      title: action.title,
    })),
  };
}
