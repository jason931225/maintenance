import type {
  ObjectTypeSummaryWire,
  TraversalGraphWire,
  WireInstanceLifecycle,
  WireSchemaLifecycle,
} from "../../api/ontology";

export const OBJECT_EXPLORER_ACTIONS = {
  recenter: "console.object_explorer.recenter",
  back: "console.object_explorer.back",
  search: "console.object_explorer.search",
  createNode: "console.object_explorer.node.create",
} as const;

export type StatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

export type ObjectLifecyclePhase = "draft" | "review" | "active" | "revision" | "archived" | "disposed";

export interface ObjectLifecycleState {
  phase: ObjectLifecyclePhase;
  version?: string;
}

export interface ObjectExplorerNode {
  id: string;
  type: string;
  code: string;
  label: string;
  lifecycle?: ObjectLifecycleState;
  automation_chips?: string[];
  trigger_bindings?: string[];
  type_id?: string;
}

export interface ObjectExplorerLink {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
}

export interface ObjectExplorerTypeCard {
  id: string;
  /** Registry stable_key (API-derived display handle). */
  code: string;
  label: string;
  lifecycle: ObjectLifecycleState;
  active_object_count: number;
  owner?: string;
  trigger_bindings?: string[];
  governance_chips?: string[];
}

export interface ObjectExplorerSeriesCard {
  id: string;
  code: `SR-${string}`;
  label: string;
  lifecycle: ObjectLifecycleState;
  member_codes: string[];
  trigger_bindings?: string[];
  governance_chips?: string[];
}

export interface ObjectExplorerModel {
  nodes: ObjectExplorerNode[];
  object_links: ObjectExplorerLink[];
  object_types?: ObjectExplorerTypeCard[];
  series_cards?: ObjectExplorerSeriesCard[];
}

export interface ObjectRelationView {
  link: ObjectExplorerLink;
  node: ObjectExplorerNode;
}

export interface ObjectExplorerView {
  focus: ObjectExplorerNode;
  nodes: ObjectExplorerNode[];
  links: ObjectExplorerLink[];
  upstream: ObjectRelationView[];
  downstream: ObjectRelationView[];
}

export interface ObjectExplorerNodeLayout {
  id: string;
  node: ObjectExplorerNode;
  x: number;
  y: number;
  role: "focus" | "upstream" | "downstream" | "related";
}

export function lifecycleTone(phase: ObjectLifecyclePhase): StatusTone {
  if (phase === "active") return "ok";
  if (phase === "review" || phase === "revision") return "warn";
  if (phase === "archived" || phase === "disposed") return "neutral";
  return "info";
}

function nodeMap(nodes: ObjectExplorerNode[]): Map<string, ObjectExplorerNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function uniqueRelations(items: ObjectRelationView[]): ObjectRelationView[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.link.id)) return false;
    seen.add(item.link.id);
    return true;
  });
}

function collectReachableNodeIds(model: ObjectExplorerModel, focusId: string): Set<string> {
  const knownNodes = nodeMap(model.nodes);
  const reachable = new Set<string>([focusId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const link of model.object_links) {
      if (!knownNodes.has(link.source_id) || !knownNodes.has(link.target_id)) continue;
      if (reachable.has(link.source_id) && !reachable.has(link.target_id)) {
        reachable.add(link.target_id);
        changed = true;
      }
      if (reachable.has(link.target_id) && !reachable.has(link.source_id)) {
        reachable.add(link.source_id);
        changed = true;
      }
    }
  }

  return reachable;
}

export function buildObjectExplorerView(model: ObjectExplorerModel, focusId?: string): ObjectExplorerView {
  const nodesById = nodeMap(model.nodes);
  const focus = (focusId ? nodesById.get(focusId) : undefined) ?? model.nodes.at(0);
  if (!focus) {
    throw new Error("ObjectExplorerModel requires at least one node");
  }

  const reachableIds = collectReachableNodeIds(model, focus.id);
  const nodes = model.nodes.filter((node) => reachableIds.has(node.id));
  const links = model.object_links.filter((link) => reachableIds.has(link.source_id) && reachableIds.has(link.target_id));

  const upstream = links
    .filter((link) => link.target_id === focus.id)
    .map((link) => ({ link, node: nodesById.get(link.source_id) }))
    .filter((item): item is ObjectRelationView => item.node !== undefined);

  const downstream = links
    .filter((link) => link.source_id === focus.id)
    .map((link) => ({ link, node: nodesById.get(link.target_id) }))
    .filter((item): item is ObjectRelationView => item.node !== undefined);

  return {
    focus,
    nodes,
    links,
    upstream: uniqueRelations(upstream),
    downstream: uniqueRelations(downstream),
  };
}

function distribute(count: number, index: number): number {
  return Math.round(((index + 1) * 100) / (count + 1));
}

export function layoutObjectExplorerNodes(view: ObjectExplorerView): ObjectExplorerNodeLayout[] {
  const layouts: ObjectExplorerNodeLayout[] = [
    {
      id: view.focus.id,
      node: view.focus,
      x: 50,
      y: 50,
      role: "focus",
    },
  ];
  const placed = new Set<string>([view.focus.id]);

  view.upstream.forEach((relation, index) => {
    layouts.push({
      id: relation.node.id,
      node: relation.node,
      x: 18,
      y: distribute(view.upstream.length, index),
      role: "upstream",
    });
    placed.add(relation.node.id);
  });

  view.downstream.forEach((relation, index) => {
    layouts.push({
      id: relation.node.id,
      node: relation.node,
      x: 82,
      y: distribute(view.downstream.length, index),
      role: "downstream",
    });
    placed.add(relation.node.id);
  });

  const relatedNodes = view.nodes.filter((node) => !placed.has(node.id));
  relatedNodes.forEach((node, index) => {
    layouts.push({
      id: node.id,
      node,
      x: distribute(relatedNodes.length, index),
      y: 84,
      role: "related",
    });
  });

  return layouts;
}

function nextObOrdinal(nodes: ObjectExplorerNode[]): number {
  return nodes.reduce((max, node) => {
    const match = /^OB-(\d+)$/.exec(node.code);
    if (!match) return max;
    return Math.max(max, Number.parseInt(match[1], 10));
  }, 0) + 1;
}

function objectIdSlug(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z\u3131-\uD79D]+/gu, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "node";
}

// ---------------------------------------------------------------------------
// API → model mapping (GET /api/v1/ontology/instances/{id}/traverse +
// /object-types). The graph layout above is unchanged; this is the data seam.
// ---------------------------------------------------------------------------

/** A short reference token derived from a raw id, for the (rare) case a
 * backend source has no canonical business code — e.g. native ontology
 * instances (`ont_instances` carries no code column) or a search hit whose
 * `ObjectHead.code` came back `None`. Deliberately NOT the raw UUID: an
 * 8-char uppercase hex fragment reads as a reference token, not as "here is
 * an internal database id" (§4-25-⑥ no fabricated business codes, but also
 * no raw-id leaks). */
export function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function instancePhase(state: WireInstanceLifecycle): ObjectLifecyclePhase {
  return state === "locked" ? "revision" : state;
}

function schemaPhase(state: WireSchemaLifecycle): ObjectLifecyclePhase {
  switch (state) {
    case "draft":
      return "draft";
    case "review_pending":
      return "review";
    case "published":
      return "active";
    case "superseded":
      return "archived";
    case "retired":
      return "disposed";
  }
}

/**
 * Build the explorer model from ontology REST payloads: traversal node/edge
 * graphs (merged, deduplicated by id) + the type registry rail. Relation
 * labels come from `linkTitleById` (registry link-type titles), falling back
 * to the raw link-type id.
 */
export function ontologyExplorerModel({
  graphs,
  types,
  linkTitleById,
  typeTitleById,
  instanceCountByTypeId,
}: {
  graphs: TraversalGraphWire[];
  types: ObjectTypeSummaryWire[];
  linkTitleById: ReadonlyMap<string, string>;
  typeTitleById: ReadonlyMap<string, string>;
  instanceCountByTypeId: ReadonlyMap<string, number>;
}): ObjectExplorerModel {
  const nodes = new Map<string, ObjectExplorerNode>();
  const links = new Map<string, ObjectExplorerLink>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      nodes.set(node.instance_id, {
        id: node.instance_id,
        type: typeTitleById.get(node.object_type_id) ?? node.object_type_id,
        type_id: node.object_type_id,
        code: shortId(node.instance_id),
        label: node.title,
        lifecycle: { phase: instancePhase(node.lifecycle_state) },
      });
    }
    for (const edge of graph.edges) {
      links.set(edge.id, {
        id: edge.id,
        source_id: edge.from_instance_id,
        target_id: edge.to_instance_id,
        relation: linkTitleById.get(edge.link_type_id) ?? edge.link_type_id,
      });
    }
  }
  return {
    nodes: [...nodes.values()],
    object_links: [...links.values()],
    object_types: types.map((type) => ({
      id: type.id,
      code: type.stable_key,
      label: type.title,
      lifecycle: {
        phase: schemaPhase(type.lifecycle_state),
        version: `v${String(type.schema_version)}`,
      },
      active_object_count: instanceCountByTypeId.get(type.id) ?? 0,
    })),
  };
}

export function createDraftObjectNode({
  label,
  type,
  existingNodes,
}: {
  label: string;
  type: ObjectExplorerTypeCard;
  existingNodes: ObjectExplorerNode[];
}): ObjectExplorerNode | undefined {
  const trimmedLabel = label.trim();
  if (trimmedLabel.length === 0) return undefined;

  const ordinal = nextObOrdinal(existingNodes);
  const code = `OB-${String(ordinal).padStart(3, "0")}`;
  return {
    id: `${code.toLowerCase()}-${objectIdSlug(trimmedLabel)}`,
    type: type.id,
    type_id: type.id,
    code,
    label: trimmedLabel,
    lifecycle: { phase: "draft", version: "v1" },
    trigger_bindings: type.trigger_bindings ? [...type.trigger_bindings] : undefined,
  };
}
