// Simulation-panel shell — runs the predicate set over a seed sample and shows
// pass/total. This is REAL eval (runSimulation over the samples), not a
// decorative toast (DESIGN §4-20). Seed samples are stubbed (wire-pending Phase C).

import { useState } from "react";
import type { CSSProperties } from "react";

import { StatusChip } from "../components";
import { runSimulation, type SimulationResult } from "./predicate";
import type { CanvasStrings } from "./strings";
import type { FieldRegistry, PredicateGroup, SampleRow } from "./types";

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const labelStyle: CSSProperties = {
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
};

const runButtonStyle: CSSProperties = {
  minHeight: 44,
  padding: "0 var(--sp-5)",
  border: "1px solid var(--signal)",
  borderRadius: "var(--radius-sm)",
  background: "var(--signal)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const resultRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

function resultTone(result: SimulationResult): "ok" | "warn" | "danger" {
  if (result.total > 0 && result.pass === result.total) return "ok";
  if (result.pass === 0) return "danger";
  return "warn";
}

export interface SimulationPanelProps {
  group: PredicateGroup;
  registry: FieldRegistry;
  strings: CanvasStrings;
  /** Seed sample rows. wire-pending: Phase C swaps in a real object-set. */
  samples: readonly SampleRow[];
}

export function SimulationPanel({ group, registry, strings, samples }: SimulationPanelProps) {
  const [result, setResult] = useState<SimulationResult | null>(null);

  return (
    <div style={rootStyle}>
      <div style={headerStyle}>
        <span style={labelStyle}>{strings.simulateLabel}</span>
        <button
          type="button"
          style={runButtonStyle}
          onClick={() => {
            setResult(runSimulation(group, samples, registry));
          }}
        >
          {strings.runSimulation}
        </button>
      </div>
      <div style={resultRowStyle}>
        <StatusChip tone="neutral">{`${strings.samplesLabel} ${String(samples.length)}`}</StatusChip>
        {result ? (
          <StatusChip tone={resultTone(result)} role="status">
            {strings.simulationResult(result.pass, result.total)}
          </StatusChip>
        ) : null}
      </div>
    </div>
  );
}
