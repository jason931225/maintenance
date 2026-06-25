import { useEffect, useState } from "react";

import type { ConsoleApiClient } from "../api/client";
import type { BranchSummary } from "../api/types";
import { useActiveBranchId, useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { safeLabel } from "./utils";

/**
 * Per-client cache of the branch list fetch. The active-branch chip mounts once
 * per shell render and the branch list is small and stable for a session, so we
 * resolve it once per api-client instance and share the in-flight/settled
 * promise across every caller rather than refetching on each render or mount.
 * Keyed by the api client object (a new client is built on each token change, so
 * a refreshed session transparently re-fetches against the new identity).
 */
const branchListCache = new WeakMap<
  ConsoleApiClient,
  Promise<BranchSummary[]>
>();

function loadBranches(api: ConsoleApiClient): Promise<BranchSummary[]> {
  const cached = branchListCache.get(api);
  if (cached) return cached;
  const pending = api
    .GET("/api/v1/branches")
    .then((res) => res.data ?? [])
    .catch(() => [] as BranchSummary[]);
  branchListCache.set(api, pending);
  return pending;
}

/**
 * Resolve the active branch's human-readable NAME from its id (the first JWT
 * `branches` claim). Returns `undefined` while loading or when
 * the session carries no branch, and a neutral fallback label (never the raw
 * UUID) when the id is present but unresolvable. Callers render the name through
 * `safeLabel`, so a UUID can never leak into the UI.
 */
export function useActiveBranchName(): string | undefined {
  const { api } = useAuth();
  const branchId = useActiveBranchId();
  // Keyed by branch id so a name resolved for a previous branch never bleeds
  // into the chip after the active branch changes.
  const [resolved, setResolved] = useState<
    { id: string; name: string } | undefined
  >(undefined);

  useEffect(() => {
    if (!branchId) return undefined;
    let active = true;
    void loadBranches(api).then((branches) => {
      if (!active) return;
      const match = branches.find((branch) => branch.id === branchId);
      // safeLabel rejects a UUID-shaped name; a missing match falls back to a
      // neutral label so the chip never shows the raw branch id.
      setResolved({ id: branchId, name: safeLabel(match?.name, ko.shell.branchUnknown) });
    });
    return () => {
      active = false;
    };
  }, [api, branchId]);

  // Only surface a name that belongs to the currently-active branch.
  return branchId && resolved?.id === branchId ? resolved.name : undefined;
}
