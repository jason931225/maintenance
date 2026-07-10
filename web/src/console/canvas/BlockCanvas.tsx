// <BlockCanvas> — the single reusable authoring surface. Typed nodes on a
// tokened grid, 2px connector edges, branch nodes render ≥2 labeled outputs,
// drag-to-connect (pointer) with a keyboard/click-equivalent connect path.
//
// Controlled: the consumer holds the CanvasDoc and applies `onChange`. Geometry
// is model-driven (node.x/y in px, auto-column fallback) so it is deterministic
// and testable without DOM measurement.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

import { CanvasNodeCard } from "./CanvasNodeCard";
import { connect, nodePorts } from "./doc";
import type { CanvasStrings } from "./strings";
import type { CanvasDoc, CanvasNode } from "./types";

const NODE_W = 260;
const AUTO_X = 40;
const AUTO_Y0 = 32;
const AUTO_STEP = 176;
// ponytail: fixed anchor offsets, not DOM-measured — exact port geometry is a
// Phase-C polish; the model-driven estimate keeps edges deterministic + testable.
const PORT_ANCHOR_Y = 96;
const PORT_STEP = 52;
const TARGET_ANCHOR_Y = 40;

interface Pos {
  x: number;
  y: number;
}

function layout(doc: CanvasDoc): Map<string, Pos> {
  const map = new Map<string, Pos>();
  doc.nodes.forEach((node, i) => {
    map.set(node.id, {
      x: node.x ?? AUTO_X,
      y: node.y ?? AUTO_Y0 + i * AUTO_STEP,
    });
  });
  return map;
}

function portIndex(node: CanvasNode, port: string): number {
  const idx = nodePorts(node).indexOf(port);
  return idx < 0 ? 0 : idx;
}

const surfaceStyle: CSSProperties = {
  position: "relative",
  minHeight: 320,
  overflow: "auto",
  padding: "var(--sp-4)",
  border: "1px solid var(--canvas-grid-bd)",
  borderRadius: "var(--radius-card)",
  background: "var(--canvas-grid-bg)",
  backgroundSize: "24px 24px",
};

const emptyStyle: CSSProperties = {
  display: "grid",
  placeItems: "center",
  minHeight: 240,
  color: "var(--faint)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
};

const svgStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
  overflow: "visible",
};

export interface BlockCanvasProps {
  doc: CanvasDoc;
  strings: CanvasStrings;
  /** Applied when an edge is drawn. Omit for a read-only canvas. */
  onChange?: (doc: CanvasDoc) => void;
  selectedId?: string | null;
  onSelectNode?: (id: string) => void;
}

interface Pending {
  from: string;
  port: string;
}

export function BlockCanvas({ doc, strings, onChange, selectedId = null, onSelectNode }: BlockCanvasProps) {
  const positions = layout(doc);
  const [pending, setPending] = useState<Pending | null>(null);
  const [cursor, setCursor] = useState<Pos | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const clearPending = useCallback(() => {
    setPending(null);
    setCursor(null);
  }, []);

  const complete = useCallback(
    (targetId: string) => {
      if (!pending || pending.from === targetId) {
        clearPending();
        return;
      }
      onChange?.(connect(doc, pending.from, targetId, pending.port));
      clearPending();
    },
    [pending, doc, onChange, clearPending],
  );

  // Global pointer tracking for the drag-to-connect temp line + drop.
  useEffect(() => {
    if (!pending) return;
    const onMove = (event: PointerEvent) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    const onUp = (event: PointerEvent) => {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const host = el?.closest<HTMLElement>("[data-canvas-node-id]");
      const targetId = host?.dataset.canvasNodeId;
      if (targetId) complete(targetId);
      else clearPending();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [pending, complete, clearPending]);

  const beginConnect = useCallback((from: string, port: string) => {
    setPending({ from, port });
  }, []);

  const onSurfaceKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Escape" && pending) {
        event.preventDefault();
        clearPending();
      }
    },
    [pending, clearPending],
  );

  return (
    <div
      ref={surfaceRef}
      role="group"
      aria-label={strings.canvasLabel}
      onKeyDown={onSurfaceKeyDown}
      style={surfaceStyle}
    >
      {doc.nodes.length === 0 ? <div style={emptyStyle}>{strings.emptyCanvas}</div> : null}

      <svg style={svgStyle} aria-hidden="true">
        {doc.edges.map((edge) => {
          const fromNode = doc.nodes.find((n) => n.id === edge.from);
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!fromNode || !from || !to) return null;
          const pi = portIndex(fromNode, edge.fromPort ?? "out");
          const x1 = from.x + NODE_W;
          const y1 = from.y + PORT_ANCHOR_Y + pi * PORT_STEP;
          const x2 = to.x;
          const y2 = to.y + TARGET_ANCHOR_Y;
          return (
            <line
              key={edge.id}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--canvas-link)"
              strokeWidth={2}
            />
          );
        })}
        {pending && cursor
          ? (() => {
              const from = positions.get(pending.from);
              const fromNode = doc.nodes.find((n) => n.id === pending.from);
              if (!from || !fromNode) return null;
              const pi = portIndex(fromNode, pending.port);
              return (
                <line
                  x1={from.x + NODE_W}
                  y1={from.y + PORT_ANCHOR_Y + pi * PORT_STEP}
                  x2={cursor.x}
                  y2={cursor.y}
                  stroke="var(--signal)"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                />
              );
            })()
          : null}
      </svg>

      {doc.nodes.map((node) => {
        const pos = positions.get(node.id) ?? { x: AUTO_X, y: AUTO_Y0 };
        return (
          <div
            key={node.id}
            style={{ position: "absolute", left: pos.x, top: pos.y, width: NODE_W }}
          >
            <CanvasNodeCard
              node={node}
              strings={strings}
              selected={selectedId === node.id}
              activePort={pending?.from === node.id ? pending.port : null}
              // The card's header button selects, or completes a pending
              // connection here (native Enter/Space); complete() no-ops a self-drop.
              onActivate={() => {
                if (pending) complete(node.id);
                else onSelectNode?.(node.id);
              }}
              onPortConnect={(port) => {
                beginConnect(node.id, port);
              }}
              onPortPointerDown={(port) => {
                beginConnect(node.id, port);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
