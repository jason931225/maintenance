import { useCallback, useEffect, useState } from "react";

import type { KpiReport, WorkOrderListItem } from "../api/types";
import { useAuth } from "../context/auth";
import { WallBoard } from "../features/kpi/WallBoard";
import { getDefaultKpiPeriod, getWallboardRefreshIntervalMs } from "../features/kpi/kpi-format";

export function WallBoardPage() {
  // Wallboard is shell-less kiosk UI, but its work-order/KPI data is tenant
  // scoped. AppRouter gates this page with ProtectedRoute before it mounts.
  const { api } = useAuth();
  const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
  const [kpiReport, setKpiReport] = useState<KpiReport>();
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      // The wallboard is a passive display, so a "load more" button makes no
      // sense — instead fetch every page so the exception/SLA counts reflect the
      // whole queue, not just the first 100 (which silently undercounts).
      const collectAllWorkOrders = async () => {
        const pageSize = 100;
        const collected: WorkOrderListItem[] = [];
        for (let offset = 0; ; offset += pageSize) {
          const response = await api.GET("/api/v1/work-orders", {
            params: { query: { limit: pageSize, offset } },
          });
          const items = response.data?.items ?? [];
          collected.push(...items);
          const total = response.data?.total ?? collected.length;
          if (collected.length >= total || items.length === 0) break;
        }
        return collected;
      };

      const [allWorkOrders, kpiResponse] = await Promise.all([
        collectAllWorkOrders(),
        api.GET("/api/v1/kpi", {
          params: { query: { period: getDefaultKpiPeriod() } },
        }),
      ]);
      setWorkOrders(allWorkOrders);
      if (kpiResponse.data) setKpiReport(kpiResponse.data);
    } finally {
      setIsLoading(false);
    }
  }, [api]);

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
