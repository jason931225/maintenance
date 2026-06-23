import { useCallback, useEffect, useState } from "react";

import { getPlatformOps } from "../../api/platform";
import type { PlatformTenantHealth } from "../../api/platform";
import { PageError } from "../../components/states/PageError";
import { PageHeader } from "../../components/shell/PageHeader";
import { RefreshButton } from "../../components/shell/RefreshButton";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { orgStatusBadgeClass, orgStatusLabel } from "./org-status";

type ReadState = "idle" | "loading" | "error";

/** Format a tenant's last-activity timestamp, or a placeholder when none. */
function formatActivity(value: string | null): string {
  if (!value) return ko.platform.ops.noActivity;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return ko.platform.ops.noActivity;
  return date.toLocaleString("ko-KR");
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
          <TenantHealthTable tenants={tenants} />
        ) : readState === "loading" ? null : (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.platform.ops.empty}
          </p>
        )}
      </div>
    </>
  );
}

function TenantHealthTable({
  tenants,
}: {
  tenants: PlatformTenantHealth[];
}) {
  const cols = ko.platform.ops.columns;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[48rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-semibold text-steel">
            <th className="px-4 py-3">{cols.tenant}</th>
            <th className="px-4 py-3">{cols.status}</th>
            <th className="px-4 py-3 text-right">{cols.users}</th>
            <th className="px-4 py-3 text-right">{cols.activeUsers}</th>
            <th className="px-4 py-3 text-right">{cols.activeWorkOrders}</th>
            <th className="px-4 py-3 text-right">{cols.openWorkOrders}</th>
            <th className="px-4 py-3">{cols.lastActivity}</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tenant) => (
            <tr
              key={tenant.id}
              className="border-b border-line last:border-0"
            >
              <td className="px-4 py-3">
                <span className="font-medium text-ink">
                  {tenant.name}
                </span>
                <span className="ml-2 text-xs text-steel">
                  {tenant.slug}
                </span>
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
