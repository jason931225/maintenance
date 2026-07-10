import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import type { WorkflowBlockKind, WorkflowCanvasBlock } from "./types";

const T = ko.console.workflows.canvas;

type StatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

const BLOCK_CONFIG: Record<
  WorkflowBlockKind,
  { icon: string; tone: StatusTone; minHeight: number }
> = {
  trigger: { icon: "▶", tone: "accent", minHeight: 64 },
  condition: { icon: "?", tone: "info", minHeight: 72 },
  branch: { icon: "⇄", tone: "warn", minHeight: 72 },
  action: { icon: "✓", tone: "ok", minHeight: 64 },
};

const blockStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  width: "min(100%, 260px)",
  minWidth: 220,
  padding: "var(--sp-4)",
  border: "1px solid var(--canvas-block-border)",
  borderRadius: "var(--radius-card)",
  background: "var(--canvas-block-bg)",
  boxShadow: "var(--canvas-block-shadow)",
};

const blockHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "24px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "var(--sp-2)",
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

const blockTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const blockDetailStyle: CSSProperties = {
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

const outputListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
};

const outputStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
  padding: "var(--sp-2)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-medium)",
};

function kindVars(kind: WorkflowBlockKind): CSSProperties {
  const tokenRoot = `--canvas-block-${kind}`;
  return {
    borderColor: `var(${tokenRoot}-bd)`,
    background: `var(${tokenRoot}-bg)`,
    color: `var(${tokenRoot}-tx)`,
  };
}

export function CanvasBlock({ block }: { block: WorkflowCanvasBlock }) {
  const config = BLOCK_CONFIG[block.kind];
  return (
    <article
      aria-label={T.blockAria(block.title)}
      data-workflow-block-kind={block.kind}
      style={{ ...blockStyle, minHeight: config.minHeight, ...kindVars(block.kind) }}
    >
      <div style={blockHeaderStyle}>
        <span aria-hidden="true" style={iconStyle}>
          {config.icon}
        </span>
        <h3 style={blockTitleStyle}>{block.title}</h3>
        <StatusChip tone={config.tone}>{T.blockKind[block.kind]}</StatusChip>
      </div>
      {block.detail ? <p style={blockDetailStyle}>{block.detail}</p> : null}
      {block.outputs && block.outputs.length > 0 ? (
        <div aria-label={T.outputs} style={outputListStyle}>
          {block.outputs.map((output) => (
            <div key={`${output.port ?? output.label}:${output.label}`} style={outputStyle}>
              <span>{output.label}</span>
              {output.port ? <StatusChip tone="neutral">{output.port}</StatusChip> : null}
            </div>
          ))}
        </div>
      ) : null}
      {block.chips && block.chips.length > 0 ? (
        <div style={chipRowStyle}>
          {block.chips.map((chip) => (
            <StatusChip key={chip} tone="neutral">
              {chip}
            </StatusChip>
          ))}
        </div>
      ) : null}
    </article>
  );
}
