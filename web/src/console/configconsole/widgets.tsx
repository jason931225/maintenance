// §19 widget palette — every rendered number is a drill button (no dead
// numbers). count/dist recompute from (config, rows) so a rows refresh
// re-renders live; trend fetches one instance's real revision history
// (§4-25-⑥: no fabricated series — an instance with no numeric history
// renders the honest empty state, never a synthesized line).
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { AxisTruncationChip, honestScale } from "../charts";
import { fetchTrendSeries } from "./api";
import { computeCounts, computeDist } from "./doc";
import { configConsoleStrings, type ConfigConsoleStrings } from "./strings";
import type {
  CountWidget,
  DistWidget,
  DrillFilter,
  OntInstanceRow,
  OntObjectTypeDef,
  TrendWidget,
  WidgetConfig,
} from "./types";

const S: ConfigConsoleStrings = ko.console.configconsole;
const OBJECT_CARD_STRINGS = ko.console.objectcard;

export interface WidgetProps<C extends WidgetConfig> {
  config: C;
  rows: readonly OntInstanceRow[];
  registry: readonly OntObjectTypeDef[];
  onDrill: (filter: DrillFilter) => void;
  /** trend only — fetches the bound instance's real revision history. */
  api: ConsoleApiClient;
  /** trend only — opens the bound instance's ObjectCard (design delta 94: "explore the series object"). */
  onOpenInstance: (row: OntInstanceRow) => void;
}

const drillButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
  width: "100%",
  minHeight: 44,
  padding: "0 var(--sp-4)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  textAlign: "left",
  cursor: "pointer",
};

const labelStyle: CSSProperties = {
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
};

const valueStyle: CSSProperties = {
  color: "var(--ink)",
  fontSize: "var(--text-value-lg)",
  fontWeight: "var(--fw-strong)",
  fontVariantNumeric: "tabular-nums",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

function typeTitle(registry: readonly OntObjectTypeDef[], key: string): string {
  return registry.find((type) => type.key === key)?.title ?? key;
}

/** count — total + per-choice-value counts, each a drill (§19 live count widget). */
export function CountCard({ config, rows, registry, onDrill }: WidgetProps<CountWidget>) {
  const { objectType, groupBy } = config.bind;
  const title = typeTitle(registry, objectType);
  const result = computeCounts(rows, objectType, groupBy, registry);
  return (
    <div style={{ display: "grid", gap: "var(--sp-3)" }}>
      <button
        type="button"
        aria-label={S.widget.totalAria(title, result.total)}
        style={drillButtonStyle}
        onClick={() => { onDrill({ objectType }); }}
      >
        <span style={labelStyle}>{title}</span>
        <span style={valueStyle}>{result.total}</span>
      </button>
      {result.groups.length > 0 ? (
        <ul style={listStyle}>
          {result.groups.map((group) => (
            <li key={group.id}>
              <button
                type="button"
                aria-label={S.widget.countAria(group.label, group.count)}
                style={drillButtonStyle}
                onClick={() => {
                  onDrill({ objectType, field: groupBy, choiceId: group.id });
                }}
              >
                <span style={labelStyle}>{group.label}</span>
                <span style={valueStyle}>{group.count}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** dist — instance-state (lifecycle_state) grouping, top-4 chips, each a drill. */
export function DistCard({ config, rows, registry, onDrill }: WidgetProps<DistWidget>) {
  const { objectType } = config.bind;
  const title = typeTitle(registry, objectType);
  const result = computeDist(rows, objectType);
  const scale = honestScale(result.groups.map((group) => group.count));
  return (
    <ul aria-label={S.widget.chartAria(title)} style={listStyle}>
      {scale.truncated ? (
        <li style={{ listStyle: "none" }}>
          <AxisTruncationChip baseline={scale.min} format={(value) => S.drill.countChip(value)} />
        </li>
      ) : null}
      {result.groups.map((group) => {
        const label = OBJECT_CARD_STRINGS.lifecycle[group.id as OntInstanceRow["lifecycleState"]];
        return (
          <li key={group.id}>
            <button
              type="button"
              aria-label={S.widget.countAria(label, group.count)}
              style={{ ...drillButtonStyle, display: "grid", gridTemplateColumns: "minmax(64px, auto) 1fr auto" }}
              onClick={() => {
                onDrill({ objectType, lifecycleState: group.id as OntInstanceRow["lifecycleState"] });
              }}
            >
              <span style={labelStyle}>{label}</span>
              <span aria-hidden="true" style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    height: 10,
                    width: `${String(scale.norm(group.count) * 100)}%`,
                    borderRadius: "var(--radius-chip)",
                    background: "var(--signal)",
                  }}
                />
              </span>
              <span style={valueStyle}>{group.count}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type TrendReadState = "loading" | "idle" | "error" | "empty";

/** trend — one instance's real revision history for `field`, a sparkline of honest bars. */
export function TrendCard({ config, rows, registry, api, onOpenInstance }: WidgetProps<TrendWidget>) {
  const { objectType, instanceId, field } = config.bind;
  const title = typeTitle(registry, objectType);
  const T = configConsoleStrings();
  const fetchKey = `${instanceId}:${field}`;
  const [result, setResult] = useState<{
    key: string;
    readState: TrendReadState;
    series: readonly { validFrom: string; value: number }[];
  }>({ key: fetchKey, readState: "loading", series: [] });
  // Reset to loading during render (not in the effect body below) when the
  // bind changes — the React-idiomatic "adjust state on prop change" pattern.
  if (result.key !== fetchKey) {
    setResult({ key: fetchKey, readState: "loading", series: [] });
  }

  useEffect(() => {
    let cancelled = false;
    fetchTrendSeries(api, instanceId, field)
      .then((points) => {
        if (cancelled) return;
        setResult({ key: fetchKey, readState: points.length > 0 ? "idle" : "empty", series: points });
      })
      .catch(() => {
        if (!cancelled) setResult({ key: fetchKey, readState: "error", series: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [api, instanceId, field, fetchKey]);

  const { readState, series } = result;

  const row = rows.find((entry) => entry.id === instanceId);
  const scale = honestScale(series.map((point) => point.value));

  return (
    <div style={{ display: "grid", gap: "var(--sp-3)" }}>
      <button
        type="button"
        aria-label={T.widget.trendAria(title)}
        style={drillButtonStyle}
        onClick={() => {
          if (row) onOpenInstance(row);
        }}
      >
        <span style={labelStyle}>{title}</span>
        <span style={valueStyle}>{row?.code ?? instanceId}</span>
      </button>
      {readState === "loading" ? (
        <span style={labelStyle}>{T.widget.trendLoading}</span>
      ) : readState === "error" ? (
        <span style={labelStyle}>{T.widget.trendError}</span>
      ) : readState === "empty" ? (
        <span style={labelStyle}>{T.widget.trendEmpty}</span>
      ) : (
        <ul aria-label={T.widget.trendAria(title)} style={{ ...listStyle, display: "flex", alignItems: "flex-end", gap: 2, height: 48 }}>
          {scale.truncated ? (
            <li style={{ listStyle: "none" }}>
              <AxisTruncationChip baseline={scale.min} format={(value) => String(value)} />
            </li>
          ) : null}
          {series.map((point, index) => (
            <li key={`${point.validFrom}-${String(index)}`} style={{ listStyle: "none", flex: "1 1 auto" }}>
              <span
                aria-hidden="true"
                style={{
                  display: "block",
                  height: Math.max(2, scale.norm(point.value) * 48),
                  borderRadius: "var(--radius-chip)",
                  background: "var(--signal)",
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Kind switch used by the slot body — parse already strips unknown kinds. */
export function WidgetBody(props: WidgetProps<WidgetConfig>) {
  const { config } = props;
  switch (config.kind) {
    case "count":
      return <CountCard {...props} config={config} />;
    case "dist":
      return <DistCard {...props} config={config} />;
    case "trend":
      return <TrendCard {...props} config={config} />;
  }
}
