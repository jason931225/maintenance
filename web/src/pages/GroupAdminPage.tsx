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

  async function manageSubsidiary(member: GroupAdminMemberOrg) {
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
      void navigate("/settings/org");
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
          <p className="text-sm text-steel">
            {ko.groupAdmin.summary
              .replace("{groups}", String(groups.length))
              .replace("{members}", String(memberCount))}
          </p>
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
                        <td className="px-4 py-3 text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={manageOrgId === member.id}
                            onClick={() => {
                              void manageSubsidiary(member);
                            }}
                          >
                            {manageOrgId === member.id
                              ? ko.groupAdmin.managing
                              : ko.groupAdmin.manage}
                          </Button>
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
