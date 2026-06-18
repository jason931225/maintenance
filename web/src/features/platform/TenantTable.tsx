import type { OrgStatus, PlatformOrg } from "../../api/platform";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { PageEmpty } from "../../components/states/PageEmpty";
import { ko } from "../../i18n/ko";
import { orgStatusBadgeClass, orgStatusLabel } from "./org-status";

/** Status transitions offered per current status (consequential — confirmed). */
const ACTIONS_BY_STATUS: Record<OrgStatus, OrgStatus[]> = {
  ACTIVE: ["SUSPENDED", "ARCHIVED"],
  SUSPENDED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: ["ACTIVE"],
};

export function TenantTable({
  orgs,
  isLoading,
  onChangeStatus,
}: {
  orgs: PlatformOrg[];
  isLoading: boolean;
  onChangeStatus: (org: PlatformOrg, next: OrgStatus) => void;
}) {
  if (isLoading) {
    return (
      <Card>
        <p role="status" className="text-sm font-medium text-slate-700">
          {ko.common.loading}
        </p>
      </Card>
    );
  }

  if (orgs.length === 0) {
    return <PageEmpty message={ko.platform.tenants.empty} />;
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <th className="px-4 py-3">{ko.platform.tenants.columns.slug}</th>
            <th className="px-4 py-3">{ko.platform.tenants.columns.name}</th>
            <th className="px-4 py-3">{ko.platform.tenants.columns.status}</th>
            <th className="px-4 py-3">{ko.platform.tenants.columns.created}</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {orgs.map((org) => (
            <tr
              key={org.id}
              className="border-b border-slate-100 align-top last:border-0"
            >
              <td className="px-4 py-3 font-mono text-slate-700">{org.slug}</td>
              <td className="px-4 py-3 font-medium text-slate-950">
                {org.name}
              </td>
              <td className="px-4 py-3">
                <Badge className={orgStatusBadgeClass(org.status)}>
                  {orgStatusLabel(org.status)}
                </Badge>
              </td>
              <td className="px-4 py-3 text-slate-600">
                {new Date(org.created_at).toLocaleDateString("ko-KR", {
                  dateStyle: "medium",
                })}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {ACTIONS_BY_STATUS[org.status].map((next) => (
                    <Button
                      key={next}
                      type="button"
                      variant={next === "ARCHIVED" ? "destructive" : "secondary"}
                      size="sm"
                      onClick={() => {
                        onChangeStatus(org, next);
                      }}
                    >
                      {ko.platform.tenants.actionLabel[next]}
                    </Button>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
