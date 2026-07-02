import { useCallback, useEffect, useState } from "react";

import type { KpiReport } from "../api/types";
import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { KpiDashboard } from "../features/kpi/KpiDashboard";
import { getDefaultKpiPeriod } from "../features/kpi/kpi-format";
import { ko } from "../i18n/ko";
import { devKpiReport, isDevPreviewEnabled } from "../lib/dev-preview";

type ReadState = "idle" | "loading" | "error";

export function KpiPage() {
  const { api } = useAuth();
  const [kpiReport, setKpiReport] = useState<KpiReport>();
  const [kpiPeriod, setKpiPeriod] = useState(getDefaultKpiPeriod);
  const [readState, setReadState] = useState<ReadState>("loading");

  const loadData = useCallback(async (period: string) => {
    setReadState("loading");
    if (isDevPreviewEnabled()) {
      const [start, end] = period.split("..");
      const report = devKpiReport();
      setKpiReport({
        ...report,
        period: {
          start: start ? `${start}T00:00:00Z` : report.period.start,
          end: end ? `${end}T00:00:00Z` : report.period.end,
        },
      });
      setReadState("idle");
      return;
    }
    const response = await api.GET("/api/v1/kpi", {
      params: { query: { period } },
    }).catch(() => undefined);
    if (!response?.data) {
      setReadState("error");
      return;
    }
    setKpiReport(response.data);
    setReadState("idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(() => loadData(kpiPeriod));
  }, [loadData, kpiPeriod]);

  function handlePeriodChange(nextPeriod: string) {
    setKpiPeriod(nextPeriod);
  }

  return (
    <>
      <PageHeader
        title={ko.kpi.title}
        description={ko.kpi.description}
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
        <KpiDashboard
          isLoading={readState === "loading"}
          period={kpiPeriod}
          report={kpiReport}
          onPeriodChange={handlePeriodChange}
        />
      </div>
    </>
  );
}
