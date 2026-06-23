import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  listPlatformOrgs,
  removePlatformOrg,
  setPlatformOrgStatus,
  startViewAs,
} from "../api/platform";
import type { OrgStatus, PlatformOrg, ViewAsRole } from "../api/platform";
import { Button } from "../components/ui/button";
import { PageError } from "../components/states/PageError";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { useAuth } from "../context/auth";
import { RemoveTenantDialog } from "../features/platform/RemoveTenantDialog";
import { StatusChangeDialog } from "../features/platform/StatusChangeDialog";
import { TenantTable } from "../features/platform/TenantTable";
import { ViewAsDialog } from "../features/platform/ViewAsDialog";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

interface PendingChange {
  org: PlatformOrg;
  next: OrgStatus;
}

export function PlatformTenantsPage() {
  const { session, enterViewAs } = useAuth();
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
  const [pendingViewAs, setPendingViewAs] = useState<PlatformOrg | undefined>(
    undefined,
  );

  const loadOrgs = useCallback(async () => {
    setListState("loading");
    const result = await listPlatformOrgs(token).catch(() => undefined);
    if (!result) {
      setListState("error");
      return;
    }
    setOrgs(result);
    setListState("idle");
  }, [token]);

  useEffect(() => {
    void Promise.resolve().then(loadOrgs);
  }, [loadOrgs]);

  async function applyStatusChange(): Promise<void> {
    if (!pendingChange) return;
    const updated = await setPlatformOrgStatus(
      token,
      pendingChange.org.id,
      pendingChange.next,
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
    // surfaces the "archive instead" guidance and stays open. On success the
    // tenant is gone, so close and refresh from the server.
    await removePlatformOrg(token, pendingRemoval.id);
    setPendingRemoval(undefined);
    await loadOrgs();
  }

  async function startViewAsSession(role: ViewAsRole): Promise<void> {
    if (!pendingViewAs) return;
    // Mint the short-lived read-only impersonation token with the operator's
    // platform token. A failure (e.g. 409 not-active) is thrown to the dialog.
    const result = await startViewAs(token, {
      org_id: pendingViewAs.id,
      role,
    });
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
    void navigate("/dispatch");
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
        <TenantTable
          orgs={orgs}
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
        />
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
          onClose={() => {
            setPendingRemoval(undefined);
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
