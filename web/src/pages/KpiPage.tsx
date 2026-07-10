import { useCallback, useEffect, useState } from "react";

import type { KpiReport, OpsSummary } from "../api/types";
import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { DashboardScreen } from "../console/dashboard";
import { getDefaultKpiPeriod } from "../features/kpi/kpi-format";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

export function KpiPage() {
  const { api } = useAuth();
  const [kpiReport, setKpiReport] = useState<KpiReport>();
  const [opsSummary, setOpsSummary] = useState<OpsSummary>();
  const [kpiPeriod, setKpiPeriod] = useState(getDefaultKpiPeriod);
  const [readState, setReadState] = useState<ReadState>("loading");

  const loadData = useCallback(async (period: string) => {
    setReadState("loading");
    const [kpiResponse, opsResponse] = await Promise.all([
      api.GET("/api/v1/kpi", { params: { query: { period } } }).catch(
        () => undefined,
      ),
      // Ops stats are additive: a KPI-only viewer without ops access simply
      // gets no ops stats in the strip (honest omission, not a placeholder).
      api.GET("/api/v1/ops/summary", {}).catch(() => undefined),
    ]);
    if (!kpiResponse?.data) {
      setReadState("error");
      return;
    }
    setKpiReport(kpiResponse.data);
    setOpsSummary(opsResponse?.data);
    setReadState("idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(() => loadData(kpiPeriod));
  }, [loadData, kpiPeriod]);

  return (
    <>
      <PageHeader
        title={ko.kpi.title}
        actions={
          <RefreshButton
            onClick={() => { void loadData(kpiPeriod); }}
            isLoading={readState === "loading"}
          />
        }
      />
      <div className="grid gap-5">
        {readState === "error" ? (
          <PageError onRetry={() => { void loadData(kpiPeriod); }} />
        ) : null}
        <DashboardScreen
          report={kpiReport}
          opsSummary={opsSummary}
          period={kpiPeriod}
          isLoading={readState === "loading"}
          onPeriodChange={setKpiPeriod}
        />
      </div>
    </>
  );
}
