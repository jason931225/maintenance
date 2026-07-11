import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import {
  HonestBar,
  ProjectionPanel,
  type BackendProjection,
  type ChartDatum,
  type ChartFormat,
} from "../charts";
import { StatusChip } from "../components";
import "../tokens.css";
import { laborCostStrings } from "./strings";

/**
 * 인건비 분석 — labor-cost analysis over the real payroll draft runs
 * (/api/v1/payroll/runs) and their per-employee hour lines. It shows the
 * per-period payroll processing status, the org labor-hours composition
 * (정규/연장/야간/휴일), and a backend-projected labor-hours trend
 * (POST /api/v1/analytics/projection). ₩ cost is honestly omitted (§4-25-⑥):
 * payroll stores readiness + hours, not pay amounts, so a labor-cost figure has
 * no backing source and is named as pending — never fabricated.
 */

export interface LaborCostPeriod {
  runId: string;
  periodLabel: string;
  status: string;
}

/** Aggregate labor hours by type across the loaded payroll runs. */
export interface LaborHours {
  regular: number;
  overtime: number;
  night: number;
  holiday: number;
}

export interface LaborCostScreenProps {
  periods: readonly LaborCostPeriod[];
  hours: LaborHours;
  /** Per-period total labor hours, oldest first — the projected series. */
  trend: readonly number[];
  projectionResult?: BackendProjection;
  isLoading: boolean;
  /** Every affordance drills to the payroll source screen (§4-11). */
  onDrill: () => void;
}

function trimDecimal(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const hoursFormat: ChartFormat = (value) => `${trimDecimal(value)}${ko.common.hourUnit}`;

function statusTone(status: string): "ok" | "warn" | "neutral" {
  if (status === "APPROVED" || status === "ISSUED") return "ok";
  if (status === "BLOCKED_LEGAL_GATE") return "warn";
  return "neutral";
}

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  fontFamily: "var(--font-sans)",
  color: "var(--ink)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-3)",
};

const panelStyle: CSSProperties = {
  display: "grid",
  alignContent: "start",
  gap: "var(--sp-4)",
  padding: "var(--sp-card-y) var(--sp-6)",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const stripStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const periodButtonStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  minHeight: 44,
  padding: "var(--sp-2) var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
  textAlign: "left",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const emptyActionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  width: "fit-content",
  padding: "0 var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--muted)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
  cursor: "pointer",
};

export function LaborCostScreen({
  periods,
  hours,
  trend,
  projectionResult,
  isLoading,
  onDrill,
}: LaborCostScreenProps) {
  const S = laborCostStrings();
  const composition: ChartDatum[] = [
    { id: "regular", label: S.hoursRegular, value: hours.regular },
    { id: "overtime", label: S.hoursOvertime, value: hours.overtime },
    { id: "night", label: S.hoursNight, value: hours.night },
    { id: "holiday", label: S.hoursHoliday, value: hours.holiday },
  ].filter((datum) => datum.value > 0);
  const trendSeries = trend.filter((value) => Number.isFinite(value));

  return (
    <div className="console" style={rootStyle}>
      <header style={headerStyle}>
        <h1 style={panelTitleStyle}>{S.title}</h1>
        {isLoading ? (
          <StatusChip role="status">{ko.common.loading}</StatusChip>
        ) : null}
      </header>

      {!isLoading && periods.length === 0 ? (
        <section style={panelStyle}>
          <p style={{ margin: 0, fontSize: "var(--text-body)", color: "var(--steel)" }}>
            {S.emptyReason}
          </p>
          <button type="button" data-window-control="true" style={emptyActionStyle} onClick={onDrill}>
            {S.periodsTitle}
          </button>
        </section>
      ) : null}

      {periods.length > 0 ? (
        <section style={panelStyle} aria-label={S.periodsTitle}>
          <h2 style={panelTitleStyle}>{S.periodsTitle}</h2>
          <div role="group" aria-label={S.periodsTitle} style={stripStyle}>
            {periods.map((period) => {
              const statusLabel = S.status[period.status] ?? period.status;
              return (
                <button
                  key={period.runId}
                  type="button"
                  data-window-control="true"
                  aria-label={S.periodDrill(period.periodLabel, statusLabel)}
                  style={periodButtonStyle}
                  onClick={onDrill}
                >
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{period.periodLabel}</span>
                  <StatusChip tone={statusTone(period.status)} role="status">
                    {statusLabel}
                  </StatusChip>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {composition.length > 0 ? (
        <section style={panelStyle} aria-label={S.compositionTitle}>
          <h2 style={panelTitleStyle}>{S.compositionTitle}</h2>
          <HonestBar
            label={S.compositionTitle}
            data={composition}
            format={hoursFormat}
            onDrill={onDrill}
          />
        </section>
      ) : null}

      {trendSeries.length >= 3 ? (
        <ProjectionPanel
          title={S.trendTitle}
          kind="percent"
          format={hoursFormat}
          sample={trendSeries}
          backendResult={projectionResult}
          onDrill={onDrill}
        />
      ) : null}

      {/* §4-25-⑥: labor cost in ₩ has no backing source (payroll stores hours +
          readiness, not amounts) — named as pending, never fabricated. */}
      <section style={panelStyle} aria-label={S.costPendingTitle}>
        <StatusChip tone="warn" role="status">
          {S.costPendingTitle}
        </StatusChip>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--steel)" }}>
          {S.costPendingReason}
        </p>
      </section>
    </div>
  );
}
