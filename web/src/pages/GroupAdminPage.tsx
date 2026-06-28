import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  listGroupAdminGroups,
  startGroupTenantContext,
  type GroupAdminGroup,
  type GroupAdminMemberOrg,
} from "../api/groupAdmin";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

type ReadState = "loading" | "idle" | "error";
type GroupAdminDestination = "/settings/org" | "/approvals" | "/daily-plan" | "/work-hub";

export function GroupAdminPage() {
  const { session, enterViewAs } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;
  const [groups, setGroups] = useState<GroupAdminGroup[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [manageOrgId, setManageOrgId] = useState<string | undefined>();
  const [manageError, setManageError] = useState<string | undefined>();

  const memberCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.members.length, 0),
    [groups],
  );
  const groupOverview = useMemo(
    () =>
      groups.map((group) => {
        const activeCount = group.members.filter(
          (member) => member.status === "ACTIVE",
        ).length;
        return {
          group,
          activeCount,
          attentionCount: group.members.length - activeCount,
        };
      }),
    [groups],
  );

  const load = useCallback(async () => {
    setReadState("loading");
    setManageError(undefined);
    try {
      const result = await listGroupAdminGroups(token);
      setGroups(result);
      setReadState("idle");
    } catch {
      setReadState("error");
    }
  }, [token]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function manageSubsidiary(
    member: GroupAdminMemberOrg,
    destination: GroupAdminDestination,
  ) {
    setManageOrgId(member.id);
    setManageError(undefined);
    try {
      const result = await startGroupTenantContext(token, member.id);
      enterViewAs({
        token: result.access_token,
        mode: "MANAGE",
        source: "GROUP_ADMIN",
        actingOrgId: result.acting_org_id,
        actingOrgName: result.acting_org_name,
        actingRole: result.acting_role,
      });
      void navigate(destination);
    } catch {
      setManageError(ko.groupAdmin.manageFailed);
    } finally {
      setManageOrgId(undefined);
    }
  }

  return (
    <>
      <PageHeader
        title={ko.groupAdmin.title}
        description={ko.groupAdmin.description}
        actions={
          <RefreshButton
            onClick={() => {
              void load();
            }}
            isLoading={readState === "loading"}
          />
        }
      />

      {manageError ? <PageError message={manageError} /> : null}

      {readState === "loading" ? <SkeletonTable rows={4} cols={4} /> : null}
      {readState === "error" ? (
        <PageError
          message={ko.groupAdmin.loadFailed}
          onRetry={() => {
            void load();
          }}
        />
      ) : null}
      {readState === "idle" && groups.length === 0 ? (
        <Card>
          <p className="text-sm text-steel">{ko.groupAdmin.empty}</p>
        </Card>
      ) : null}
      {readState === "idle" && groups.length > 0 ? (
        <div className="grid gap-5">
          <Card className="grid gap-3 border-brand-teal/20 bg-brand-teal/5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-brand-teal">
                  {ko.groupAdmin.command.eyebrow}
                </p>
                <h2 className="mt-1 text-lg font-semibold text-ink">
                  {ko.groupAdmin.command.title}
                </h2>
                <p className="mt-1 max-w-3xl text-sm text-steel">
                  {ko.groupAdmin.command.description}
                </p>
              </div>
              <p className="rounded-full border border-brand-teal/20 bg-white px-3 py-1 text-sm font-semibold text-brand-teal">
                {ko.groupAdmin.summary
                  .replace("{groups}", String(groups.length))
                  .replace("{members}", String(memberCount))}
              </p>
            </div>
            <div className="grid gap-2 rounded-lg border border-line bg-white p-3 text-sm text-steel md:grid-cols-3">
              {ko.groupAdmin.command.principles.map((principle) => (
                <div key={principle.title}>
                  <p className="font-semibold text-ink">{principle.title}</p>
                  <p className="mt-1">{principle.description}</p>
                </div>
              ))}
            </div>
          </Card>
          <Card
            role="region"
            aria-labelledby="group-admin-overview-title"
            className="grid gap-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-brand-teal">
                  {ko.groupAdmin.overview.eyebrow}
                </p>
                <h2
                  id="group-admin-overview-title"
                  className="mt-1 text-lg font-semibold text-ink"
                >
                  {ko.groupAdmin.overview.title}
                </h2>
                <p className="mt-1 max-w-3xl text-sm text-steel">
                  {ko.groupAdmin.overview.description}
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-line text-sm">
                <thead className="bg-muted-panel/50 text-left text-xs font-semibold uppercase tracking-wide text-steel">
                  <tr>
                    <th className="px-4 py-3">
                      {ko.groupAdmin.overview.columns.group}
                    </th>
                    <th className="px-4 py-3">
                      {ko.groupAdmin.overview.columns.total}
                    </th>
                    <th className="px-4 py-3">
                      {ko.groupAdmin.overview.columns.health}
                    </th>
                    <th className="px-4 py-3">
                      {ko.groupAdmin.overview.columns.subsidiaries}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-white">
                  {groupOverview.map(({ group, activeCount, attentionCount }) => (
                    <tr key={group.id}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-ink">{group.name}</p>
                        <p className="text-xs text-steel">{group.slug}</p>
                      </td>
                      <td className="px-4 py-3 text-steel">
                        {ko.groupAdmin.overview.total
                          .replace("{count}", String(group.members.length))}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2 text-xs font-semibold">
                          <span className="rounded-full border border-brand-teal/20 bg-brand-teal/5 px-2 py-1 text-brand-teal">
                            {ko.groupAdmin.overview.active
                              .replace("{count}", String(activeCount))}
                          </span>
                          <span className="rounded-full border border-line bg-muted-panel px-2 py-1 text-steel">
                            {ko.groupAdmin.overview.attention
                              .replace("{count}", String(attentionCount))}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {group.members.map((member) => (
                            <span
                              key={member.id}
                              className="rounded-full border border-line bg-white px-2 py-1 text-xs font-semibold text-ink"
                            >
                              {member.name}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {groups.map((group) => (
            <Card key={group.id} className="overflow-hidden p-0">
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-lg font-semibold text-ink">
                  {group.name}
                </h2>
                <p className="text-sm text-steel">
                  {group.slug} · {group.members.length}
                  {ko.groupAdmin.memberCountSuffix}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-line text-sm">
                  <thead className="bg-muted-panel/50 text-left text-xs font-semibold uppercase tracking-wide text-steel">
                    <tr>
                      <th className="px-4 py-3">{ko.groupAdmin.columns.name}</th>
                      <th className="px-4 py-3">{ko.groupAdmin.columns.slug}</th>
                      <th className="px-4 py-3">
                        {ko.groupAdmin.columns.status}
                      </th>
                      <th className="px-4 py-3 text-right">
                        {ko.groupAdmin.columns.actions}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line bg-white">
                    {group.members.map((member) => (
                      <tr key={member.id}>
                        <td className="px-4 py-3 font-medium text-ink">
                          {member.name}
                        </td>
                        <td className="px-4 py-3 text-steel">{member.slug}</td>
                        <td className="px-4 py-3 text-steel">
                          {member.status}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              disabled={manageOrgId === member.id}
                              aria-label={`${member.name} ${ko.groupAdmin.actions.workHub}`}
                              onClick={() => {
                                void manageSubsidiary(member, "/work-hub");
                              }}
                            >
                              {manageOrgId === member.id
                                ? ko.groupAdmin.managing
                                : ko.groupAdmin.actions.workHub}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={manageOrgId === member.id}
                              aria-label={`${member.name} ${ko.groupAdmin.actions.org}`}
                              onClick={() => {
                                void manageSubsidiary(member, "/settings/org");
                              }}
                            >
                              {ko.groupAdmin.actions.org}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={manageOrgId === member.id}
                              aria-label={`${member.name} ${ko.groupAdmin.actions.approvals}`}
                              onClick={() => {
                                void manageSubsidiary(member, "/approvals");
                              }}
                            >
                              {ko.groupAdmin.actions.approvals}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={manageOrgId === member.id}
                              aria-label={`${member.name} ${ko.groupAdmin.actions.dailyPlan}`}
                              onClick={() => {
                                void manageSubsidiary(member, "/daily-plan");
                              }}
                            >
                              {ko.groupAdmin.actions.dailyPlan}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      ) : null}
    </>
  );
}
