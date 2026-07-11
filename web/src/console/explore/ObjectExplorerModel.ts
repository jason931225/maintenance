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

// Concentric-ring radial layout: the focus sits at the centre and every other
// node is placed on a ring whose radius grows with its graph distance (BFS
// hops) from the focus, spread evenly by angle around that ring. This replaces
// the old left/right-column + bottom-band placement, which piled deep neighbours
// into an unreadable vertical cluster and a false "timeline" strip along the
// base (R9 explore verdict). Percent coordinates (0–100) drive both the pill
// `left/top` and the SVG edge `viewBox="0 0 100 100"`.
const RING_BASE = 30; // ring-1 radius: wide enough that direct neighbours don't collide
const RING_STEP = 15; // each extra hop pushes the ring out …
const RING_MAX = 47; // … but never past the viewport edge (pills are ~50% off-centre)
const VERTICAL_SQUASH = 0.9; // the viewport is wider than tall — keep rings inside it
// Percent-width one (tightened) pill needs so two ring-adjacent pills clear each
// other. A crowded ring (many nodes at one depth — e.g. 8 direct neighbours) is
// pushed outward until its chord spans at least this, so neighbours stop
// overlapping (verdict R10 "explore graph overlap"), still capped by RING_MAX.
const NODE_ARC = 20;
// RING_MAX's own comment assumed a pill is "~50% off-centre" of its percent
// anchor, but the pill is a fixed 96–140px box (GraphExplorer's pillStyle)
// centred on that anchor via translate(-50%,-50%) — at the canvas's real
// pixel width, a few *percent* of margin is nowhere near half a pill's
// *pixel* width, so a node landing near x≈3% (RING_MAX's edge) had its label
// clipped by the canvas's `overflow: hidden` (verdict r13 "explore left-edge
// labels clip", e.g. A0008/90002). Clamp the final coordinate — inset more on
// x (pill width) than y (pill height, and VERTICAL_SQUASH already tightens y).
const EDGE_INSET_X = 20;
const EDGE_INSET_Y = 12;

function clampPercent(value: number, inset: number): number {
  return Math.min(100 - inset, Math.max(inset, value));
}

// An edge's relation label sits at the edge midpoint; because node pills paint
// after the labels (later in DOM order) an opaque pill whose box covers that
// midpoint clips the label into an unreadable sliver (r15 verdict "explore graph
// node cards overlap edge labels"). A label is "occluded" when a non-endpoint
// node pill's box contains its midpoint — the caller fades those. Half-extents
// are ≈ a 120×60px pill over the ~700×460px canvas, expressed in 0–100 percent.
const PILL_HALF_X = 9;
const PILL_HALF_Y = 7;

export function edgeLabelOccluded(
  mid: { x: number; y: number },
  nodes: readonly ObjectExplorerNodeLayout[],
  endpointIds: readonly [string, string],
): boolean {
  return nodes.some(
    (n) =>
      n.id !== endpointIds[0] &&
      n.id !== endpointIds[1] &&
      Math.abs(n.x - mid.x) < PILL_HALF_X &&
      Math.abs(n.y - mid.y) < PILL_HALF_Y,
  );
}

function ringRadius(depth: number, count: number): number {
  const byDepth = RING_BASE + RING_STEP * (depth - 1);
  // chord between adjacent nodes = 2·r·sin(π/n); solve r for chord ≥ NODE_ARC.
  const byCrowd = count > 1 ? NODE_ARC / (2 * Math.sin(Math.PI / count)) : 0;
  return Math.min(RING_MAX, Math.max(byDepth, byCrowd));
}

/** Undirected BFS hop count from the focus to every reachable node. */
function graphDepths(view: ObjectExplorerView): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const edge of view.links) {
    link(edge.source_id, edge.target_id);
    link(edge.target_id, edge.source_id);
  }
  const depths = new Map<string, number>([[view.focus.id, 0]]);
  const queue: string[] = [view.focus.id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const depth = depths.get(current) ?? 0;
    for (const next of adjacency.get(current) ?? []) {
      if (!depths.has(next)) {
        depths.set(next, depth + 1);
        queue.push(next);
      }
    }
  }
  return depths;
}

export function layoutObjectExplorerNodes(view: ObjectExplorerView): ObjectExplorerNodeLayout[] {
  const layouts: ObjectExplorerNodeLayout[] = [
    { id: view.focus.id, node: view.focus, x: 50, y: 50, role: "focus" },
  ];

  const upstreamIds = new Set(view.upstream.map((relation) => relation.node.id));
  const downstreamIds = new Set(view.downstream.map((relation) => relation.node.id));
  const roleOf = (id: string): ObjectExplorerNodeLayout["role"] =>
    upstreamIds.has(id) ? "upstream" : downstreamIds.has(id) ? "downstream" : "related";

  const depths = graphDepths(view);
  const maxDepth = Math.max(0, ...depths.values());

  // Group the non-focus nodes by ring so we can spread each ring by angle.
  const rings = new Map<number, ObjectExplorerNode[]>();
  for (const node of view.nodes) {
    if (node.id === view.focus.id) continue;
    // Nodes with no path to the focus (should not occur post-reachability
    // filter) land on an outermost ring rather than the centre.
    const depth = depths.get(node.id) ?? maxDepth + 1;
    const ring = rings.get(depth);
    if (ring) ring.push(node);
    else rings.set(depth, [node]);
  }

  for (const [depth, nodes] of rings) {
    const radius = ringRadius(depth, nodes.length);
    // Stagger alternate rings by a half-step so nodes don't line up radially.
    const offset = depth % 2 === 0 ? Math.PI / nodes.length : 0;
    nodes.forEach((node, index) => {
      const angle = offset - Math.PI / 2 + (2 * Math.PI * index) / nodes.length;
      layouts.push({
        id: node.id,
        node,
        x: clampPercent(50 + radius * Math.cos(angle), EDGE_INSET_X),
        y: clampPercent(50 + radius * VERTICAL_SQUASH * Math.sin(angle), EDGE_INSET_Y),
        role: roleOf(node.id),
      });
    });
  }

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
  // Native ontology instance UUIDs share a long all-zero prefix
  // (00000000-0000-0000-0000-000000a90001), so a plain leading slice collapses
  // every node to "00000000". Drop the dashes and the leading-zero padding, then
  // take the first distinguishing hex chars — that yields a distinct token for
  // those structured ids AND leaves random v4 ids on their head slice unchanged.
  // (§4-25-⑥: derived reference token, never a fabricated business code.)
  const hex = id.replace(/-/g, "");
  const distinguishing = hex.replace(/^0+/, "") || hex;
  return distinguishing.slice(0, 8).toUpperCase();
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
