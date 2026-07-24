import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { ko } from "../../../i18n/ko";
import { StatusChip } from "../../components";
import {
  buildObjectExplorerView,
  edgeLabelOccluded,
  layoutObjectExplorerNodes,
  type ObjectExplorerModel,
  type ObjectExplorerNode,
} from "../../explore";
import { ObjectCard } from "../../objectcard";
import { GovernedObjectCard } from "../../objectcard";
import type { ConsoleApiClient } from "../../../api/client";
import type {
  ObjectCardDescriptor,
  ObjectCardHandlers,
  ObjectCardLifecycleStep,
  ObjectLifecycleState,
} from "../../objectcard";
import { objDrag } from "../../window";
import "../../tokens.css";

const T = ko.console.explore;
const G = ko.console.explore.graph;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

// ponytail: fixed accessible categorical palette hashed by type — a token-driven
// palette is a design-system follow-up; this keeps legend/node dots deterministic.
const TYPE_PALETTE = [
  "#e2a30d",
  "#0f766e",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#0891b2",
  "#65a30d",
  "#dc2626",
];

function typeColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return TYPE_PALETTE[Math.abs(hash) % TYPE_PALETTE.length];
}

// Explorer lifecycle phase → ObjectCard instance FSM (mirrors ObjectExplorerScreen:
// review/undefined ⇒ active, revision ⇒ locked). Kept local so the graph pane owns
// its own honest degrade path without reaching into the screen module.
function cardLifecycleState(node: ObjectExplorerNode): ObjectLifecycleState {
  switch (node.lifecycle?.phase) {
    case "draft":
      return "draft";
    case "revision":
      return "locked";
    case "archived":
      return "archived";
    case "disposed":
      return "disposed";
    default:
      return "active";
  }
}

function lifecycleSteps(state: ObjectLifecycleState): ObjectCardLifecycleStep[] {
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

// Degraded inspector payload built from the node's own graph fields — no
// fabricated properties/relations/actions/history. Used before a resolve, and
// as the honest fallback for projected instances (S23: not get/traverse-able)
// and for any resolve failure. The graph pane itself carries UPSTREAM/DOWNSTREAM.
function degradedDescriptor(node: ObjectExplorerNode): ObjectCardDescriptor {
  const state = cardLifecycleState(node);
  return {
    id: node.id,
    code: node.code,
    title: node.label,
    objectType: { key: node.type_id ?? node.type, title: node.type },
    lifecycleState: state,
    properties: [],
    relations: [],
    lifecycle: lifecycleSteps(state),
    history: [],
    actions: [],
  };
}

const wrapStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 380px)",
  gap: "var(--sp-4)",
  alignItems: "start",
};

const viewportStyle: CSSProperties = {
  position: "relative",
  minHeight: 600,
  overflow: "hidden",
  border: "1px solid var(--canvas-grid-bd)",
  borderRadius: "var(--radius-card)",
  background: "var(--canvas-grid-bg)",
  touchAction: "none",
};

const bgCatcherStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  cursor: "grab",
};

const edgeLayerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
  overflow: "visible",
};

const edgeLabelStyle: CSSProperties = {
  position: "absolute",
  transform: "translate(-50%, -50%)",
  padding: "1px var(--sp-2)",
  borderRadius: "var(--radius-pill)",
  border: "1px solid var(--border-soft)",
  background: "var(--surface)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

const nodeButtonStyle: CSSProperties = {
  position: "absolute",
  transform: "translate(-50%, -50%)",
  border: 0,
  padding: 0,
  background: "transparent",
  cursor: "pointer",
  pointerEvents: "auto",
};

const pillStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  // Tighter footprint (verdict R10 "explore graph overlap"): the radial layout
  // packs ~19 nodes, so a narrower pill clears more angular space between
  // neighbours; the label already ellipsis-truncates, so less width ≠ lost text.
  minWidth: 96,
  maxWidth: 140,
  padding: "var(--sp-1) var(--sp-2)",
  borderRadius: "var(--radius-card)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  boxShadow: "var(--canvas-block-shadow)",
  color: "var(--ink)",
  textAlign: "left",
};

const focusPillStyle: CSSProperties = {
  ...pillStyle,
  borderColor: "var(--signal)",
  background: "var(--accent-bg)",
};

const selectedPillStyle: CSSProperties = {
  ...pillStyle,
  borderColor: "var(--signal-deep)",
  boxShadow: "0 0 0 2px var(--signal)",
};

const pillHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const dotStyle = (color: string): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: "var(--radius-pill)",
  background: color,
  flex: "0 0 auto",
});

const monoStyle: CSSProperties = {
  color: "var(--faint)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const nodeLabelStyle: CSSProperties = {
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const zoomOverlayStyle: CSSProperties = {
  position: "absolute",
  insetBlockStart: "var(--sp-3)",
  insetInlineEnd: "var(--sp-3)",
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  padding: "var(--sp-1) var(--sp-2)",
  borderRadius: "var(--radius-pill)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const zoomButtonStyle: CSSProperties = {
  minWidth: 32,
  minHeight: 32,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const zoomLevelStyle: CSSProperties = {
  minWidth: 44,
  textAlign: "center",
  color: "var(--ink)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  fontVariantNumeric: "tabular-nums",
};

const legendOverlayStyle: CSSProperties = {
  position: "absolute",
  insetBlockEnd: "var(--sp-3)",
  insetInlineStart: "var(--sp-3)",
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
  maxWidth: "72%",
  padding: "var(--sp-2) var(--sp-3)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const legendTitleStyle: CSSProperties = {
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
};

const legendItemStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--sp-1)",
  color: "var(--ink)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-medium)",
};

const inspectorStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  overflow: "hidden",
};

const projectedBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--warn-bd)",
  background: "var(--warn-bg)",
  color: "var(--warn-tx)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

const relationListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  margin: 0,
  padding: "var(--sp-3) var(--sp-4)",
  listStyle: "none",
  borderTop: "1px solid var(--border-soft)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
};

interface LegendEntry {
  key: string;
  title: string;
  color: string;
  count: number;
}

export interface GraphExplorerProps {
  /** Enables the governed preflight → execute card for real workspace reads. */
  api?: ConsoleApiClient;
  model: ObjectExplorerModel;
  /** Parent hook loads the search-around neighbourhood for the new center. */
  onFocusChange?: (id: string) => void;
  /** Host-selected exact instance to focus after its governed graph is present. */
  requestedFocusId?: string;
  /**
   * GET /ontology/instances/{id} (+history/traverse) → the full inspector card.
   * Throws/404s for projected instances (S23) and transient failures → the pane
   * degrades to the node's graph fields, never fabricates.
   */
  resolveNodeDescriptor?: (node: ObjectExplorerNode) => Promise<ObjectCardDescriptor | undefined>;
  /** Object-type *version* ids whose backing_kind is projected (honest 조회 전용). */
  projectedTypeIds?: ReadonlySet<string>;
  /** Optional inspector action/lifecycle wiring (read-only explore omits it). */
  cardHandlers?: ObjectCardHandlers;
}

/**
 * The object-graph explorer: a typed node graph (code chips, type-coloured dots,
 * relation-labelled edges, zoom/pan, 범례 legend) beside a docked ObjectCard
 * inspector. Clicking a node recenters the graph AND selects it (drill =
 * navigate); the inspector resolves the full 3-layer card, degrading honestly
 * for projected instances. Pure model layer (buildObjectExplorerView +
 * layoutObjectExplorerNodes) is reused; only the rendering is new.
 */
export function GraphExplorer({
  api,
  model,
  onFocusChange,
  requestedFocusId,
  resolveNodeDescriptor,
  projectedTypeIds,
  cardHandlers,
}: GraphExplorerProps) {
  const [focusId, setFocusId] = useState<string | undefined>(model.nodes[0]?.id);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [resolved, setResolved] = useState<Map<string, ObjectCardDescriptor>>(new Map());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [cardRefreshEpoch, setCardRefreshEpoch] = useState(0);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 960,
  );
  const panDrag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const nodeButtons = useRef(new Map<string, HTMLButtonElement>());
  const resolverEpochRef = useRef(0);
  useEffect(() => {
    resolverEpochRef.current += 1;
  }, [resolveNodeDescriptor]);
  useEffect(() => {
    const onResize = () => {
      setNarrow(window.innerWidth < 960);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);
  const requestedNode = useMemo(
    () => model.nodes.find((node) => node.id === requestedFocusId),
    [model.nodes, requestedFocusId],
  );
  const effectiveFocusId = requestedNode?.id ?? focusId;
  const effectiveSelectedId = requestedNode?.id ?? selectedId;

  const view = useMemo(
    () =>
      model.nodes.length > 0
        ? buildObjectExplorerView(model, effectiveFocusId)
        : undefined,
    [effectiveFocusId, model],
  );
  const layout = useMemo(() => (view ? layoutObjectExplorerNodes(view) : []), [view]);
  const posById = useMemo(
    () => new Map(layout.map((entry) => [entry.id, { x: entry.x, y: entry.y }])),
    [layout],
  );

  const isProjected = useCallback(
    (node: ObjectExplorerNode | undefined): boolean =>
      node?.type_id !== undefined && (projectedTypeIds?.has(node.type_id) ?? false),
    [projectedTypeIds],
  );

  const resolve = useCallback(
    (node: ObjectExplorerNode, force = false): void => {
      if (!resolveNodeDescriptor || isProjected(node)) return;
      if (!force && (resolved.has(node.id) || failed.has(node.id))) return;
      const resolverEpoch = resolverEpochRef.current;
      void resolveNodeDescriptor(node)
        .then((descriptor) => {
          if (!descriptor || resolverEpoch !== resolverEpochRef.current) return;
          setResolved((current) => new Map(current).set(node.id, descriptor));
        })
        .catch(() => {
          if (resolverEpoch !== resolverEpochRef.current) return;
          setFailed((current) => new Set(current).add(node.id));
        });
    },
    [resolveNodeDescriptor, isProjected, resolved, failed],
  );

  // Resolve the currently-selected node (the focus on first mount) so the docked
  // inspector opens with its real relations/properties instead of the degraded
  // 관계 0개 card — the summary already claims the relation count, so the card
  // must not read empty before the user clicks. Guarded (projected/resolved/
  // failed) inside `resolve`, so this is a no-op once a node is loaded.
  useEffect(() => {
    if (!view) return;
    const target =
      view.nodes.find(
        (node) => node.id === (effectiveSelectedId ?? effectiveFocusId),
      ) ?? view.focus;
    resolve(target);
  }, [effectiveFocusId, effectiveSelectedId, resolve, view]);

  const onNodeActivate = useCallback(
    (node: ObjectExplorerNode): void => {
      setSelectedId(node.id);
      if (node.id !== effectiveFocusId) {
        setFocusId(node.id);
        onFocusChange?.(node.id);
      }
      resolve(node);
    },
    [effectiveFocusId, onFocusChange, resolve],
  );

  const onNodeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, node: ObjectExplorerNode) => {
      if (!view || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const index = view.nodes.findIndex((candidate) => candidate.id === node.id);
      const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
      const next = view.nodes[(index + direction + view.nodes.length) % view.nodes.length];
      onNodeActivate(next);
      nodeButtons.current.get(next.id)?.focus();
    },
    [onNodeActivate, view],
  );

  const legend = useMemo<LegendEntry[]>(() => {
    if (!view) return [];
    const byKey = new Map<string, LegendEntry>();
    for (const node of view.nodes) {
      const key = node.type_id ?? node.type;
      const entry = byKey.get(key);
      if (entry) entry.count += 1;
      else byKey.set(key, { key, title: node.type, color: typeColor(key), count: 1 });
    }
    return [...byKey.values()];
  }, [view]);

  if (!view) return null;

  const selectedNode =
    view.nodes.find((node) => node.id === effectiveSelectedId) ?? view.focus;
  const descriptor = resolved.get(selectedNode.id) ?? degradedDescriptor(selectedNode);
  const showProjected = isProjected(selectedNode);
  const zoomPct = Math.round(scale * 100);

  function refreshSelectedCard(): void {
    // Keep the committed card mounted while the server-fresh descriptor resolves;
    // its receipt and local history must remain visible through this refresh.
    setCardRefreshEpoch((current) => current + 1);
    setFailed((current) => {
      const next = new Set(current);
      next.delete(selectedNode.id);
      return next;
    });
    onFocusChange?.(selectedNode.id);
    resolve(selectedNode, true);
  }

  function zoomBy(delta: number): void {
    setScale((current) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((current + delta) * 10) / 10)));
  }

  function onPanDown(event: ReactPointerEvent<HTMLDivElement>): void {
    panDrag.current = { px: event.clientX, py: event.clientY, ox: pan.x, oy: pan.y };
    const move = (e: PointerEvent): void => {
      const drag = panDrag.current;
      if (!drag) return;
      setPan({ x: drag.ox + (e.clientX - drag.px), y: drag.oy + (e.clientY - drag.py) });
    };
    const up = (): void => {
      panDrag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <section
      aria-label={G.pane}
      style={{
        ...wrapStyle,
        gridTemplateColumns: narrow ? "minmax(0, 1fr)" : wrapStyle.gridTemplateColumns,
      }}
    >
      <div style={viewportStyle}>
        <div style={bgCatcherStyle} onPointerDown={onPanDown} aria-hidden="true" />

        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(scale)})`,
            transformOrigin: "center center",
            pointerEvents: "none",
          }}
        >
          <svg style={edgeLayerStyle} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {view.links.map((link) => {
              const from = posById.get(link.source_id);
              const to = posById.get(link.target_id);
              if (!from || !to) return null;
              return (
                <line
                  key={link.id}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="var(--canvas-link)"
                  strokeWidth={0.5}
                  strokeLinecap="round"
                />
              );
            })}
          </svg>

          {view.links.map((link) => {
            const from = posById.get(link.source_id);
            const to = posById.get(link.target_id);
            if (!from || !to) return null;
            const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
            // Fade a label a non-endpoint pill paints over — a half-clipped
            // sliver reads worse than a de-emphasized one (r15 explore verdict).
            const occluded = edgeLabelOccluded(mid, layout, [link.source_id, link.target_id]);
            return (
              <span
                key={`label-${link.id}`}
                aria-hidden="true"
                style={{ ...edgeLabelStyle, left: `${String(mid.x)}%`, top: `${String(mid.y)}%`, opacity: occluded ? 0.3 : 1 }}
              >
                {link.relation}
              </span>
            );
          })}

          {layout.map(({ id, node, x, y, role }) => {
            const key = node.type_id ?? node.type;
            const style =
              node.id === selectedNode.id
                ? selectedPillStyle
                : role === "focus"
                  ? focusPillStyle
                  : pillStyle;
            return (
              <button
                key={id}
                type="button"
                aria-label={T.actions.recenter(node.label)}
                aria-current={role === "focus" ? "true" : undefined}
                ref={(element) => {
                  if (element) nodeButtons.current.set(node.id, element);
                  else nodeButtons.current.delete(node.id);
                }}
                onClick={() => {
                  onNodeActivate(node);
                }}
                onKeyDown={(event) => {
                  onNodeKeyDown(event, node);
                }}
                style={{ ...nodeButtonStyle, left: `${String(x)}%`, top: `${String(y)}%` }}
                {...objDrag(node.code, node.label)}
                title={ko.console.window.dragRefOf(node.label)}
              >
                <span style={style}>
                  <span style={pillHeadStyle}>
                    <span aria-hidden="true" style={dotStyle(typeColor(key))} />
                    <span style={monoStyle}>{node.code}</span>
                    {isProjected(node) ? <StatusChip tone="warn">{G.projectedChip}</StatusChip> : null}
                  </span>
                  <span style={nodeLabelStyle}>{node.label}</span>
                  {node.lifecycle ? (
                    <StatusChip tone="neutral">{T.lifecycle[node.lifecycle.phase]}</StatusChip>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        <div role="group" aria-label={G.zoomLabel} style={zoomOverlayStyle}>
          <button type="button" aria-label={G.zoomOut} onClick={() => { zoomBy(-ZOOM_STEP); }} style={zoomButtonStyle}>
            −
          </button>
          <span style={zoomLevelStyle}>{G.zoomLevel(zoomPct)}</span>
          <button type="button" aria-label={G.zoomIn} onClick={() => { zoomBy(ZOOM_STEP); }} style={zoomButtonStyle}>
            +
          </button>
          <button type="button" aria-label={G.zoomReset} onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }} style={zoomButtonStyle}>
            ⤢
          </button>
        </div>

        <div role="group" aria-label={G.legend} style={legendOverlayStyle}>
          <span style={legendTitleStyle}>{G.legend}</span>
          <StatusChip tone="neutral">{G.legendCount(legend.length)}</StatusChip>
          {legend.map((entry) => (
            <span key={entry.key} style={legendItemStyle}>
              <span aria-hidden="true" style={dotStyle(entry.color)} />
              {entry.title}
              <StatusChip tone="neutral">{T.labels.objectCount(entry.count)}</StatusChip>
            </span>
          ))}
        </div>
      </div>

      <aside aria-label={ko.console.objectcard.panel(selectedNode.label)} style={inspectorStyle}>
        {showProjected ? (
          <div role="status" style={projectedBannerStyle}>
            <StatusChip tone="warn">{G.projectedChip}</StatusChip>
            {G.projectedNotice}
          </div>
        ) : null}
        {api && !showProjected ? (
          <GovernedObjectCard
            api={api}
            descriptor={descriptor}
            handlers={cardHandlers}
            onInstanceChange={refreshSelectedCard}
            refreshEpoch={cardRefreshEpoch}
          />
        ) : (
          <ObjectCard descriptor={descriptor} handlers={cardHandlers} />
        )}
        <ul aria-label={G.relationList} style={relationListStyle}>
          {view.links.map((link) => {
            const from = view.nodes.find((node) => node.id === link.source_id);
            const to = view.nodes.find((node) => node.id === link.target_id);
            if (!from || !to) return null;
            return <li key={link.id}>{`${from.label} ${link.relation} ${to.label}`}</li>;
          })}
        </ul>
      </aside>
    </section>
  );
}
