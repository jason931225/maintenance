/* eslint-disable react-refresh/only-export-components */
import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import "../tokens.css";
import { honestScale } from "./honestScale";

const T = ko.console.charts;

export type ChartFormat = (value: number) => string;

const wonNumber = new Intl.NumberFormat("ko-KR");

/** Default: won amounts, matching the §4-24 chip example "기준 ₩x". */
export const formatWon: ChartFormat = (value) => `₩${wonNumber.format(Math.round(value))}`;

export interface ChartDatum {
  id: string;
  label: string;
  value: number;
}

/**
 * §4-24 mandatory warn chip for any truncated axis. Exported so console
 * charts that draw their own marks still route through the same chip.
 */
export function AxisTruncationChip({ baseline, format = formatWon }: { baseline: number; format?: ChartFormat }) {
  return (
    <StatusChip tone="warn" role="status">
      {T.truncated(format(baseline))}
    </StatusChip>
  );
}

const rowButtonStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(72px, 1fr) minmax(80px, 2fr) auto",
  alignItems: "center",
  gap: "var(--sp-3)",
  minHeight: 44,
  padding: "0 var(--sp-2)",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-body)",
  textAlign: "left",
  cursor: "pointer",
  width: "100%",
};

const trackStyle: CSSProperties = {
  position: "relative",
  display: "block",
  height: 10,
  background: "var(--muted)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-pill)",
  overflow: "hidden",
};

const valueStyle: CSSProperties = {
  fontSize: "var(--text-value)",
  fontWeight: "var(--fw-strong)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

/**
 * Horizontal bar list on an honest scale (§4-24). Every row drills (§4.7-9);
 * optional onAdd keeps the §4-22 in-place add path.
 */
export function HonestBar({
  label,
  data,
  format = formatWon,
  onDrill,
  onAdd,
}: {
  label: string;
  data: ChartDatum[];
  format?: ChartFormat;
  onDrill: (id: string) => void;
  onAdd?: () => void;
}) {
  const scale = honestScale(data.map((d) => d.value));
  return (
    <div role="group" aria-label={label} style={{ display: "grid", gap: "var(--sp-1)" }}>
      {scale.truncated ? <AxisTruncationChip baseline={scale.min} format={format} /> : null}
      {data.map((d) => (
        <button
          key={d.id}
          type="button"
          data-window-control="true"
          aria-label={T.drill(d.label, format(d.value))}
          onClick={() => {
            onDrill(d.id);
          }}
          style={rowButtonStyle}
        >
          <span style={{ color: "var(--steel)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {d.label}
          </span>
          <span style={trackStyle} aria-hidden="true">
            <span
              style={{
                position: "absolute",
                insetBlock: 0,
                left: 0,
                width: `${(scale.norm(d.value) * 100).toFixed(2)}%`,
                background: "var(--signal)",
                borderRadius: "var(--radius-pill)",
              }}
            />
          </span>
          <span style={valueStyle}>{format(d.value)}</span>
        </button>
      ))}
      {onAdd ? (
        <button
          type="button"
          data-window-control="true"
          onClick={onAdd}
          style={{ ...rowButtonStyle, gridTemplateColumns: "1fr", color: "var(--steel)" }}
        >
          {T.add}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Inline sparkline on an honest scale (§4-24). The whole mark is one drill
 * target (§4.7-9) showing the latest value.
 */
export function HonestSpark({
  label,
  values,
  format = formatWon,
  onDrill,
  width = 120,
  height = 28,
}: {
  label: string;
  values: number[];
  format?: ChartFormat;
  onDrill: () => void;
  width?: number;
  height?: number;
}) {
  const scale = honestScale(values);
  const n = values.length;
  const points = values
    .map((v, i) => {
      const x = n === 1 ? width / 2 : (i / (n - 1)) * (width - 2) + 1;
      const y = height - 1 - scale.norm(v) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = n > 0 ? values[n - 1] : null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
      <button
        type="button"
        data-window-control="true"
        aria-label={last !== null ? T.spark(label, format(last)) : label}
        onClick={onDrill}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          minHeight: 44,
          padding: "0 var(--sp-2)",
          border: "none",
          borderRadius: "var(--radius-sm)",
          background: "transparent",
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          cursor: "pointer",
        }}
      >
        <svg width={width} height={height} viewBox={`0 0 ${String(width)} ${String(height)}`} aria-hidden="true">
          {n > 1 ? (
            <polyline points={points} fill="none" stroke="var(--teal)" strokeWidth={1.5} strokeLinejoin="round" />
          ) : null}
          {last !== null ? (
            <circle
              cx={n === 1 ? width / 2 : width - 1}
              cy={height - 1 - scale.norm(last) * (height - 2)}
              r={2.5}
              fill="var(--signal)"
            />
          ) : null}
        </svg>
        {last !== null ? <span style={valueStyle}>{format(last)}</span> : null}
      </button>
      {scale.truncated ? <AxisTruncationChip baseline={scale.min} format={format} /> : null}
    </span>
  );
}
