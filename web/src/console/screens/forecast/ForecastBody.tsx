import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router";

import type { AssetLifecycleCostSummary, EquipmentListItem } from "../../../api/types";
import { useAuth } from "../../../context/auth";
import type { ServerProjectionState } from "../../charts/ProjectionPanel";
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
 * ledger money and the projection is server-computed. Loading, denial, failure,
 * and empty results remain explicit and never become client-derived forecasts.
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

type LifecycleState = "loading" | "ready" | "empty" | "denied" | "error";

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
  const [lifecycleStateOwned, setLifecycleStateOwned] = useState<ApiOwned<LifecycleState>>(() =>
    ownedBy(api, "empty"),
  );
  const [horizonMonths, setHorizonMonths] = useState<HorizonMonths>(DEFAULT_HORIZON_MONTHS);
  const [whatIfPct, setWhatIfPct] = useState(0);
  const [projectionStateOwned, setProjectionStateOwned] = useState<
    ApiOwned<ServerProjectionState>
  >(() => ownedBy(api, { status: "empty" }));

  const equipmentQuery = equipmentQueryOwned.api === api ? equipmentQueryOwned.value : "";
  const equipmentOptions = equipmentOptionsOwned.api === api ? equipmentOptionsOwned.value : [];
  const selectedEquipment =
    selectedEquipmentOwned.api === api ? selectedEquipmentOwned.value : undefined;
  const lifecycleCost = lifecycleCostOwned.api === api ? lifecycleCostOwned.value : undefined;
  const lifecycleState =
    lifecycleStateOwned.api === api ? lifecycleStateOwned.value : "empty";
  const projectionState =
    projectionStateOwned.api === api ? projectionStateOwned.value : { status: "empty" as const };

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

  const loadLifecycle = useCallback(
    (item: EquipmentListItem) => {
      if (activeApiRef.current !== api) return;
      const request = lifecycleRequest.current + 1;
      lifecycleRequest.current = request;
      setLifecycleCostOwned(ownedBy(api, undefined));
      setProjectionStateOwned(ownedBy(api, { status: "empty" }));
      setLifecycleStateOwned(ownedBy(api, "loading"));
      void api
        .GET("/api/v1/financial/equipment/{equipmentId}/lifecycle-cost", {
          params: { path: { equipmentId: item.equipment_id } },
        })
        .then((res) => {
          if (activeApiRef.current === api && lifecycleRequest.current === request) {
            if (res.data) {
              setLifecycleCostOwned(ownedBy(api, res.data));
              setLifecycleStateOwned(ownedBy(api, "ready"));
            } else if (res.response.status === 401 || res.response.status === 403) {
              setLifecycleStateOwned(ownedBy(api, "denied"));
            } else if (res.response.status === 204 || res.response.status === 404) {
              setLifecycleStateOwned(ownedBy(api, "empty"));
            } else {
              setLifecycleStateOwned(ownedBy(api, "error"));
            }
          }
        })
        .catch(() => {
          if (activeApiRef.current === api && lifecycleRequest.current === request) {
            setLifecycleStateOwned(ownedBy(api, "error"));
          }
        });
    },
    [api],
  );

  const selectEquipment = useCallback(
    (item: EquipmentListItem) => {
      if (activeApiRef.current !== api) return;
      setSelectedEquipmentOwned(ownedBy(api, item));
      setEquipmentOptionsOwned(ownedBy(api, []));
      loadLifecycle(item);
    },
    [api, loadLifecycle],
  );

  const clearEquipment = useCallback(() => {
    if (activeApiRef.current !== api) return;
    lifecycleRequest.current += 1;
    setSelectedEquipmentOwned(ownedBy(api, undefined));
    setLifecycleCostOwned(ownedBy(api, undefined));
    setProjectionStateOwned(ownedBy(api, { status: "empty" }));
    setLifecycleStateOwned(ownedBy(api, "empty"));
    setEquipmentQueryOwned(ownedBy(api, ""));
  }, [api]);

  const retryLifecycle = useCallback(() => {
    if (selectedEquipment) loadLifecycle(selectedEquipment);
  }, [loadLifecycle, selectedEquipment]);

  const changeHorizon = useCallback(
    (months: HorizonMonths) => {
      if (activeApiRef.current !== api) return;
      setProjectionStateOwned(ownedBy(api, { status: "loading" }));
      setHorizonMonths(months);
    },
    [api],
  );

  const changeWhatIf = useCallback(
    (pct: number) => {
      if (activeApiRef.current !== api) return;
      setProjectionStateOwned(ownedBy(api, { status: "loading" }));
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
          setProjectionStateOwned(ownedBy(api, { status: "empty" }));
        }
      });
      return () => {
        cancelled = true;
      };
    }
    void Promise.resolve().then(() => {
      if (!cancelled && activeApiRef.current === api) {
        setProjectionStateOwned(ownedBy(api, { status: "loading" }));
      }
    });
    void api
      .POST("/api/v1/analytics/projection", {
        body: { series: sample, horizon: horizonMonths, kind: "money" },
      })
      .then((res) => {
        if (!cancelled && activeApiRef.current === api) {
          if (res.data) {
            setProjectionStateOwned(ownedBy(api, { status: "ready", result: res.data }));
          } else if (res.response.status === 401 || res.response.status === 403) {
            setProjectionStateOwned(ownedBy(api, { status: "denied" }));
          } else if (res.response.status === 204 || res.response.status === 404) {
            setProjectionStateOwned(ownedBy(api, { status: "empty" }));
          } else {
            setProjectionStateOwned(ownedBy(api, { status: "error" }));
          }
        }
      })
      .catch(() => {
        if (!cancelled && activeApiRef.current === api) {
          setProjectionStateOwned(ownedBy(api, { status: "error" }));
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
        isLoading={lifecycleState === "loading"}
        lifecycleState={lifecycleState}
        onRetryLifecycle={retryLifecycle}
        horizonMonths={horizonMonths}
        onHorizonChange={changeHorizon}
        whatIfPct={whatIfPct}
        onWhatIfChange={changeWhatIf}
        onDrill={onDrill}
        projectionState={projectionState}
      />
    </div>
  );
}
