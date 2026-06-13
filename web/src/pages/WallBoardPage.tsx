import { useCallback, useEffect, useMemo, useState } from "react";

import { createConsoleApiClient } from "../api/client";
import type { KpiReport, WorkOrderListItem } from "../api/types";
import { WallBoard } from "../features/kpi/WallBoard";
import { getDefaultKpiPeriod, getWallboardRefreshIntervalMs } from "../features/kpi/kpi-format";

export function WallBoardPage() {
  // Wallboard is kiosk-mode: no auth required, uses anonymous client
  const anonApi = useMemo(() => createConsoleApiClient(), []);
  const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
  const [kpiReport, setKpiReport] = useState<KpiReport>();
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [listResponse, kpiResponse] = await Promise.all([
        anonApi.GET("/api/v1/work-orders", {
          params: { query: { limit: 100, offset: 0 } },
        }),
        anonApi.GET("/api/v1/kpi", {
          params: { query: { period: getDefaultKpiPeriod() } },
        }),
      ]);
      if (listResponse.data) setWorkOrders(listResponse.data.items);
      if (kpiResponse.data) setKpiReport(kpiResponse.data);
    } finally {
      setIsLoading(false);
    }
  }, [anonApi]);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  return (
    <WallBoard
      isLoading={isLoading}
      refreshIntervalMs={getWallboardRefreshIntervalMs()}
      report={kpiReport}
      workOrders={workOrders}
      onRefresh={loadData}
    />
  );
}
