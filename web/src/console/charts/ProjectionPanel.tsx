import type { CSSProperties } from "react";
import type { components } from "@maintenance/api-client-ts";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import "../tokens.css";
import { formatWon, HonestSpark, type ChartFormat } from "./HonestMarks";
import { DEFAULT_LAMBDA, project } from "./projection";

const T = ko.console.charts;

export type ProjectionDrillPart = "point" | "ci95" | "cvar95" | "sample";

/** Backend Monte-Carlo/EVT result (POST /api/v1/analytics/projection, HANDOFF §18). */
export type BackendProjection = components["schemas"]["ProjectionResult"];

export interface ProjectionPanelProps {
  /** Field name the projection is over, e.g. 월 정비비. */
  title: string;
  /** §4-19 typed field: controls formatting. */
  kind: "money" | "percent";
  /** The real historical series (drives the spark and, when no backend result is
   *  supplied, the deterministic client-side estimate below). */
  sample: number[];
  /**
   * Backend Monte-Carlo/EVT projection over `sample` (HANDOFF §18, wired via
   * POST /api/v1/analytics/projection). When present it is the source of truth
   * for point/CI95/CVaR95; when absent (in-flight, denied, or a non-money/percent
   * field the endpoint doesn't serve) the panel falls back to the deterministic
   * client `project()` math over `sample` — same shape, no fabrication.
   */
  backendResult?: BackendProjection;
  lambda?: number;
  onDrill: (part: ProjectionDrillPart) => void;
  /** §4-22 in-place add path for the underlying sample. */
  onAddSample?: () => void;
  /**
   * Optional formatter override for fields that are neither money nor percent
   * (e.g. a monthly completed-count series). Falls back to the money/percent
   * formatter chosen by `kind` when omitted.
   */
  format?: ChartFormat;
}

/** Unified render shape derived from either the backend result or client math. */
interface ProjectionView {
  point: number;
  ci95: readonly [number, number];
  cvar95: number;
  n: number;
  ewmaAssumption: string;
  distributionAssumption: string;
}

function toView(
  backendResult: BackendProjection | undefined,
  sample: number[],
  lambda: number,
): ProjectionView | null {
  if (backendResult) {
    return {
      point: backendResult.point_estimate,
      ci95: [backendResult.ci95_low, backendResult.ci95_high],
      cvar95: backendResult.cvar95,
      n: sample.filter((v) => Number.isFinite(v)).length,
      ewmaAssumption: T.projection.assumptionEwmaVolatility(
        String(backendResult.assumptions.ewma_volatility),
      ),
      distributionAssumption: T.projection.assumptionStudentT(
        backendResult.assumptions.student_t_nu,
      ),
    };
  }
  const p = project(sample, lambda);
  return p
    ? {
        point: p.point,
        ci95: p.ci95,
        cvar95: p.cvar95,
        n: p.n,
        ewmaAssumption: T.projection.assumptionEwma(String(p.lambda)),
        distributionAssumption: T.projection.assumptionDist,
      }
    : null;
}

const formatPercent: ChartFormat = (value) => `${value.toFixed(1)}%`;

const statButtonStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  minHeight: 44,
  padding: "var(--sp-2) var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  textAlign: "left",
  cursor: "pointer",
};

const statLabelStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
  color: "var(--steel)",
};

const statValueStyle: CSSProperties = {
  fontSize: "var(--text-value)",
  fontWeight: "var(--fw-strong)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

/**
 * DESIGN change-log (68) 정량 투영: deterministic point estimate + CI95 band
 * + CVaR95 fat-tail over a money/percent field. Every number drills (§4.7-9).
 */
export function ProjectionPanel({ title, kind, sample, backendResult, lambda = DEFAULT_LAMBDA, onDrill, onAddSample, format: formatOverride }: ProjectionPanelProps) {
  const format = formatOverride ?? (kind === "money" ? formatWon : formatPercent);
  const p = toView(backendResult, sample, lambda);

  return (
    <section
      aria-label={T.projection.title(title)}
      style={{
        display: "grid",
        gap: "var(--sp-4)",
        padding: "var(--sp-5)",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-2)" }}>
        <h3
          style={{
            margin: 0,
            fontSize: "var(--text-card-title)",
            fontWeight: "var(--fw-strong)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          {T.projection.title(title)}
        </h3>
        {p ? (
          <span style={{ display: "inline-flex", gap: "var(--sp-1)", flexWrap: "wrap" }}>
            <StatusChip>{p.ewmaAssumption}</StatusChip>
            <StatusChip>{p.distributionAssumption}</StatusChip>
            <StatusChip>{T.projection.assumptionN(p.n)}</StatusChip>
          </span>
        ) : null}
      </header>

      {p ? (
        <>
          <ProjectionBand projection={p} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--sp-2)" }}>
            <button
              type="button"
              data-window-control="true"
              aria-label={T.drill(T.projection.point, format(p.point))}
              onClick={() => {
                onDrill("point");
              }}
              style={statButtonStyle}
            >
              <span style={statLabelStyle}>{T.projection.point}</span>
              <span style={{ ...statValueStyle, fontSize: "var(--text-value-lg)" }}>{format(p.point)}</span>
            </button>
            <button
              type="button"
              data-window-control="true"
              aria-label={T.drill(T.projection.ci95, `${format(p.ci95[0])} – ${format(p.ci95[1])}`)}
              onClick={() => {
                onDrill("ci95");
              }}
              style={statButtonStyle}
            >
              <span style={statLabelStyle}>{T.projection.ci95}</span>
              <span style={statValueStyle}>{`${format(p.ci95[0])} – ${format(p.ci95[1])}`}</span>
            </button>
            <button
              type="button"
              data-window-control="true"
              aria-label={T.drill(T.projection.cvar95, format(p.cvar95))}
              onClick={() => {
                onDrill("cvar95");
              }}
              style={{ ...statButtonStyle, borderColor: "var(--danger-bd)", background: "var(--danger-bg)" }}
            >
              <span style={{ ...statLabelStyle, color: "var(--danger-tx)" }}>{T.projection.cvar95}</span>
              <span style={{ ...statValueStyle, color: "var(--danger-tx)" }}>{format(p.cvar95)}</span>
            </button>
          </div>
          <HonestSpark
            label={title}
            values={sample}
            format={format}
            onDrill={() => {
              onDrill("sample");
            }}
          />
        </>
      ) : (
        <StatusChip tone="warn" role="status">
          {T.projection.insufficient}
        </StatusChip>
      )}

      {onAddSample ? (
        <button
          type="button"
          data-window-control="true"
          onClick={onAddSample}
          style={{ ...statButtonStyle, minHeight: 44, justifyItems: "start", color: "var(--steel)" }}
        >
          {T.projection.addSample}
        </button>
      ) : null}
    </section>
  );
}

/** CI95 band with point and CVaR95 ticks on a shared horizontal axis. */
function ProjectionBand({ projection }: { projection: ProjectionView }) {
  const lo = Math.min(projection.cvar95, projection.ci95[0]);
  const hi = projection.ci95[1];
  const span = hi - lo;
  const pos = (v: number) => (span <= 0 ? 50 : ((v - lo) / span) * 100);
  const pct = (v: number) => `${pos(v).toFixed(2)}%`;
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        display: "block",
        height: 12,
        background: "var(--muted)",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--radius-pill)",
      }}
    >
      <span
        style={{
          position: "absolute",
          insetBlock: 1,
          left: pct(projection.ci95[0]),
          width: `${Math.max(pos(projection.ci95[1]) - pos(projection.ci95[0]), 1).toFixed(2)}%`,
          background: "var(--info-bd)",
          borderRadius: "var(--radius-pill)",
          opacity: 0.6,
        }}
      />
      <span
        style={{
          position: "absolute",
          insetBlock: -2,
          left: pct(projection.point),
          width: 2,
          background: "var(--ink)",
        }}
      />
      <span
        style={{
          position: "absolute",
          insetBlock: -2,
          left: pct(projection.cvar95),
          width: 2,
          background: "var(--danger-solid)",
        }}
      />
    </span>
  );
}
