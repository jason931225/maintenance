import { useCallback, useEffect, useMemo, useState } from "react";

import { getPlatformOps } from "../../api/platform";
import type { PlatformTenantHealth } from "../../api/platform";
import { PageError } from "../../components/states/PageError";
import { SkeletonTable } from "../../components/states/Skeleton";
import { PageHeader } from "../../components/shell/PageHeader";
import { RefreshButton } from "../../components/shell/RefreshButton";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { orgStatusBadgeClass, orgStatusLabel } from "./org-status";
import {
  buildPlatformScopeOptions,
  filterByPlatformScope,
  platformGroupLabel,
  type PlatformScopeValue,
} from "./scope";

type ReadState = "idle" | "loading" | "error";

/** Format a tenant's last-activity timestamp (KST), or a placeholder when none. */
function formatActivity(value: string | null): string {
  if (!value) return ko.platform.ops.noActivity;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return ko.platform.ops.noActivity;
  return formatKoreanDateTime(value);
}

function formatRouteAdoption(tenant: PlatformTenantHealth): string {
  const metric = tenant.route_adoption.at(0);
  if (!metric) return ko.platform.ops.routeAdoption.none;

  const labels = ko.platform.ops.routeAdoption;
  const perf =
    metric.rum_perf_p95_ms == null
      ? labels.noPerf
      : `${labels.p95} ${String(metric.rum_perf_p95_ms)}ms`;

  return [
    metric.release_cycle,
    `${labels.console} ${String(metric.console_route_events)} / ${labels.legacy} ${String(metric.legacy_route_events)}`,
    `${labels.errors} ${String(metric.rum_error_events)}`,
    perf,
    `${labels.zeroLegacyCycles} ${String(tenant.zero_legacy_release_cycles)}`,
  ].join(" · ");
}

/**
 * Platform ops dashboard: a cross-tenant health/usage table. Reads the audited
 * `GET /api/platform/ops` endpoint (platform token only) and lists every tenant
 * with its user counts, active/open work-order counts, and last activity.
 */
export function PlatformOpsPage() {
  const { session } = useAuth();
  const token = session?.access_token;

  const [tenants, setTenants] = useState<PlatformTenantHealth[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [scope, setScope] = useState<PlatformScopeValue>("all");

  const scopeOptions = useMemo(
    () => buildPlatformScopeOptions(tenants),
    [tenants],
  );
  const selectedScope = useMemo(
    () =>
      scopeOptions.some((option) => option.value === scope) ? scope : "all",
    [scope, scopeOptions],
  );
  const visibleTenants = useMemo(
    () => filterByPlatformScope(tenants, selectedScope),
    [tenants, selectedScope],
  );

  const loadOps = useCallback(async () => {
    setReadState("loading");
    const result = await getPlatformOps(token).catch(() => undefined);
    if (!result) {
      setReadState("error");
      return;
    }
    setTenants(result);
    setReadState("idle");
  }, [token]);

  useEffect(() => {
    void Promise.resolve().then(loadOps);
  }, [loadOps]);

  return (
    <>
      <PageHeader
        title={ko.platform.ops.title}
        description={ko.platform.ops.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadOps();
            }}
            isLoading={readState === "loading"}
          />
        }
      />
      <div className="grid gap-5">
        {readState === "error" ? (
          <PageError
            message={ko.platform.ops.loadFailed}
            onRetry={() => {
              void loadOps();
            }}
          />
        ) : null}
        {tenants.length > 0 ? (
          <>
            <div className="max-w-md">
              <label
                className="mb-2 block text-sm font-medium text-steel"
                htmlFor="platform-ops-scope"
              >
                {ko.platform.scope.label}
              </label>
              <Select
                id="platform-ops-scope"
                value={selectedScope}
                onChange={(event) => {
                  setScope(event.currentTarget.value as PlatformScopeValue);
                }}
              >
                {scopeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <TenantHealthTable tenants={visibleTenants} />
          </>
        ) : readState === "loading" ? (
          <SkeletonTable rows={4} cols={8} />
        ) : (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.platform.ops.empty}
          </p>
        )}
      </div>
    </>
  );
}

function TenantHealthTable({ tenants }: { tenants: PlatformTenantHealth[] }) {
  const cols = ko.platform.ops.columns;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[48rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-semibold text-steel">
            <th className="px-4 py-3">{cols.tenant}</th>
            <th className="px-4 py-3">{cols.group}</th>
            <th className="px-4 py-3">{cols.status}</th>
            <th className="px-4 py-3 text-right">{cols.users}</th>
            <th className="px-4 py-3 text-right">{cols.activeUsers}</th>
            <th className="px-4 py-3 text-right">{cols.activeWorkOrders}</th>
            <th className="px-4 py-3 text-right">{cols.openWorkOrders}</th>
            <th className="px-4 py-3">{cols.routeAdoption}</th>
            <th className="px-4 py-3">{cols.lastActivity}</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tenant) => (
            <tr key={tenant.id} className="border-b border-line last:border-0">
              <td className="px-4 py-3">
                <span className="font-medium text-ink">{tenant.name}</span>
                <span className="ml-2 text-xs text-steel">{tenant.slug}</span>
              </td>
              <td className="px-4 py-3 text-steel">
                {platformGroupLabel(tenant)}
              </td>
              <td className="px-4 py-3">
                <Badge className={orgStatusBadgeClass(tenant.status)}>
                  {orgStatusLabel(tenant.status)}
                </Badge>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-steel">
                {tenant.user_count}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-steel">
                {tenant.active_user_count}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-steel">
                {tenant.active_work_orders}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-steel">
                {tenant.open_work_orders}
              </td>
              <td className="max-w-xs px-4 py-3 text-xs text-steel">
                {formatRouteAdoption(tenant)}
              </td>
              <td className="px-4 py-3 text-steel">
                {formatActivity(tenant.last_activity_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
