import { useCallback, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  listGroupAdminGroups,
  startGroupTenantContext,
  type GroupAdminGroup,
  type GroupAdminMemberOrg,
} from "../api/groupAdmin";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { visibleNavItemsForRoles } from "../components/shell/nav";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

type ReadState = "loading" | "idle" | "error";
type GroupAdminDestination = string;

const GROUP_ADMIN_HIDDEN_MODULE_KEYS = new Set([
  // The source group console and personal profile are already available outside a
  // subsidiary context. Policy/integrity stay hidden because a delegated ADMIN
  // tenant context does not carry SUPER_ADMIN/EXECUTIVE authority.
  "group",
  "profile",
  "policy",
  "integrity",
]);

interface GroupAdminModule {
  key: string;
  label: string;
  href: string;
  Icon: LucideIcon;
}

interface GroupAdminModuleGroup {
  key: string;
  label: string;
  modules: GroupAdminModule[];
}

function labelForKey(labelKey: string): string {
  if (!labelKey.startsWith("nav.")) return labelKey;
  const path = labelKey.slice("nav.".length).split(".");
  let value: unknown = ko.nav;
  for (const part of path) {
    if (!value || typeof value !== "object" || !(part in value)) {
      return labelKey;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : labelKey;
}

function buildGroupAdminModuleGroups(): GroupAdminModuleGroup[] {
  const groups: GroupAdminModuleGroup[] = [];
  for (const item of visibleNavItemsForRoles(["ADMIN"], ["GROUP_ADMIN"])) {
    if (GROUP_ADMIN_HIDDEN_MODULE_KEYS.has(item.key)) continue;
    let group = groups.find((candidate) => candidate.key === item.groupKey);
    if (!group) {
      group = {
        key: item.groupKey,
        label: labelForKey(item.groupLabelKey),
        modules: [],
      };
      groups.push(group);
    }
    group.modules.push({
      key: item.key,
      label: labelForKey(item.labelKey),
      href: item.href,
      Icon: item.Icon,
    });
  }
  return groups;
}

const GROUP_ADMIN_MODULE_GROUPS = buildGroupAdminModuleGroups();

export function GroupAdminPage() {
  const { session, enterViewAs, viewAs } = useAuth();
  const navigate = useNavigate();
  const groupAdminToken =
    viewAs?.source === "GROUP_ADMIN"
      ? viewAs.platformSession.access_token
      : session?.access_token;
  const [groups, setGroups] = useState<GroupAdminGroup[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [manageOrgId, setManageOrgId] = useState<string | undefined>();
  const [manageError, setManageError] = useState<string | undefined>();
  const [openActionMenu, setOpenActionMenu] = useState<string | undefined>();

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
      const result = await listGroupAdminGroups(groupAdminToken);
      setGroups(result);
      setReadState("idle");
    } catch {
      setReadState("error");
    }
  }, [groupAdminToken]);

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
      const result = await startGroupTenantContext(groupAdminToken, member.id);
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
                        <td className="px-4 py-3 align-top">
                          <div className="flex flex-wrap justify-end gap-2">
                            {GROUP_ADMIN_MODULE_GROUPS.map((moduleGroup) => {
                              const menuKey = `${member.id}:${moduleGroup.key}`;
                              const menuOpen = openActionMenu === menuKey;
                              return (
                                <div
                                  key={moduleGroup.key}
                                  className="relative grid justify-items-end gap-2"
                                >
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant={menuOpen ? "default" : "secondary"}
                                    className="whitespace-normal text-left leading-snug"
                                    aria-expanded={menuOpen}
                                    aria-haspopup="true"
                                    aria-label={ko.groupAdmin.actionMenuLabel
                                      .replace("{org}", member.name)
                                      .replace("{group}", moduleGroup.label)}
                                    onClick={() => {
                                      setOpenActionMenu(
                                        menuOpen ? undefined : menuKey,
                                      );
                                    }}
                                  >
                                    <span>{moduleGroup.label}</span>
                                    <span aria-hidden="true">
                                      {menuOpen ? "▴" : "▾"}
                                    </span>
                                  </Button>
                                  {menuOpen ? (
                                    <div className="grid w-64 gap-1 rounded-md border border-line bg-white p-2 text-left shadow-sm">
                                      {moduleGroup.modules.map((module) => {
                                        const Icon = module.Icon;
                                        return (
                                          <Button
                                            key={module.key}
                                            type="button"
                                            size="xs"
                                            variant={
                                              module.key === "overview"
                                                ? "default"
                                                : "secondary"
                                            }
                                            className="w-full justify-start whitespace-normal text-left leading-snug"
                                            disabled={manageOrgId === member.id}
                                            aria-label={`${member.name} ${module.label}`}
                                            onClick={() => {
                                              void manageSubsidiary(
                                                member,
                                                module.href,
                                              );
                                            }}
                                          >
                                            <Icon
                                              aria-hidden="true"
                                              className="h-4 w-4 shrink-0"
                                            />
                                            <span>
                                              {manageOrgId === member.id &&
                                              module.key === "overview"
                                                ? ko.groupAdmin.managing
                                                : module.label}
                                            </span>
                                          </Button>
                                        );
                                      })}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
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
