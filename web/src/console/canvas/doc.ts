// Serializable canvas doc model — nodes + edges + typed vars as plain JSON, one
// doc per screen (benchmark: config-console). Consumers persist via
// JSON.stringify and rehydrate via parseDoc (a trust-boundary guard).

import { CANVAS_NODE_KINDS, type CanvasDoc, type CanvasEdge, type CanvasNode } from "./types";

export const CANVAS_DOC_VERSION = 1 as const;

export function emptyDoc(): CanvasDoc {
  return { version: CANVAS_DOC_VERSION, nodes: [], edges: [], vars: [] };
}

/** Effective outputs of a node — branch nodes list ≥2; others = single "out". */
export function nodePorts(node: CanvasNode): string[] {
  if (node.outputs && node.outputs.length > 0) return node.outputs.map((o) => o.port);
  return ["out"];
}

function edgeExists(doc: CanvasDoc, from: string, fromPort: string | undefined, to: string): boolean {
  return doc.edges.some((e) => e.from === from && e.to === to && (e.fromPort ?? "out") === (fromPort ?? "out"));
}

/**
 * Add a connector. No self-loops, no duplicate (from,port,to), both endpoints
 * must exist, and `fromPort` must be a real port of `from`. Returns a NEW doc
 * (unchanged if the edge is invalid) so callers stay immutable.
 */
export function connect(
  doc: CanvasDoc,
  from: string,
  to: string,
  fromPort?: string,
): CanvasDoc {
  if (from === to) return doc;
  const fromNode = doc.nodes.find((n) => n.id === from);
  const toNode = doc.nodes.find((n) => n.id === to);
  if (!fromNode || !toNode) return doc;
  const port = fromPort ?? "out";
  if (!nodePorts(fromNode).includes(port)) return doc;
  if (edgeExists(doc, from, port, to)) return doc;
  const edge: CanvasEdge = {
    id: `e-${from}-${port}-${to}`,
    from,
    to,
    ...(fromPort !== undefined ? { fromPort } : {}),
  };
  return { ...doc, edges: [...doc.edges, edge] };
}

export function removeEdge(doc: CanvasDoc, edgeId: string): CanvasDoc {
  return { ...doc, edges: doc.edges.filter((e) => e.id !== edgeId) };
}

export function moveNode(doc: CanvasDoc, id: string, x: number, y: number): CanvasDoc {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) };
}

export function upsertNode(doc: CanvasDoc, node: CanvasNode): CanvasDoc {
  const exists = doc.nodes.some((n) => n.id === node.id);
  return {
    ...doc,
    nodes: exists ? doc.nodes.map((n) => (n.id === node.id ? node : n)) : [...doc.nodes, node],
  };
}

/**
 * Structural validation. Returns a list of machine-readable error codes (the
 * caller maps them to i18n copy). Branch nodes need ≥2 outputs; edges must
 * reference real nodes/ports (§1 grammar invariants).
 */
export function validateDoc(doc: CanvasDoc): string[] {
  const errors: string[] = [];
  const ids = new Set(doc.nodes.map((n) => n.id));
  for (const node of doc.nodes) {
    if (node.kind === "branch" && (node.outputs?.length ?? 0) < 2) {
      errors.push(`branch-needs-two-outputs:${node.id}`);
    }
  }
  for (const edge of doc.edges) {
    if (!ids.has(edge.from)) errors.push(`edge-missing-from:${edge.id}`);
    if (!ids.has(edge.to)) errors.push(`edge-missing-to:${edge.id}`);
    const fromNode = doc.nodes.find((n) => n.id === edge.from);
    if (fromNode && !nodePorts(fromNode).includes(edge.fromPort ?? "out")) {
      errors.push(`edge-missing-port:${edge.id}`);
    }
  }
  return errors;
}

/** Serialize is native; this exists only to pin the shape for readers. */
export function serializeDoc(doc: CanvasDoc): string {
  return JSON.stringify(doc);
}

/**
 * Rehydrate a persisted doc. Trust-boundary guard: rejects anything that is not
 * a version-1 doc with array members, so a corrupt/stale blob fails loud rather
 * than crashing a render deep in the canvas.
 */
export function parseDoc(json: string): CanvasDoc {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) throw new Error("canvas-doc: not an object");
  const rec = raw as Record<string, unknown>;
  if (rec.version !== CANVAS_DOC_VERSION) throw new Error("canvas-doc: unsupported version");
  if (!Array.isArray(rec.nodes) || !Array.isArray(rec.edges) || !Array.isArray(rec.vars)) {
    throw new Error("canvas-doc: missing nodes/edges/vars");
  }
  const validKind = (k: unknown): boolean =>
    typeof k === "string" && (CANVAS_NODE_KINDS as readonly string[]).includes(k);
  for (const node of rec.nodes as unknown[]) {
    const n = node as Record<string, unknown>;
    if (typeof n.id !== "string" || !validKind(n.kind) || typeof n.title !== "string") {
      throw new Error("canvas-doc: malformed node");
    }
  }
  return { version: CANVAS_DOC_VERSION, nodes: rec.nodes as CanvasNode[], edges: rec.edges as CanvasEdge[], vars: rec.vars as CanvasDoc["vars"] };
}
