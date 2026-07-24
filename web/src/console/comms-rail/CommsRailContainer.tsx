import { useEffect, useMemo, useState } from "react";

import { useAuth, type AuthSession, type ViewAsState } from "../../context/auth";
import { CommsRailView, type CommsRailViewProps } from "./view/CommsRailView";
import { CommsRailStore } from "./store";
import { createAuthenticatedCommsRailApi } from "./transport";
import { loadingCommsRailSnapshot, type CommsRailSnapshot } from "./model";

function authScope(session: AuthSession | undefined, viewAs: ViewAsState | undefined): string {
  if (!session) return "signed-out";
  const policy = session.policy_projection;
  return JSON.stringify({
    token: session.access_token,
    userId: session.user_id ?? null,
    organizationId: session.org_id ?? null,
    roles: [...(session.roles ?? [])].sort(),
    groupRoles: [...(session.group_roles ?? [])].sort(),
    branchIds: [...(session.branches ?? [])].sort(),
    featureGrants: [...(session.feature_grants ?? [])].sort(),
    policy: policy ? {
      version: policy.policy_version ?? null,
      subjectVersion: policy.subject_version ?? null,
      engineMode: policy.engine_mode ?? null,
      bundleDigest: policy.bundle_digest ?? null,
      stale: policy.stale === true,
      grants: [...(policy.feature_grants ?? [])].sort(),
      decisions: [...(policy.elevated_decisions ?? [])].sort(),
    } : null,
    passkeyRequired: session.requires_passkey_setup === true,
    platform: session.isPlatform === true,
    viewAs: viewAs ? {
      mode: viewAs.mode ?? null,
      source: viewAs.source ?? null,
      organizationId: viewAs.actingOrgId,
      role: viewAs.actingRole,
    } : null,
  });
}

type PersistentRailProps = Omit<Extract<CommsRailViewProps, { presentation?: "persistent" }>, "snapshot" | "onRetry" | "retryingSource" | "onAction">;
type DrawerRailProps = Omit<Extract<CommsRailViewProps, { presentation: "drawer" }>, "snapshot" | "onRetry" | "retryingSource" | "onAction">;

export interface CommsRailScope {
  key: string;
  principalId: string;
  organizationId: string;
  branchIds: readonly string[];
}

/** Factory boundary for a fresh principal/view-as-scoped rail store. */
export type CommsRailStoreFactory = (
  scope: CommsRailScope,
  api: ReturnType<typeof useAuth>["api"],
) => CommsRailStore;

export type CommsRailContainerProps = (PersistentRailProps | DrawerRailProps) & {
  /**
   * Supplies a fresh store for each effective scope. Detail/full-module owners
   * can retain that same scope-owned store through their own factory registry.
   */
  createStore?: CommsRailStoreFactory;
};

/**
 * Principal-scoped rail owner. The keyed scope boundary synchronously removes
 * previous-principal rows before any new request can settle; CommsRailStore
 * additionally aborts and fences every source/action request.
 */
export function CommsRailContainer(props: CommsRailContainerProps) {
  const { api, session, viewAs } = useAuth();
  const scope = useMemo(() => authScope(session, viewAs), [session, viewAs]);
  const railScope = useMemo<CommsRailScope | undefined>(() => {
    if (!session?.org_id || !session.user_id) return undefined;
    return {
      key: scope,
      principalId: session.user_id,
      organizationId: session.org_id,
      branchIds: session.branches ?? [],
    };
  }, [scope, session]);
  if (!railScope) return null;
  return <ScopedCommsRail key={scope} api={api} scope={railScope} {...props} />;
}

function ScopedCommsRail({ api, scope, createStore, ...props }: CommsRailContainerProps & {
  readonly api: ReturnType<typeof useAuth>["api"];
  readonly scope: CommsRailScope;
}) {
  const store = useMemo(
    () => createStore?.(scope, api) ?? new CommsRailStore(createAuthenticatedCommsRailApi(api)),
    [api, createStore, scope],
  );
  const [snapshot, setSnapshot] = useState<CommsRailSnapshot>(loadingCommsRailSnapshot);
  const [retryingSource, setRetryingSource] = useState<"messenger" | "mail" | "notifications" | "notices">();

  useEffect(() => {
    store.setGeneration({
      principalId: scope.principalId,
      organizationId: scope.organizationId,
      branchIds: scope.branchIds,
    });
    const unsubscribe = store.subscribe(setSnapshot);
    void store.refresh();
    return () => {
      unsubscribe();
      store.dispose();
    };
  }, [scope, store]);

  const onRetry = async (source: "messenger" | "mail" | "notifications" | "notices") => {
    setRetryingSource(source);
    try {
      await store.retry(source);
    } finally {
      setRetryingSource((current) => current === source ? undefined : current);
    }
  };
  const onAction = (action: Parameters<typeof store.act>[0]) => { void store.act(action); };
  const handleRetry = (source: "messenger" | "mail" | "notifications" | "notices") => { void onRetry(source); };
  if (props.presentation === "drawer") {
    return <CommsRailView {...props} snapshot={snapshot} retryingSource={retryingSource} onRetry={handleRetry} onAction={onAction} />;
  }
  return <CommsRailView {...props} snapshot={snapshot} retryingSource={retryingSource} onRetry={handleRetry} onAction={onAction} />;
}
