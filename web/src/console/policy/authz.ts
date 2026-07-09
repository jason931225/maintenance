import { getDeviceId } from "../../api/device";
import {
  buildNonAuthoritativePolicyProjection,
  type PolicyProjectionCarrier,
} from "../../auth/policyProjection";

/**
 * Console authorization projection — the deny-by-omission source the render gate
 * ({@link ./PolicyGate}) checks against.
 *
 * AUTHORITY: the backend matrix (`authorize`) is the sole enforcer; this
 * projection only shapes what the console *offers*. It mirrors
 * `GET /api/v1/me/authz` (`MeAuthzResponse`, identity/rest) whose `authority`
 * field is always `advisory_ui_only`. The Cedar enforce-flip retargets that
 * endpoint's `source` (`legacy_matrix` → `cedar`) with this JSON shape
 * UNCHANGED — so the promotion flip is a server-side switch and this module is
 * the single client retarget point. Nothing here is a security boundary.
 *
 * FAIL CLOSED: when the endpoint errors, the gate falls back to
 * {@link jwtFloorProjection} — a deliberately *thinner* projection derived only
 * from JWT-proven custom-role grants (built-in role capabilities are omitted,
 * because computing them needs the backend matrix). Fewer affordances during an
 * outage is the safe direction; the authoritative projection restores them once
 * it loads.
 *
 * Shared fail-closed fetch shape extracted here (headers / abort / undefined on
 * error) so the shell's `console/shell/authz.ts` (PR #249, unmerged) can
 * converge onto it later — do not import across the unmerged branch.
 */

export type Permission = "request_only" | "limited" | "allow";

/** Mirrors `kernel::BranchScope` serde (`tag=kind, content=branches`). */
export type BranchScope =
  | { kind: "all" }
  | { kind: "branches"; branches: string[] };

export interface Capability {
  feature: string;
  permission: Permission;
  /**
   * The branch subset this permission level actually holds over — NOT
   * necessarily the caller's full scope. A branch-narrowed grant only elevates
   * the capability within its own branches, so a branch-targeted query MUST
   * intersect against this (see {@link gateAllows}).
   */
  branchScope: BranchScope;
}

export interface AuthzProjection {
  /** `authz` = authoritative endpoint; `jwt-floor` = fail-closed JWT fallback. */
  source: "authz" | "jwt-floor";
  roles: string[];
  branchScope: BranchScope;
  /** Deny-by-omission: a feature the caller cannot use at all is absent. */
  capabilities: Capability[];
}

export interface PolicyQuery {
  /** `Feature::as_str` snake_case key (matches `/api/v1/policy/features`). */
  feature: string;
  /** Optional target branch id; when present the capability scope must allow it. */
  branch?: string;
  /** Minimum permission the affordance requires. Default `allow`. */
  minPermission?: Permission;
}

/** Fail-closed empty projection (no provider / pre-boot). Denies everything. */
export const DENY_ALL_PROJECTION: AuthzProjection = {
  source: "jwt-floor",
  roles: [],
  branchScope: { kind: "branches", branches: [] },
  capabilities: [],
};

const PERMISSION_RANK: Record<Permission, number> = {
  request_only: 1,
  limited: 2,
  allow: 3,
};

function branchScopeAllows(scope: BranchScope, branch: string): boolean {
  return scope.kind === "all" || scope.branches.includes(branch);
}

export interface PolicyGate {
  /** `true` = render the affordance; `false` = deny-by-omission. */
  allows: (query: PolicyQuery) => boolean;
  source: AuthzProjection["source"];
  /** `false` while the authoritative projection is still loading (floor active). */
  ready: boolean;
}

/** Wrap a projection as a {@link PolicyGate}. Pure — no React. */
export function makePolicyGate(projection: AuthzProjection, ready: boolean): PolicyGate {
  return {
    allows: (query) => gateAllows(projection, query),
    source: projection.source,
    ready,
  };
}

/**
 * The single gate decision. `true` means the console may render the affordance;
 * `false` means deny-by-omission (render nothing — never a disabled ghost).
 */
export function gateAllows(
  projection: AuthzProjection,
  query: PolicyQuery,
): boolean {
  const min = PERMISSION_RANK[query.minPermission ?? "allow"];
  const cap = projection.capabilities.find((c) => c.feature === query.feature);
  if (!cap) return false; // deny-by-omission
  if (PERMISSION_RANK[cap.permission] < min) return false;
  // No target branch: the affordance is offered where the caller's best scope
  // holds; per-row branch intersection is the caller's job. With a target
  // branch, the capability's own scope must allow it (fail closed otherwise).
  if (query.branch !== undefined && !branchScopeAllows(cap.branchScope, query.branch)) {
    return false;
  }
  return true;
}

// ---- parsing ---------------------------------------------------------------

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function parseBranchScope(value: unknown): BranchScope {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "all") {
    return { kind: "all" };
  }
  const branches =
    value && typeof value === "object"
      ? stringArray((value as { branches?: unknown }).branches)
      : [];
  return { kind: "branches", branches };
}

function isPermission(value: unknown): value is Permission {
  return value === "request_only" || value === "limited" || value === "allow";
}

/** Parse a `GET /api/v1/me/authz` body into a projection. Unknown/`deny`
 * permissions are dropped (fail closed). */
export function parseAuthzResponse(body: unknown): AuthzProjection {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rawCaps = Array.isArray(record.capabilities) ? record.capabilities : [];
  const capabilities: Capability[] = [];
  for (const raw of rawCaps) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.feature !== "string" || !isPermission(c.permission)) continue;
    capabilities.push({
      feature: c.feature,
      permission: c.permission,
      branchScope: parseBranchScope(c.branch_scope),
    });
  }
  return {
    source: "authz",
    roles: stringArray(record.roles),
    branchScope: parseBranchScope(record.branch_scope),
    capabilities,
  };
}

// ---- JWT floor (fail-closed fallback) --------------------------------------

export interface SessionFloorInput extends PolicyProjectionCarrier {
  branches?: string[];
}

/**
 * Fail-closed projection from the session JWT: every runtime-effective custom
 * grant becomes an `allow` capability scoped to the caller's JWT branch
 * memberships (an explicit set — a branch-targeted query outside it is denied).
 * Built-in role capabilities are intentionally absent; the backend re-authorizes
 * every call regardless, so this floor only affects what renders during an
 * authz-endpoint outage.
 */
export function jwtFloorProjection(session: SessionFloorInput | undefined): AuthzProjection {
  const projection = buildNonAuthoritativePolicyProjection({
    feature_grants: session?.feature_grants,
    policy_projection: session?.policy_projection,
  });
  const branches = stringArray(session?.branches);
  const branchScope: BranchScope = { kind: "branches", branches };
  const capabilities: Capability[] = (projection?.feature_grants ?? []).map((feature) => ({
    feature,
    permission: "allow" as const,
    branchScope,
  }));
  return { source: "jwt-floor", roles: [], branchScope, capabilities };
}

// ---- fetch -----------------------------------------------------------------

function apiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

/**
 * Best-effort authoritative read. Returns `undefined` on any 4xx/5xx/network
 * error so the caller keeps the JWT floor (fail closed).
 *
 * ponytail: raw fetch, not `api.GET`, because `/api/v1/me/authz` is not in the
 * generated openapi client on this base. Swap to `api.GET("/api/v1/me/authz")`
 * once the client is regenerated (it gets refresh/cache for free then).
 */
export async function fetchAuthzProjection(
  bearer: string | undefined,
  signal: AbortSignal,
): Promise<AuthzProjection | undefined> {
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
    return parseAuthzResponse(await res.json());
  } catch {
    return undefined;
  }
}
