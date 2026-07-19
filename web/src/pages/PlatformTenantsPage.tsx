import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  forceRemovePlatformOrg,
  listPlatformOrgs,
  removePlatformOrg,
  setPlatformOrgStatus,
  startTenantContext,
  startViewAs,
} from "../api/platform";
import type { OrgStatus, PlatformOrg, ViewAsRole } from "../api/platform";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { PageError } from "../components/states/PageError";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { useAuth } from "../context/auth";
import { ForceRemoveTenantDialog } from "../features/platform/ForceRemoveTenantDialog";
import { RemoveTenantDialog } from "../features/platform/RemoveTenantDialog";
import { StatusChangeDialog } from "../features/platform/StatusChangeDialog";
import { TenantTable } from "../features/platform/TenantTable";
import { ViewAsDialog } from "../features/platform/ViewAsDialog";
import {
  buildPlatformScopeOptions,
  filterByPlatformScope,
  type PlatformScopeValue,
} from "../features/platform/scope";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

interface PendingChange {
  org: PlatformOrg;
  next: OrgStatus;
}

export function PlatformTenantsPage() {
  const { session, enterViewAs, refreshAuthority } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;

  const [orgs, setOrgs] = useState<PlatformOrg[]>([]);
  const [listState, setListState] = useState<ReadState>("loading");
  const [pendingChange, setPendingChange] = useState<PendingChange | undefined>(
    undefined,
  );
  const [pendingRemoval, setPendingRemoval] = useState<PlatformOrg | undefined>(
    undefined,
  );
  // The DESTRUCTIVE force-removal flow, entered only from the guarded dialog
  // after the guarded remove is refused (the tenant has real data).
  const [pendingForceRemoval, setPendingForceRemoval] = useState<
    PlatformOrg | undefined
  >(undefined);
  const [pendingViewAs, setPendingViewAs] = useState<PlatformOrg | undefined>(
    undefined,
  );
  const [manageError, setManageError] = useState<string | undefined>(undefined);
  const [scope, setScope] = useState<PlatformScopeValue>("all");

  const scopeOptions = useMemo(() => buildPlatformScopeOptions(orgs), [orgs]);
  const selectedScope = useMemo(
    () =>
      scopeOptions.some((option) => option.value === scope) ? scope : "all",
    [scope, scopeOptions],
  );
  const visibleOrgs = useMemo(
    () => filterByPlatformScope(orgs, selectedScope),
    [orgs, selectedScope],
  );

  const loadOrgs = useCallback(async () => {
    setListState("loading");
    const result = await listPlatformOrgs(token, refreshAuthority).catch(() => undefined);
    if (!result) {
      setListState("error");
      return;
    }
    setOrgs(result);
    setListState("idle");
  }, [refreshAuthority, token]);

  useEffect(() => {
    void Promise.resolve().then(loadOrgs);
  }, [loadOrgs]);

  async function applyStatusChange(): Promise<void> {
    if (!pendingChange) return;
    const updated = await setPlatformOrgStatus(
      token,
      pendingChange.org.id,
      pendingChange.next,
      refreshAuthority,
    );
    // Optimistically reflect the returned org, then close the dialog and refresh
    // from the server so the list stays authoritative.
    setOrgs((current) =>
      current.map((org) => (org.id === updated.id ? updated : org)),
    );
    setPendingChange(undefined);
    await loadOrgs();
  }

  async function applyRemoval(): Promise<void> {
    if (!pendingRemoval) return;
    // A 409 (tenant has data) / 404 / failure is thrown to the dialog, which
    // surfaces the "archive instead" guidance (and, on 409, reveals the force
    // escape) and stays open. On success the tenant is gone, so close and refresh.
    await removePlatformOrg(token, pendingRemoval.id, refreshAuthority);
    setPendingRemoval(undefined);
    await loadOrgs();
  }

  async function applyForceRemoval(): Promise<void> {
    if (!pendingForceRemoval) return;
    // The DESTRUCTIVE path: erase the tenant AND all its data. A 409
    // (`tenant_active`, not archived) / 404 / failure is thrown to the force
    // dialog, which surfaces the "archive first" guidance and stays open. On
    // success the tenant is gone, so close and refresh from the server.
    await forceRemovePlatformOrg(token, pendingForceRemoval.id, refreshAuthority);
    setPendingForceRemoval(undefined);
    await loadOrgs();
  }

  async function startViewAsSession(role: ViewAsRole): Promise<void> {
    if (!pendingViewAs) return;
    // Mint the short-lived read-only impersonation token with the operator's
    // platform token. A failure (e.g. 409 not-active) is thrown to the dialog.
    const result = await startViewAs(
      token,
      { org_id: pendingViewAs.id, role },
      refreshAuthority,
    );
    // Switch the app into the tenant view: store the view_as token + platform
    // session, then navigate into the tenant shell. The persistent banner is
    // rendered by AppShell while impersonating.
    enterViewAs({
      token: result.access_token,
      actingOrgId: result.acting_org_id,
      actingOrgName: result.acting_org_name,
      actingRole: result.acting_role,
    });
    setPendingViewAs(undefined);
    void navigate("/overview");
  }

  async function startManageTenantSession(org: PlatformOrg): Promise<void> {
    setManageError(undefined);
    const result = await startTenantContext(
      token,
      { org_id: org.id },
      refreshAuthority,
    );
    enterViewAs({
      token: result.access_token,
      mode: "MANAGE",
      actingOrgId: result.acting_org_id,
      actingOrgName: result.acting_org_name,
      actingRole: result.acting_role,
    });
    void navigate("/settings/org");
  }

  return (
    <>
      <PageHeader
        title={ko.platform.tenants.title}
        description={ko.platform.tenants.description}
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void navigate("/platform/onboard");
              }}
            >
              {ko.platform.tenants.onboardCta}
            </Button>
            <RefreshButton
              onClick={() => {
                void loadOrgs();
              }}
              isLoading={listState === "loading"}
            />
          </>
        }
      />

      {listState === "error" ? (
        <PageError
          message={ko.platform.tenants.loadFailed}
          onRetry={() => {
            void loadOrgs();
          }}
        />
      ) : (
        <>
          {manageError ? <PageError message={manageError} /> : null}
          {orgs.length > 0 ? (
            <div className="mb-4 max-w-md">
              <label
                className="mb-2 block text-sm font-medium text-steel"
                htmlFor="platform-tenant-scope"
              >
                {ko.platform.scope.label}
              </label>
              <Select
                id="platform-tenant-scope"
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
          ) : null}
          <TenantTable
            orgs={visibleOrgs}
            isLoading={listState === "loading"}
            onChangeStatus={(org, next) => {
              setPendingChange({ org, next });
            }}
            onRemove={(org) => {
              setPendingRemoval(org);
            }}
            onViewAs={(org) => {
              setPendingViewAs(org);
            }}
            onManage={(org) => {
              void startManageTenantSession(org).catch(() => {
                setManageError(ko.platform.tenantContext.failed);
              });
            }}
          />
        </>
      )}

      {pendingChange ? (
        <StatusChangeDialog
          org={pendingChange.org}
          next={pendingChange.next}
          onConfirm={applyStatusChange}
          onClose={() => {
            setPendingChange(undefined);
          }}
        />
      ) : null}

      {pendingRemoval ? (
        <RemoveTenantDialog
          org={pendingRemoval}
          onConfirm={applyRemoval}
          onForceRequested={() => {
            // Hand off from the guarded dialog to the destructive force flow.
            setPendingForceRemoval(pendingRemoval);
            setPendingRemoval(undefined);
          }}
          onClose={() => {
            setPendingRemoval(undefined);
          }}
        />
      ) : null}

      {pendingForceRemoval ? (
        <ForceRemoveTenantDialog
          org={pendingForceRemoval}
          onConfirm={applyForceRemoval}
          onClose={() => {
            setPendingForceRemoval(undefined);
          }}
        />
      ) : null}

      {pendingViewAs ? (
        <ViewAsDialog
          org={pendingViewAs}
          onConfirm={startViewAsSession}
          onClose={() => {
            setPendingViewAs(undefined);
          }}
        />
      ) : null}
    </>
  );
}
