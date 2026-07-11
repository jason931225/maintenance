import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";

import type { AssetLifecycleCostSummary, EquipmentListItem } from "../../../api/types";
import { useAuth } from "../../../context/auth";
import type { BackendProjection } from "../../charts";
import {
  DEFAULT_HORIZON_MONTHS,
  ForecastScreen,
  monthlyCostSample,
  type HorizonMonths,
} from "../../forecast";
import "../../tokens.css";

/**
 * 예측 screen body — composes the honest ForecastScreen into the console shell's
 * screen slot (SCREEN_REGISTRY key "forecast"; see screens/registry.ts). It owns
 * the real fetches: equipment search (/api/v1/equipment/list), the per-equipment
 * maintenance-cost ledger (/api/v1/financial/equipment/{id}/lifecycle-cost), and
 * the deterministic backend projection (POST /api/v1/analytics/projection,
 * Monte-Carlo/EVT — HANDOFF §18). No fabricated data: the cost sample is real
 * ledger money and the projection is server-computed; while it is in-flight or
 * the sample is too short, ForecastScreen falls back to the client estimate.
 */

const bodyStyle: CSSProperties = {
  height: "100%",
  overflowY: "auto",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
};

// Debounce equipment search so a keystroke burst fires one request.
const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 20;

export function ForecastBody() {
  const { api } = useAuth();
  const navigate = useNavigate();

  const [equipmentQuery, setEquipmentQuery] = useState("");
  const [equipmentOptions, setEquipmentOptions] = useState<readonly EquipmentListItem[]>([]);
  const [selectedEquipment, setSelectedEquipment] = useState<EquipmentListItem>();
  const [lifecycleCost, setLifecycleCost] = useState<AssetLifecycleCostSummary>();
  const [isLoading, setIsLoading] = useState(false);
  const [horizonMonths, setHorizonMonths] = useState<HorizonMonths>(DEFAULT_HORIZON_MONTHS);
  const [whatIfPct, setWhatIfPct] = useState(0);
  const [projectionResult, setProjectionResult] = useState<BackendProjection>();

  // Equipment search: only while no equipment is selected and the query is non-empty.
  useEffect(() => {
    const q = equipmentQuery.trim();
    let cancelled = false;
    if (selectedEquipment || q.length === 0) {
      // Defer the reset so it isn't a synchronous setState in the effect body
      // (react-hooks/set-state-in-effect); mirrors the DashboardBody idiom.
      void Promise.resolve().then(() => {
        if (!cancelled) setEquipmentOptions([]);
      });
      return () => {
        cancelled = true;
      };
    }
    const handle = setTimeout(() => {
      void api
        .GET("/api/v1/equipment/list", {
          params: { query: { q, limit: SEARCH_LIMIT, offset: 0, sort: "equipment_no" } },
        })
        .then((res) => {
          if (!cancelled) setEquipmentOptions(res.data?.items ?? []);
        })
        .catch(() => {
          if (!cancelled) setEquipmentOptions([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, equipmentQuery, selectedEquipment]);

  const selectEquipment = useCallback(
    (item: EquipmentListItem) => {
      setSelectedEquipment(item);
      setEquipmentOptions([]);
      setLifecycleCost(undefined);
      setProjectionResult(undefined);
      setIsLoading(true);
      void api
        .GET("/api/v1/financial/equipment/{equipmentId}/lifecycle-cost", {
          params: { path: { equipmentId: item.equipment_id } },
        })
        .then((res) => {
          setLifecycleCost(res.data);
        })
        .catch(() => {
          setLifecycleCost(undefined);
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [api],
  );

  const clearEquipment = useCallback(() => {
    setSelectedEquipment(undefined);
    setLifecycleCost(undefined);
    setProjectionResult(undefined);
    setEquipmentQuery("");
  }, []);

  // The real monthly cost series ForecastScreen draws and the backend projects.
  const sample = useMemo(
    () =>
      lifecycleCost
        ? monthlyCostSample(lifecycleCost.timeline, horizonMonths, new Date(), whatIfPct)
        : [],
    [lifecycleCost, horizonMonths, whatIfPct],
  );

  // Backend Monte-Carlo/EVT projection over the current sample. The endpoint
  // requires ≥3 points; below that the panel shows its own insufficient state.
  useEffect(() => {
    let cancelled = false;
    if (sample.length < 3) {
      // Defer the reset (react-hooks/set-state-in-effect); DashboardBody idiom.
      void Promise.resolve().then(() => {
        if (!cancelled) setProjectionResult(undefined);
      });
      return () => {
        cancelled = true;
      };
    }
    void api
      .POST("/api/v1/analytics/projection", {
        body: { series: sample, horizon: horizonMonths, kind: "money" },
      })
      .then((res) => {
        if (!cancelled) setProjectionResult(res.data);
      })
      .catch(() => {
        if (!cancelled) setProjectionResult(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [api, sample, horizonMonths]);

  // §4-11: every projection number drills to the source equipment browse.
  const onDrill = useCallback(() => {
    void navigate("/equipment");
  }, [navigate]);

  return (
    <div className="console" data-cshell-screen-body="forecast" style={bodyStyle}>
      <ForecastScreen
        equipmentQuery={equipmentQuery}
        onEquipmentQueryChange={setEquipmentQuery}
        equipmentOptions={equipmentOptions}
        selectedEquipment={selectedEquipment}
        onSelectEquipment={selectEquipment}
        onClearEquipment={clearEquipment}
        lifecycleCost={lifecycleCost}
        isLoading={isLoading}
        horizonMonths={horizonMonths}
        onHorizonChange={setHorizonMonths}
        whatIfPct={whatIfPct}
        onWhatIfChange={setWhatIfPct}
        onDrill={onDrill}
        projectionResult={projectionResult}
      />
    </div>
  );
}
