// §19 widget palette — every rendered number is a drill button (no dead
// numbers). All three widgets recompute from (config, rows) so a rows refresh
// re-renders live counts with zero extra plumbing.
import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { AxisTruncationChip, honestScale } from "../charts";
import { computeCounts } from "./doc";
import type { ConfigConsoleStrings } from "./strings";
import type {
  ChartWidget,
  DrillFilter,
  LiveCountWidget,
  OntInstanceRow,
  OntObjectTypeDef,
  StatBarWidget,
  WidgetConfig,
} from "./types";

const S: ConfigConsoleStrings = ko.console.configconsole;

export interface WidgetProps<C extends WidgetConfig> {
  config: C;
  rows: readonly OntInstanceRow[];
  registry: readonly OntObjectTypeDef[];
  onDrill: (filter: DrillFilter) => void;
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

/** Live count — total + per-enum-value counts, each a drill (§19 live count widget). */
export function LiveCountCard({ config, rows, registry, onDrill }: WidgetProps<LiveCountWidget>) {
  const title = typeTitle(registry, config.objectType);
  const result = computeCounts(rows, config.objectType, config.groupBy, registry);
  return (
    <div style={{ display: "grid", gap: "var(--sp-3)" }}>
      <button
        type="button"
        aria-label={S.widget.totalAria(title, result.total)}
        style={drillButtonStyle}
        onClick={() => { onDrill({ objectType: config.objectType }); }}
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
                  onDrill({ objectType: config.objectType, field: config.groupBy, choiceId: group.id });
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

/** Stat bar — one drillable total per selected object type. */
export function StatBarCard({ config, rows, registry, onDrill }: WidgetProps<StatBarWidget>) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
      {config.objectTypes.map((key) => {
        const title = typeTitle(registry, key);
        const result = computeCounts(rows, key, undefined, registry);
        return (
          <button
            key={key}
            type="button"
            aria-label={S.widget.totalAria(title, result.total)}
            style={{ ...drillButtonStyle, width: "auto", flex: "1 1 auto" }}
            onClick={() => { onDrill({ objectType: key }); }}
          >
            <span style={labelStyle}>{title}</span>
            <span style={valueStyle}>{result.total}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Bar chart — console/charts honestScale bars (§4-24), bars drill. */
export function BarChartCard({ config, rows, registry, onDrill }: WidgetProps<ChartWidget>) {
  const title = typeTitle(registry, config.objectType);
  const result = computeCounts(rows, config.objectType, config.field, registry);
  const scale = honestScale(result.groups.map((group) => group.count));
  return (
    <ul aria-label={S.widget.chartAria(title)} style={listStyle}>
      {scale.truncated ? (
        <li style={{ listStyle: "none" }}>
          <AxisTruncationChip baseline={scale.min} format={(value) => S.drill.countChip(value)} />
        </li>
      ) : null}
      {result.groups.map((group) => (
        <li key={group.id}>
          <button
            type="button"
            aria-label={S.widget.countAria(group.label, group.count)}
            style={{ ...drillButtonStyle, display: "grid", gridTemplateColumns: "minmax(64px, auto) 1fr auto" }}
            onClick={() => {
              onDrill({ objectType: config.objectType, field: config.field, choiceId: group.id });
            }}
          >
            <span style={labelStyle}>{group.label}</span>
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
      ))}
    </ul>
  );
}

/** Kind switch used by the slot body — parse already strips unknown kinds. */
export function WidgetBody(props: WidgetProps<WidgetConfig>) {
  const { config } = props;
  switch (config.kind) {
    case "liveCount":
      return <LiveCountCard {...props} config={config} />;
    case "statBar":
      return <StatBarCard {...props} config={config} />;
    case "chart":
      return <BarChartCard {...props} config={config} />;
  }
}
