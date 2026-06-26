import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  assignPlatformOrgToGroup,
  createPlatformGroup,
  listPlatformGroups,
  listPlatformOrgs,
  removePlatformOrgFromGroup,
  startTenantContext,
} from "../api/platform";
import type { PlatformGroup, PlatformOrg } from "../api/platform";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { useAuth } from "../context/auth";
import {
  orgStatusBadgeClass,
  orgStatusLabel,
} from "../features/platform/org-status";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function PlatformGroupsPage() {
  const { session, enterViewAs } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;

  const [groups, setGroups] = useState<PlatformGroup[]>([]);
  const [orgs, setOrgs] = useState<PlatformOrg[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selectedOrgByGroup, setSelectedOrgByGroup] = useState<
    Record<string, string>
  >({});

  const orgById = useMemo(
    () => new Map(orgs.map((org) => [org.id, org])),
    [orgs],
  );

  const load = useCallback(async () => {
    setReadState("loading");
    setError(undefined);
    const [groupResult, orgResult] = await Promise.all([
      listPlatformGroups(token).catch(() => undefined),
      listPlatformOrgs(token).catch(() => undefined),
    ]);
    if (!groupResult || !orgResult) {
      setReadState("error");
      return;
    }
    setGroups(groupResult);
    setOrgs(orgResult);
    setReadState("idle");
  }, [token]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function handleCreateGroup() {
    setError(undefined);
    const nextName = name.trim();
    const nextSlug = slug.trim();
    if (!nextName) {
      setError(ko.platform.groups.form.requiredName);
      return;
    }
    if (!SLUG_PATTERN.test(nextSlug)) {
      setError(ko.platform.groups.form.invalidSlug);
      return;
    }
    setPending(true);
    try {
      await createPlatformGroup(token, { name: nextName, slug: nextSlug });
      setName("");
      setSlug("");
      await load();
    } catch {
      setError(ko.platform.groups.form.createFailed);
    } finally {
      setPending(false);
    }
  }

  async function handleAssign(group: PlatformGroup) {
    const orgId = selectedOrgByGroup[group.id];
    if (!orgId) return;
    setError(undefined);
    setPending(true);
    try {
      await assignPlatformOrgToGroup(token, group.id, orgId);
      setSelectedOrgByGroup((current) => ({ ...current, [group.id]: "" }));
      await load();
    } catch {
      setError(ko.platform.groups.assignFailed);
    } finally {
      setPending(false);
    }
  }

  async function handleRemove(group: PlatformGroup, orgId: string) {
    setError(undefined);
    setPending(true);
    try {
      await removePlatformOrgFromGroup(token, group.id, orgId);
      await load();
    } catch {
      setError(ko.platform.groups.removeFailed);
    } finally {
      setPending(false);
    }
  }

  async function startManageOrg(org: PlatformOrg) {
    setError(undefined);
    try {
      const result = await startTenantContext(token, { org_id: org.id });
      enterViewAs({
        token: result.access_token,
        mode: "MANAGE",
        actingOrgId: result.acting_org_id,
        actingOrgName: result.acting_org_name,
        actingRole: result.acting_role,
      });
      void navigate("/settings/org");
    } catch {
      setError(ko.platform.tenantContext.failed);
    }
  }

  return (
    <>
      <PageHeader
        title={ko.platform.groups.title}
        description={ko.platform.groups.description}
        actions={
          <RefreshButton
            onClick={() => {
              void load();
            }}
            isLoading={readState === "loading"}
          />
        }
      />

      <div className="grid gap-5">
        {readState === "error" ? (
          <PageError
            message={ko.platform.groups.loadFailed}
            onRetry={() => {
              void load();
            }}
          />
        ) : null}
        {error ? <PageError message={error} /> : null}

        <Card className="grid gap-4 p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">
              {ko.platform.groups.form.title}
            </h2>
            <p className="mt-1 text-sm text-steel">
              {ko.platform.groups.form.description}
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <label className="grid gap-2 text-sm font-medium text-steel">
              {ko.platform.groups.form.name}
              <Input
                value={name}
                placeholder={ko.platform.groups.form.namePlaceholder}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                }}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-steel">
              {ko.platform.groups.form.slug}
              <Input
                value={slug}
                placeholder={ko.platform.groups.form.slugPlaceholder}
                onChange={(event) => {
                  setSlug(event.currentTarget.value);
                }}
              />
            </label>
            <Button
              type="button"
              onClick={() => {
                void handleCreateGroup();
              }}
              disabled={pending}
            >
              {pending
                ? ko.platform.groups.form.submitting
                : ko.platform.groups.form.submit}
            </Button>
          </div>
          <p className="text-xs text-steel">
            {ko.platform.groups.form.slugHint}
          </p>
        </Card>

        {readState === "loading" && groups.length === 0 ? (
          <SkeletonTable rows={4} cols={5} />
        ) : groups.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.platform.groups.empty}
          </p>
        ) : (
          <div className="grid gap-4">
            {groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                orgs={orgs}
                orgById={orgById}
                selectedOrgId={selectedOrgByGroup[group.id] ?? ""}
                pending={pending}
                onSelectOrg={(orgId) => {
                  setSelectedOrgByGroup((current) => ({
                    ...current,
                    [group.id]: orgId,
                  }));
                }}
                onAssign={() => {
                  void handleAssign(group);
                }}
                onRemove={(orgId) => {
                  void handleRemove(group, orgId);
                }}
                onManage={(org) => {
                  void startManageOrg(org);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function GroupCard({
  group,
  orgs,
  orgById,
  selectedOrgId,
  pending,
  onSelectOrg,
  onAssign,
  onRemove,
  onManage,
}: {
  group: PlatformGroup;
  orgs: PlatformOrg[];
  orgById: Map<string, PlatformOrg>;
  selectedOrgId: string;
  pending: boolean;
  onSelectOrg: (orgId: string) => void;
  onAssign: () => void;
  onRemove: (orgId: string) => void;
  onManage: (org: PlatformOrg) => void;
}) {
  const members = group.members;
  const assignableOrgs = orgs.filter((org) => org.group_id !== group.id);

  return (
    <Card className="grid gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{group.name}</h2>
            <Badge className={orgStatusBadgeClass(group.status)}>
              {orgStatusLabel(group.status)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-steel">
            {group.slug} ·{" "}
            {ko.platform.groups.memberCount.replace(
              "{count}",
              String(group.member_count),
            )}
          </p>
        </div>
        <div className="text-right text-xs text-steel">
          <p>{ko.platform.groups.viewModes}</p>
          <p>
            {ko.platform.scope.all} / {ko.platform.scope.groupPrefix} /{" "}
            {ko.platform.scope.orgPrefix}
          </p>
        </div>
      </div>

      <div className="grid gap-3 rounded-md border border-line bg-muted-panel p-3 md:grid-cols-[1fr_auto] md:items-end">
        <label className="grid gap-2 text-sm font-medium text-steel">
          {ko.platform.groups.assignLabel}
          <Select
            value={selectedOrgId}
            onChange={(event) => {
              onSelectOrg(event.currentTarget.value);
            }}
            disabled={pending || group.status !== "ACTIVE"}
          >
            <option value="">{ko.platform.groups.assignPlaceholder}</option>
            {assignableOrgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name} ({org.slug})
                {org.group_name ? ` · ${org.group_name}` : ""}
              </option>
            ))}
          </Select>
        </label>
        <Button
          type="button"
          variant="secondary"
          disabled={!selectedOrgId || pending || group.status !== "ACTIVE"}
          onClick={onAssign}
        >
          {ko.platform.groups.assignAction}
        </Button>
      </div>

      {members.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
          {ko.platform.groups.noMembers}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold text-steel">
                <th className="px-3 py-2">{ko.platform.groups.columns.org}</th>
                <th className="px-3 py-2">
                  {ko.platform.groups.columns.status}
                </th>
                <th className="px-3 py-2 text-right">
                  {ko.platform.groups.columns.actions}
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const org = orgById.get(member.id);
                return (
                  <tr
                    key={member.id}
                    className="border-b border-line last:border-0"
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium text-ink">
                        {member.name}
                      </span>
                      <span className="ml-2 text-xs text-steel">
                        {member.slug}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge className={orgStatusBadgeClass(member.status)}>
                        {orgStatusLabel(member.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-2">
                        {org && org.status === "ACTIVE" ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              onManage(org);
                            }}
                            disabled={pending}
                          >
                            {ko.platform.tenantContext.action}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            onRemove(member.id);
                          }}
                          disabled={pending}
                        >
                          {ko.platform.groups.removeAction}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
