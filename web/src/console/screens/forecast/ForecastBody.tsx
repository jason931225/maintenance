import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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

interface ApiOwned<T> {
  api: object;
  value: T;
}

function ownedBy<T>(api: object, value: T): ApiOwned<T> {
  return { api, value };
}

export function ForecastBody() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const activeApiRef = useRef<typeof api | undefined>(api);
  const lifecycleRequest = useRef(0);

  useLayoutEffect(() => {
    activeApiRef.current = api;
    lifecycleRequest.current += 1;
    return () => {
      if (activeApiRef.current === api) activeApiRef.current = undefined;
      lifecycleRequest.current += 1;
    };
  }, [api]);

  const [equipmentQueryOwned, setEquipmentQueryOwned] = useState<ApiOwned<string>>(() =>
    ownedBy(api, ""),
  );
  const [equipmentOptionsOwned, setEquipmentOptionsOwned] = useState<
    ApiOwned<readonly EquipmentListItem[]>
  >(() => ownedBy(api, []));
  const [selectedEquipmentOwned, setSelectedEquipmentOwned] = useState<
    ApiOwned<EquipmentListItem | undefined>
  >(() => ownedBy(api, undefined));
  const [lifecycleCostOwned, setLifecycleCostOwned] = useState<
    ApiOwned<AssetLifecycleCostSummary | undefined>
  >(() => ownedBy(api, undefined));
  const [isLoadingOwned, setIsLoadingOwned] = useState<ApiOwned<boolean>>(() =>
    ownedBy(api, false),
  );
  const [horizonMonths, setHorizonMonths] = useState<HorizonMonths>(DEFAULT_HORIZON_MONTHS);
  const [whatIfPct, setWhatIfPct] = useState(0);
  const [projectionResultOwned, setProjectionResultOwned] = useState<
    ApiOwned<BackendProjection | undefined>
  >(() => ownedBy(api, undefined));

  const equipmentQuery = equipmentQueryOwned.api === api ? equipmentQueryOwned.value : "";
  const equipmentOptions = equipmentOptionsOwned.api === api ? equipmentOptionsOwned.value : [];
  const selectedEquipment =
    selectedEquipmentOwned.api === api ? selectedEquipmentOwned.value : undefined;
  const lifecycleCost = lifecycleCostOwned.api === api ? lifecycleCostOwned.value : undefined;
  const isLoading = isLoadingOwned.api === api ? isLoadingOwned.value : false;
  const projectionResult =
    projectionResultOwned.api === api ? projectionResultOwned.value : undefined;

  // Equipment search: only while no equipment is selected and the query is non-empty.
  useEffect(() => {
    const q = equipmentQuery.trim();
    let cancelled = false;
    if (selectedEquipment || q.length === 0) {
      // Defer the reset so it isn't a synchronous setState in the effect body
      // (react-hooks/set-state-in-effect); mirrors the DashboardBody idiom.
      void Promise.resolve().then(() => {
        if (!cancelled && activeApiRef.current === api) {
          setEquipmentOptionsOwned(ownedBy(api, []));
        }
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
          if (!cancelled && activeApiRef.current === api) {
            setEquipmentOptionsOwned(ownedBy(api, res.data?.items ?? []));
          }
        })
        .catch(() => {
          if (!cancelled && activeApiRef.current === api) {
            setEquipmentOptionsOwned(ownedBy(api, []));
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, equipmentQuery, selectedEquipment]);

  const changeEquipmentQuery = useCallback(
    (value: string) => {
      if (activeApiRef.current !== api) return;
      setEquipmentQueryOwned(ownedBy(api, value));
    },
    [api],
  );

  const selectEquipment = useCallback(
    (item: EquipmentListItem) => {
      if (activeApiRef.current !== api) return;
      const request = lifecycleRequest.current + 1;
      lifecycleRequest.current = request;
      setSelectedEquipmentOwned(ownedBy(api, item));
      setEquipmentOptionsOwned(ownedBy(api, []));
      setLifecycleCostOwned(ownedBy(api, undefined));
      setProjectionResultOwned(ownedBy(api, undefined));
      setIsLoadingOwned(ownedBy(api, true));
      void api
        .GET("/api/v1/financial/equipment/{equipmentId}/lifecycle-cost", {
          params: { path: { equipmentId: item.equipment_id } },
        })
        .then((res) => {
          if (activeApiRef.current === api && lifecycleRequest.current === request) {
            setLifecycleCostOwned(ownedBy(api, res.data));
          }
        })
        .catch(() => {
          if (activeApiRef.current === api && lifecycleRequest.current === request) {
            setLifecycleCostOwned(ownedBy(api, undefined));
          }
        })
        .finally(() => {
          if (activeApiRef.current === api && lifecycleRequest.current === request) {
            setIsLoadingOwned(ownedBy(api, false));
          }
        });
    },
    [api],
  );

  const clearEquipment = useCallback(() => {
    if (activeApiRef.current !== api) return;
    lifecycleRequest.current += 1;
    setSelectedEquipmentOwned(ownedBy(api, undefined));
    setLifecycleCostOwned(ownedBy(api, undefined));
    setProjectionResultOwned(ownedBy(api, undefined));
    setIsLoadingOwned(ownedBy(api, false));
    setEquipmentQueryOwned(ownedBy(api, ""));
  }, [api]);

  const changeHorizon = useCallback(
    (months: HorizonMonths) => {
      if (activeApiRef.current !== api) return;
      setProjectionResultOwned(ownedBy(api, undefined));
      setHorizonMonths(months);
    },
    [api],
  );

  const changeWhatIf = useCallback(
    (pct: number) => {
      if (activeApiRef.current !== api) return;
      setProjectionResultOwned(ownedBy(api, undefined));
      setWhatIfPct(pct);
    },
    [api],
  );

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
        if (!cancelled && activeApiRef.current === api) {
          setProjectionResultOwned(ownedBy(api, undefined));
        }
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
        if (!cancelled && activeApiRef.current === api) {
          setProjectionResultOwned(ownedBy(api, res.data));
        }
      })
      .catch(() => {
        if (!cancelled && activeApiRef.current === api) {
          setProjectionResultOwned(ownedBy(api, undefined));
        }
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
        onEquipmentQueryChange={changeEquipmentQuery}
        equipmentOptions={equipmentOptions}
        selectedEquipment={selectedEquipment}
        onSelectEquipment={selectEquipment}
        onClearEquipment={clearEquipment}
        lifecycleCost={lifecycleCost}
        isLoading={isLoading}
        horizonMonths={horizonMonths}
        onHorizonChange={changeHorizon}
        whatIfPct={whatIfPct}
        onWhatIfChange={changeWhatIf}
        onDrill={onDrill}
        projectionResult={projectionResult}
      />
    </div>
  );
}
