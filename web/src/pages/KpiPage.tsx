import { useCallback, useEffect, useMemo, useState } from "react";

import type { KpiReport, OpsSummary } from "../api/types";
import { useAuth } from "../context/auth";
import {
  FEATURES,
  ROLES,
  hasAnyFeatureGrant,
  hasAnyRole,
  type Role,
} from "../components/shell/nav";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { DashboardScreen } from "../console/dashboard";
import { getDefaultKpiPeriod } from "../features/kpi/kpi-format";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

// Backend `OpsDashboardRead` matrix row [D,D,D,A,D,A]: ADMIN/SUPER_ADMIN only
// (EXECUTIVE holds KpiRead but is denied ops). Mirror it so a KPI-authorized
// EXECUTIVE never fires an ops/summary request that would 403 in the console.
const OPS_DASHBOARD_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.SUPER_ADMIN];

export function KpiPage() {
  const { api, session } = useAuth();
  const [kpiReport, setKpiReport] = useState<KpiReport>();
  const [opsSummary, setOpsSummary] = useState<OpsSummary>();
  const [kpiPeriod, setKpiPeriod] = useState(getDefaultKpiPeriod);
  const [readState, setReadState] = useState<ReadState>("loading");

  const canReadOps = useMemo(
    () =>
      hasAnyRole(session?.roles, OPS_DASHBOARD_ROLES) ||
      hasAnyFeatureGrant(session?.feature_grants, [FEATURES.OPS_DASHBOARD_READ]),
    [session?.roles, session?.feature_grants],
  );

  const loadData = useCallback(async (period: string) => {
    setReadState("loading");
    const [kpiResponse, opsResponse] = await Promise.all([
      api.GET("/api/v1/kpi", { params: { query: { period } } }).catch(
        () => undefined,
      ),
      // Ops stats are additive: a KPI-only viewer without ops access simply
      // gets no ops stats in the strip (honest omission, not a placeholder).
      // Only viewers holding OpsDashboardRead fire the request — otherwise it
      // would 403, and the strict console guard rejects the logged error.
      canReadOps
        ? api.GET("/api/v1/ops/summary", {}).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    if (!kpiResponse?.data) {
      setReadState("error");
      return;
    }
    setKpiReport(kpiResponse.data);
    setOpsSummary(opsResponse?.data);
    setReadState("idle");
  }, [api, canReadOps]);

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
