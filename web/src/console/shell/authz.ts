import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { buildNonAuthoritativePolicyProjection } from "../../auth/policyProjection";
import { useAuth } from "../../context/auth";
import { listGroupAdminGroups } from "../../api/groupAdmin";
import type { ConsoleGrants } from "./nav";
import {
  featureGrantsFromAuthzProjection,
  fetchAuthzProjection,
  type AuthzProjection,
} from "../policy/authz";

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

function grantsFromAuthzProjection(projection: AuthzProjection): ConsoleGrants {
  return {
    roles: projection.roles,
    featureGrants: featureGrantsFromAuthzProjection(projection),
  };
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

export interface ConsoleAuthz {
  grants: ConsoleGrants;
  source: "authz" | "jwt";
  /** False until the live endpoint has settled for this authenticated session. */
  ready: boolean;
}

function useConsoleAuthzState(): ConsoleAuthz {
  const { session } = useAuth();
  const token = session?.access_token;
  const baseline = useMemo(() => grantsFromSession(session), [session]);
  const [authoritative, setAuthoritative] = useState<{ token: string | undefined; grants: ConsoleGrants }>();
  const [settledToken, setSettledToken] = useState<string | undefined>();
  const currentAuthoritative =
    authoritative && authoritative.token === token ? authoritative.grants : undefined;

  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthzProjection(token, controller.signal, { attempts: 1 }).then((projection) => {
      if (controller.signal.aborted) return;
      if (projection) setAuthoritative({ token, grants: grantsFromAuthzProjection(projection) });
      setSettledToken(token);
    });
    return () => {
      controller.abort();
    };
  }, [token]);

  return currentAuthoritative
    ? { grants: currentAuthoritative, source: "authz", ready: true }
    : { grants: baseline, source: "jwt", ready: settledToken === token };
}

const ConsoleAuthzContext = createContext<ConsoleAuthz | undefined>(undefined);

/** Shares one authz read and one normalized feature-grant view with shell and screens. */
export function ConsoleAuthzProvider({ children }: { children: ReactNode }) {
  const value = useConsoleAuthzState();
  return createElement(ConsoleAuthzContext.Provider, { value }, children);
}

export function useConsoleAuthz(): ConsoleAuthz {
  const value = useContext(ConsoleAuthzContext);
  if (!value) throw new Error("useConsoleAuthz must be used within ConsoleAuthzProvider");
  return value;
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
  const { session, api, refreshAuthority } = useAuth();
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
          const groups = await listGroupAdminGroups(session?.access_token, refreshAuthority);
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
  }, [api, session?.access_token, session?.org_id, isGroupAdmin, refreshAuthority]);

  const options = useMemo(
    () => computeScopeOptions(entities ?? [], unionLabel),
    [entities, unionLabel],
  );
  return { options, loading: entities === undefined };
}
