import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  listPlatformOrgs,
  setPlatformOrgStatus,
} from "../api/platform";
import type { OrgStatus, PlatformOrg } from "../api/platform";
import { Button } from "../components/ui/button";
import { PageError } from "../components/states/PageError";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { useAuth } from "../context/auth";
import { StatusChangeDialog } from "../features/platform/StatusChangeDialog";
import { TenantTable } from "../features/platform/TenantTable";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

interface PendingChange {
  org: PlatformOrg;
  next: OrgStatus;
}

export function PlatformTenantsPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;

  const [orgs, setOrgs] = useState<PlatformOrg[]>([]);
  const [listState, setListState] = useState<ReadState>("loading");
  const [pendingChange, setPendingChange] = useState<PendingChange | undefined>(
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
    </>
  );
}
