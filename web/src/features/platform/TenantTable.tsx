import type { OrgStatus, PlatformOrg } from "../../api/platform";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { PageEmpty } from "../../components/states/PageEmpty";
import { SkeletonTable } from "../../components/states/Skeleton";
import { ko } from "../../i18n/ko";
import { orgStatusBadgeClass, orgStatusLabel } from "./org-status";
import { platformGroupLabel } from "./scope";

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
  onRemove,
  onViewAs,
  onManage,
}: {
  orgs: PlatformOrg[];
  isLoading: boolean;
  onChangeStatus: (org: PlatformOrg, next: OrgStatus) => void;
  onRemove: (org: PlatformOrg) => void;
  onViewAs: (org: PlatformOrg) => void;
  onManage: (org: PlatformOrg) => void;
}) {
  // Keep existing rows visible on a refetch (stale-while-revalidate); only the
  // first load (no rows yet) shows the skeleton.
  if (isLoading && orgs.length === 0) {
    return <SkeletonTable rows={4} cols={6} />;
  }

  if (orgs.length === 0) {
    return <PageEmpty message={ko.platform.tenants.empty} />;
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold uppercase tracking-wider text-steel">
            <th className="px-4 py-3">{ko.platform.tenants.columns.slug}</th>
            <th className="px-4 py-3">{ko.platform.tenants.columns.name}</th>
            <th className="px-4 py-3">{ko.platform.tenants.columns.group}</th>
            <th className="px-4 py-3">{ko.platform.tenants.columns.status}</th>
            <th className="px-4 py-3">{ko.platform.tenants.columns.created}</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {orgs.map((org) => (
            <tr
              key={org.id}
              className="border-b border-line align-top last:border-0"
            >
              <td className="px-4 py-3 font-mono text-steel">{org.slug}</td>
              <td className="px-4 py-3 font-medium text-ink">{org.name}</td>
              <td className="px-4 py-3 text-steel">
                {platformGroupLabel(org)}
              </td>
              <td className="px-4 py-3">
                <Badge className={orgStatusBadgeClass(org.status)}>
                  {orgStatusLabel(org.status)}
                </Badge>
              </td>
              <td className="px-4 py-3 text-steel">
                {new Date(org.created_at).toLocaleDateString("ko-KR", {
                  dateStyle: "medium",
                })}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {/* Read-only "view as" — only for ACTIVE tenants (the backend
                      refuses impersonating a suspended/archived tenant). */}
                  {org.status === "ACTIVE" ? (
                    <>
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={() => {
                          onManage(org);
                        }}
                      >
                        {ko.platform.tenantContext.action}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          onViewAs(org);
                        }}
                      >
                        {ko.platform.viewAs.action}
                      </Button>
                    </>
                  ) : null}
                  {ACTIONS_BY_STATUS[org.status].map((next) => (
                    <Button
                      key={next}
                      type="button"
                      variant={
                        next === "ARCHIVED" ? "destructive" : "secondary"
                      }
                      size="sm"
                      onClick={() => {
                        onChangeStatus(org, next);
                      }}
                    >
                      {ko.platform.tenants.actionLabel[next]}
                    </Button>
                  ))}
                  {/* Hard-removal is a distinct, irreversible action — separate
                      from the suspend/archive status changes above. */}
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      onRemove(org);
                    }}
                  >
                    {ko.platform.tenants.removeLabel}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
