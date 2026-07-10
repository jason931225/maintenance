import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { AssetLifecycleCostSummary, EquipmentListItem } from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { PageError } from "../components/states/PageError";
import { ForecastScreen, DEFAULT_HORIZON_MONTHS, type HorizonMonths } from "../console/forecast";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

const EQUIPMENT_SEARCH_DEBOUNCE_MS = 300;

type ReadState = "idle" | "loading" | "error";

/**
 * Forecast (분석 › 예측) — statistical projection over a chosen equipment's
 * real maintenance-cost ledger (console/forecast). PBAC deny-by-omission:
 * unauthorized callers never see the equipment picker at all.
 */
export function ForecastPage() {
  const { api } = useAuth();
  const navigate = useNavigate();

  const [equipmentQuery, setEquipmentQuery] = useState("");
  const [equipmentOptions, setEquipmentOptions] = useState<EquipmentListItem[]>([]);
  const [selectedEquipment, setSelectedEquipment] = useState<EquipmentListItem>();
  const [lifecycleCost, setLifecycleCost] = useState<AssetLifecycleCostSummary>();
  const [horizonMonths, setHorizonMonths] = useState<HorizonMonths>(DEFAULT_HORIZON_MONTHS);
  const [whatIfPct, setWhatIfPct] = useState(0);
  const [readState, setReadState] = useState<ReadState>("idle");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (selectedEquipment) return;
    const query = equipmentQuery.trim();
    if (query.length === 0) {
      void Promise.resolve().then(() => {
        setEquipmentOptions([]);
      });
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void api
        .GET("/api/v1/equipment/list", { params: { query: { q: query, limit: 5, sort: "equipment_no" } } })
        .then((response) => {
          setEquipmentOptions(response.data?.items ?? []);
        })
        .catch(() => {
          setEquipmentOptions([]);
        });
    }, EQUIPMENT_SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [api, equipmentQuery, selectedEquipment]);

  const loadLifecycleCost = useCallback(
    async (equipmentId: string) => {
      setReadState("loading");
      const response = await api
        .GET("/api/v1/financial/equipment/{equipmentId}/lifecycle-cost", {
          params: { path: { equipmentId } },
        })
        .catch(() => undefined);
      if (!response?.data) {
        setReadState("error");
        return;
      }
      setLifecycleCost(response.data);
      setReadState("idle");
    },
    [api],
  );

  useEffect(() => {
    if (!selectedEquipment) return;
    void Promise.resolve().then(() => loadLifecycleCost(selectedEquipment.equipment_id));
  }, [selectedEquipment, loadLifecycleCost]);

  const selectEquipment = useCallback((item: EquipmentListItem) => {
    setSelectedEquipment(item);
    setEquipmentQuery("");
    setEquipmentOptions([]);
  }, []);

  const clearEquipment = useCallback(() => {
    setSelectedEquipment(undefined);
    setLifecycleCost(undefined);
    setReadState("idle");
  }, []);

  return (
    <>
      <PageHeader title={ko.nav.forecast} />
      <div className="grid gap-5">
        {readState === "error" ? (
          <PageError
            onRetry={
              selectedEquipment
                ? () => {
                    void loadLifecycleCost(selectedEquipment.equipment_id);
                  }
                : undefined
            }
          />
        ) : null}
        <ForecastScreen
          equipmentQuery={equipmentQuery}
          onEquipmentQueryChange={setEquipmentQuery}
          equipmentOptions={equipmentOptions}
          selectedEquipment={selectedEquipment}
          onSelectEquipment={selectEquipment}
          onClearEquipment={clearEquipment}
          lifecycleCost={lifecycleCost}
          isLoading={readState === "loading"}
          horizonMonths={horizonMonths}
          onHorizonChange={setHorizonMonths}
          whatIfPct={whatIfPct}
          onWhatIfChange={setWhatIfPct}
          onDrill={() => {
            if (selectedEquipment) void navigate(`/equipment/${selectedEquipment.equipment_id}`);
          }}
        />
      </div>
    </>
  );
}
