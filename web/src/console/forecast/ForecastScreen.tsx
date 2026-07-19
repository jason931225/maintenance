import type { CSSProperties } from "react";

import type { AssetLifecycleCostSummary, EquipmentListItem } from "../../api/types";
import { ProjectionPanel, type ProjectionDrillPart } from "../charts";
import type { ServerProjectionState } from "../charts/ProjectionPanel";
import { StatusChip } from "../components";
import "../tokens.css";
import { ko } from "../../i18n/ko";
import { HORIZON_OPTIONS, fcCode, monthlyCostSample, type HorizonMonths } from "./series";
import { forecastStrings } from "./strings";

const S = forecastStrings();

export interface ForecastScreenProps {
  equipmentQuery: string;
  onEquipmentQueryChange: (query: string) => void;
  equipmentOptions: readonly EquipmentListItem[];
  selectedEquipment?: EquipmentListItem;
  onSelectEquipment: (item: EquipmentListItem) => void;
  onClearEquipment: () => void;
  lifecycleCost?: AssetLifecycleCostSummary;
  isLoading: boolean;
  lifecycleState?: "loading" | "ready" | "empty" | "denied" | "error";
  onRetryLifecycle?: () => void;
  horizonMonths: HorizonMonths;
  onHorizonChange: (months: HorizonMonths) => void;
  whatIfPct: number;
  onWhatIfChange: (pct: number) => void;
  onDrill: (part: ProjectionDrillPart) => void;
  /** Explicit lifecycle of the server-owned Monte-Carlo/EVT projection. */
  projectionState?: ServerProjectionState;
}

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
};

const searchInputStyle: CSSProperties = {
  minHeight: 44,
  width: "100%",
  maxWidth: 420,
  padding: "0 var(--sp-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-body)",
};

const resultListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const resultButtonStyle: CSSProperties = {
  display: "flex",
  gap: "var(--sp-2)",
  alignItems: "baseline",
  minHeight: 44,
  width: "100%",
  padding: "0 var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-body)",
  textAlign: "left",
  cursor: "pointer",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const fieldRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-4)",
};

const groupStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

function segmentStyle(selected: boolean): CSSProperties {
  return {
    minHeight: 44,
    padding: "0 var(--sp-4)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: selected ? "var(--ink)" : "var(--surface)",
    color: selected ? "var(--surface)" : "var(--steel)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-body)",
    fontWeight: "var(--fw-medium)",
    cursor: "pointer",
  };
}

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  color: "var(--steel)",
};

const whatIfInputStyle: CSSProperties = {
  minHeight: 44,
  width: 96,
  padding: "0 var(--sp-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-body)",
  fontVariantNumeric: "tabular-nums",
};

const emptyStyle: CSSProperties = {
  padding: "var(--sp-5)",
  border: "1px dashed var(--border-soft)",
  borderRadius: "var(--radius-card)",
  color: "var(--steel)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-body)",
};

/**
 * Forecast surface v1 — statistical projection (point-est + CI95 + CVaR95)
 * over a real per-equipment maintenance-cost series (console/charts
 * ProjectionPanel), horizon-segmented, with a typed what-if delta field.
 * Every number in the panel drills to the source equipment (§4-11).
 */
export function ForecastScreen({
  equipmentQuery,
  onEquipmentQueryChange,
  equipmentOptions,
  selectedEquipment,
  onSelectEquipment,
  onClearEquipment,
  lifecycleCost,
  isLoading,
  lifecycleState,
  onRetryLifecycle,
  horizonMonths,
  onHorizonChange,
  whatIfPct,
  onWhatIfChange,
  onDrill,
  projectionState,
}: ForecastScreenProps) {
  if (!selectedEquipment) {
    return (
      <div style={rootStyle}>
        <input
          type="search"
          aria-label={S.equipmentSearchLabel}
          title={S.equipmentSearchHint}
          value={equipmentQuery}
          onChange={(event) => {
            onEquipmentQueryChange(event.target.value);
          }}
          style={searchInputStyle}
        />
        {equipmentQuery.trim().length > 0 ? (
          equipmentOptions.length > 0 ? (
            <ul style={resultListStyle}>
              {equipmentOptions.map((item) => (
                <li key={item.equipment_id}>
                  <button
                    type="button"
                    data-window-control="true"
                    style={resultButtonStyle}
                    onClick={() => {
                      onSelectEquipment(item);
                    }}
                  >
                    <strong>{item.equipment_no}</strong>
                    <span style={{ color: "var(--steel)" }}>{item.customer_name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <StatusChip tone="neutral" role="status">
              {S.noResults}
            </StatusChip>
          )
        ) : (
          <p style={emptyStyle}>{S.emptyReason}</p>
        )}
      </div>
    );
  }

  const sample = lifecycleCost
    ? monthlyCostSample(lifecycleCost.timeline, horizonMonths, new Date(), whatIfPct)
    : [];
  const effectiveLifecycleState =
    lifecycleState ?? (isLoading ? "loading" : lifecycleCost ? "ready" : "empty");

  return (
    <div style={rootStyle}>
      <div style={headerRowStyle}>
        <StatusChip tone="accent" ariaLabel={S.fcCodeLabel}>
          {fcCode(selectedEquipment.equipment_id)}
        </StatusChip>
        <strong>{selectedEquipment.equipment_no}</strong>
        <span style={{ color: "var(--steel)" }}>{selectedEquipment.customer_name}</span>
        <button
          type="button"
          data-window-control="true"
          onClick={onClearEquipment}
          style={{ ...segmentStyle(false), marginLeft: "auto" }}
        >
          {S.changeEquipment}
        </button>
      </div>

      <div style={fieldRowStyle}>
        <div role="group" aria-label={S.horizonGroupLabel} style={groupStyle}>
          {HORIZON_OPTIONS.map((months) => {
            const selected = months === horizonMonths;
            return (
              <button
                key={months}
                type="button"
                data-window-control="true"
                aria-pressed={selected}
                onClick={() => {
                  onHorizonChange(months);
                }}
                style={segmentStyle(selected)}
              >
                {S.horizonMonths(months)}
              </button>
            );
          })}
        </div>

        <label style={fieldLabelStyle}>
          {S.whatIfLabel}
          <input
            type="number"
            inputMode="numeric"
            min={-50}
            max={100}
            step={1}
            value={whatIfPct}
            onChange={(event) => {
              const next = Number(event.target.value);
              onWhatIfChange(Number.isFinite(next) ? next : 0);
            }}
            style={whatIfInputStyle}
          />
        </label>
      </div>

      {effectiveLifecycleState === "loading" ? (
        <StatusChip role="status">{ko.page.loading}</StatusChip>
      ) : effectiveLifecycleState === "denied" ? (
        <StatusChip tone="danger" role="alert">{ko.page.permissionDenied}</StatusChip>
      ) : effectiveLifecycleState === "error" ? (
        <section>
          <StatusChip tone="danger" role="alert">{ko.page.loadFailed}</StatusChip>
          {onRetryLifecycle ? (
            <button type="button" data-window-control="true" onClick={onRetryLifecycle} style={segmentStyle(false)}>
              {ko.page.retry}
            </button>
          ) : null}
        </section>
      ) : effectiveLifecycleState === "empty" ? (
        <StatusChip tone="neutral" role="status">{ko.page.empty}</StatusChip>
      ) : (
        <ProjectionPanel
          title={S.seriesTitle(selectedEquipment.equipment_no)}
          kind="money"
          sample={sample}
          serverState={projectionState}
          onDrill={onDrill}
        />
      )}
    </div>
  );
}
