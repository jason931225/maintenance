// Generalized from workflows/CanvasBlock.tsx — the shared node renderer for the
// canvas grammar. Tokened via the existing `--canvas-block-{kind}-*` tokens.

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { StatusChip } from "../components";
import type { CanvasStrings } from "./strings";
import { nodePorts } from "./doc";
import type { CanvasNode, CanvasNodeKind } from "./types";

type StatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

const KIND_META: Record<CanvasNodeKind, { icon: string; tone: StatusTone }> = {
  trigger: { icon: "▶", tone: "accent" },
  condition: { icon: "?", tone: "info" },
  branch: { icon: "⇄", tone: "warn" },
  action: { icon: "✓", tone: "ok" },
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  width: 260,
  padding: "var(--sp-4)",
  border: "1px solid var(--canvas-block-border)",
  borderRadius: "var(--radius-card)",
  background: "var(--canvas-block-bg)",
  boxShadow: "var(--canvas-block-shadow)",
  boxSizing: "border-box",
};

// The header is the node's dedicated select/connect-completion affordance: a
// real <button> (native Enter/Space), sibling to the port buttons — never their
// ancestor — so no interactive control is nested inside another (WCAG 4.1.2).
const headerButtonStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "24px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "var(--sp-2)",
  width: "100%",
  minHeight: 44,
  padding: 0,
  border: "none",
  background: "none",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

const iconStyle: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  width: 24,
  height: 24,
  borderRadius: "var(--radius-sm)",
  border: "1px solid currentColor",
  background: "color-mix(in srgb, currentColor 10%, transparent)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const detailStyle: CSSProperties = {
  margin: 0,
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  lineHeight: "var(--lh-base)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const portListStyle: CSSProperties = { display: "grid", gap: "var(--sp-2)" };

const portHandleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
  minHeight: 44,
  padding: "0 var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-medium)",
  cursor: "pointer",
  width: "100%",
  textAlign: "left",
};

function kindVars(kind: CanvasNodeKind): CSSProperties {
  const root = `--canvas-block-${kind}`;
  return {
    borderColor: `var(${root}-bd)`,
    background: `var(${root}-bg)`,
    color: `var(${root}-tx)`,
  };
}

export interface CanvasNodeCardProps {
  node: CanvasNode;
  strings: CanvasStrings;
  selected?: boolean;
  /** The port currently armed as a connect source (highlighted). */
  activePort?: string | null;
  /** Begin a connection from this port (pointer press or keyboard activate). */
  onPortConnect?: (port: string) => void;
  onPortPointerDown?: (port: string, event: ReactPointerEvent) => void;
  /** Select this node, or (when a connection is pending) complete it here. */
  onActivate?: () => void;
}

// A non-branch node's single output has no product-defined port name — its only
// key is the internal "out". Show a neutral flow glyph, never the raw machine
// key (verdict r13 "'out' port label"). Branch ports keep their real names
// (met/unmet, approved/rejected) since those ARE meaningful to the reader.
const IMPLICIT_OUTPUT_GLYPH = "→";

/** Which ports this node renders as connect handles. */
function handlePorts(
  node: CanvasNode,
): { port: string; label: string; implicit: boolean }[] {
  if (node.outputs && node.outputs.length > 0) {
    return node.outputs.map((o) => ({ port: o.port, label: o.label, implicit: false }));
  }
  // Non-branch kinds carry a single implicit output; branch is validated ≥2.
  return nodePorts(node).map((port) => ({
    port,
    label: IMPLICIT_OUTPUT_GLYPH,
    implicit: true,
  }));
}

export function CanvasNodeCard({
  node,
  strings,
  selected = false,
  activePort = null,
  onPortConnect,
  onPortPointerDown,
  onActivate,
}: CanvasNodeCardProps) {
  const meta = KIND_META[node.kind];
  const ports = handlePorts(node);
  const showPorts = node.kind !== "action"; // action = terminal, no outputs
  return (
    <article
      data-canvas-node-kind={node.kind}
      data-canvas-node-id={node.id}
      style={{
        ...cardStyle,
        ...kindVars(node.kind),
        ...(selected ? { outline: "2px solid var(--ink)", outlineOffset: 2 } : {}),
      }}
    >
      <button
        type="button"
        aria-label={strings.nodeAria(node.title)}
        aria-pressed={selected}
        onClick={onActivate}
        style={headerButtonStyle}
      >
        <span aria-hidden="true" style={iconStyle}>
          {meta.icon}
        </span>
        <h3 style={titleStyle}>{node.title}</h3>
        <StatusChip tone={meta.tone}>{strings.kindLabel[node.kind]}</StatusChip>
      </button>
      {node.detail ? <p style={detailStyle}>{node.detail}</p> : null}
      {node.chips && node.chips.length > 0 ? (
        <div style={chipRowStyle}>
          {node.chips.map((chip) => (
            <StatusChip key={chip} tone="neutral">
              {chip}
            </StatusChip>
          ))}
        </div>
      ) : null}
      {showPorts && ports.length > 0 ? (
        <div aria-label={strings.outputsLabel} style={portListStyle}>
          {ports.map(({ port, label, implicit }) => (
            <button
              key={port}
              type="button"
              aria-label={strings.portAria(label)}
              aria-pressed={activePort === port}
              data-canvas-port={port}
              onPointerDown={(event) => {
                event.stopPropagation();
                onPortPointerDown?.(port, event);
              }}
              onClick={(event) => {
                event.stopPropagation();
                onPortConnect?.(port);
              }}
              style={{
                ...portHandleStyle,
                ...(activePort === port
                  ? { borderColor: "var(--ink)", color: "var(--ink)" }
                  : {}),
              }}
            >
              <span>{label}</span>
              {/* The machine key chip is only informative for named branch ports;
                  for the implicit single output it would just re-print "out". */}
              {implicit ? null : (
                <StatusChip tone={activePort === port ? "accent" : "neutral"}>{port}</StatusChip>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
