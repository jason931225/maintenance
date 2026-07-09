import { useEffect, useMemo, useState } from "react";

import { getDeviceId } from "../../api/device";
import { buildNonAuthoritativePolicyProjection } from "../../auth/policyProjection";
import { useAuth } from "../../context/auth";
import { listGroupAdminGroups } from "../../api/groupAdmin";
import type { ConsoleGrants } from "./nav";

/**
 * Console authorization hints (deny-by-omission source) + scope entities.
 *
 * `useConsoleAuthz` prefers the authoritative `GET /api/v1/me/authz` endpoint
 * (charter P0.1) and falls back to the JWT claims when it is unavailable (it is
 * merging on PR #234; until then it 404s in dev, and the charter allows the
 * JWT-derived hint). All of this only shapes what the nav offers — the backend
 * re-authorizes every call.
 *
 * `useConsoleScopes` binds the scope switcher to the identity org API: the
 * caller's own 법인 (`GET /api/v1/users/me` → `employee_company`) plus, for a
 * group admin, the member orgs of the groups they administer
 * (`GET /api/v1/group-admin/groups`). "그룹 전체" is the *union* of exactly those
 * authorized entities — never a literal all-orgs option.
 */

function apiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

interface AuthzResponse {
  roles?: unknown;
  feature_grants?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Best-effort authoritative authz read. Returns `undefined` on 404/error so the
 * caller keeps the JWT-derived baseline.
 *
 * ponytail: raw fetch, not `api.GET`, because the path is not in the generated
 * openapi client yet (PR #234). Swap to `api.GET("/api/v1/me/authz")` once the
 * client is regenerated — the typed call gets refresh/cache for free then.
 */
async function fetchAuthz(
  bearer: string | undefined,
  signal: AbortSignal,
): Promise<ConsoleGrants | undefined> {
  try {
    const headers = new Headers({ Accept: "application/json" });
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
    headers.set("X-Auth-Transport", "cookie");
    const deviceId = getDeviceId();
    if (deviceId) headers.set("X-Device-Id", deviceId);
    const res = await fetch(`${apiBaseUrl()}/api/v1/me/authz`, {
      method: "GET",
      headers,
      credentials: "include",
      signal,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as AuthzResponse;
    return {
      roles: stringArray(body.roles),
      featureGrants: stringArray(body.feature_grants),
    };
  } catch {
    return undefined;
  }
}

/** JWT-derived grants: role claims + feature grants (incl. the Cedar projection). */
function grantsFromSession(session: ReturnType<typeof useAuth>["session"]): ConsoleGrants {
  const projection = buildNonAuthoritativePolicyProjection({
    feature_grants: session?.feature_grants,
    policy_projection: session?.policy_projection,
  });
  return {
    roles: session?.roles ?? [],
    featureGrants: projection?.feature_grants ?? session?.feature_grants ?? [],
  };
}

export function useConsoleAuthz(): { grants: ConsoleGrants; source: "authz" | "jwt" } {
  const { session } = useAuth();
  const baseline = useMemo(() => grantsFromSession(session), [session]);
  const [authoritative, setAuthoritative] = useState<ConsoleGrants | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthz(session?.access_token, controller.signal).then((grants) => {
      if (!controller.signal.aborted && grants) setAuthoritative(grants);
    });
    return () => {
      controller.abort();
    };
  }, [session?.access_token]);

  return authoritative
    ? { grants: authoritative, source: "authz" }
    : { grants: baseline, source: "jwt" };
}

// ---- scope switcher --------------------------------------------------------

export const UNION_SCOPE_ID = "__union__";

export interface ScopeEntity {
  id: string;
  label: string;
}

export interface ScopeOption extends ScopeEntity {
  /** Present on the union row: the exact authorized entity ids it spans. */
  memberIds?: string[];
  isUnion: boolean;
}

/**
 * Build the scope-switcher options from the authorized entities. The union row
 * ("그룹 전체") is always first and spans *exactly* the authorized entities — it
 * is never a literal all-orgs escape hatch. Entities are de-duplicated by id,
 * preserving first-seen order.
 */
export function computeScopeOptions(
  entities: readonly ScopeEntity[],
  unionLabel: string,
): ScopeOption[] {
  const seen = new Set<string>();
  const unique: ScopeEntity[] = [];
  for (const e of entities) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    unique.push(e);
  }
  const union: ScopeOption = {
    id: UNION_SCOPE_ID,
    label: unionLabel,
    memberIds: unique.map((e) => e.id),
    isUnion: true,
  };
  return [union, ...unique.map((e) => ({ ...e, isUnion: false }))];
}

export function useConsoleScopes(unionLabel: string): {
  options: ScopeOption[];
  loading: boolean;
} {
  const { session, api } = useAuth();
  const [entities, setEntities] = useState<ScopeEntity[] | undefined>();
  const isGroupAdmin = (session?.group_roles ?? []).includes("GROUP_ADMIN");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const collected: ScopeEntity[] = [];
      try {
        const me = await api.GET("/api/v1/users/me");
        const company = me.data?.employee_company;
        if (company) {
          collected.push({ id: session?.org_id ?? "self", label: company });
        }
      } catch {
        /* identity read failed — fall through to whatever else resolves */
      }
      if (isGroupAdmin) {
        try {
          const groups = await listGroupAdminGroups(session?.access_token);
          for (const group of groups) {
            for (const member of group.members) {
              collected.push({ id: member.id, label: member.name });
            }
          }
        } catch {
          /* not a group admin at runtime, or endpoint denied — skip */
        }
      }
      if (!cancelled) setEntities(collected);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [api, session?.access_token, session?.org_id, isGroupAdmin]);

  const options = useMemo(
    () => computeScopeOptions(entities ?? [], unionLabel),
    [entities, unionLabel],
  );
  return { options, loading: entities === undefined };
}
