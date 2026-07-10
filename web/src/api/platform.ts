import type { components, operations, paths } from "@maintenance/api-client-ts";

import { canonicalOrgSlug } from "../lib/orgSlug";
import { getDeviceId } from "./device";
import { isAuthPath, singleFlightRefresh } from "./refresh";

/**
 * Vendor platform-admin (multi-tenant) API. The `/api/platform/*` surface is
 * described by `backend/openapi/openapi.yaml` and generated into
 * `@maintenance/api-client-ts`; this module keeps the raw fetch transport only
 * so platform calls continue to mirror the console client's auth behavior
 * (bearer header, cookie transport opt-in, X-Device-Id, credentials).
 *
 * They live under `/api` so the ingress `/api`→backend rule reaches them, with no
 * path collision with the SPA's own `/platform/*` browser routes (which the
 * client-side router owns).
 */

type PlatformRouteTemplate = Extract<keyof paths, `/api/platform/${string}`>;

// Frontend mirror of the generated platform path keys. The backend route
// inventory comparison (`scripts/check-platform-contract-drift.mjs`) keeps
// `mnt-platform-rest` in lockstep with OpenAPI; this `satisfies` check keeps raw
// fetch call sites from naming a platform route that is absent from the generated
// TypeScript contract.
const PLATFORM_ROUTES = {
  orgs: "/api/platform/orgs",
  orgById: "/api/platform/orgs/{id}",
  ops: "/api/platform/ops",
  groups: "/api/platform/groups",
  groupById: "/api/platform/groups/{id}",
  groupAccounts: "/api/platform/groups/{id}/accounts",
  groupAccountRole:
    "/api/platform/groups/{id}/accounts/{user_id}/roles/{group_role}",
  groupOrganization: "/api/platform/groups/{id}/organizations/{org_id}",
  viewAs: "/api/platform/view-as",
  viewAsExit: "/api/platform/view-as/exit",
  tenantContext: "/api/platform/tenant-context",
  tenantContextExit: "/api/platform/tenant-context/exit",
} as const satisfies Record<string, PlatformRouteTemplate>;

type JsonRequestBody<OperationId extends keyof operations> =
  operations[OperationId] extends {
    requestBody: { content: { "application/json": infer Body } };
  }
    ? Body
    : never;

type OperationResponses<OperationId extends keyof operations> =
  operations[OperationId] extends { responses: infer Responses }
    ? Responses
    : never;

type JsonResponse<
  OperationId extends keyof operations,
  Status extends keyof OperationResponses<OperationId>,
> = OperationResponses<OperationId>[Status] extends {
  content: { "application/json": infer Body };
}
  ? Body
  : never;

export type OrgStatus = components["schemas"]["PlatformOrgStatus"];
export type PlatformTenantRole = components["schemas"]["PlatformTenantRole"];
export type PlatformGroupRole = components["schemas"]["PlatformGroupRole"];
export type PlatformAccountStatus =
  components["schemas"]["PlatformAccountStatus"];
export type PlatformOrg = components["schemas"]["PlatformOrg"];
export type PlatformGroupMember = components["schemas"]["PlatformGroupMember"];
export type PlatformGroup = components["schemas"]["PlatformGroup"];
export type PlatformGroupAccount =
  components["schemas"]["PlatformGroupAccount"];
export type CreatePlatformGroupRequest =
  JsonRequestBody<"createPlatformGroup">;
export type UpdatePlatformGroupRequest =
  JsonRequestBody<"updatePlatformGroup">;
export type CreatePlatformGroupAccountRequest =
  JsonRequestBody<"createPlatformGroupAccount">;
export type CreatePlatformGroupAccountResponse = JsonResponse<
  "createPlatformGroupAccount",
  201
>;
export type OnboardOrgRequest = JsonRequestBody<"onboardPlatformOrg">;
/** Onboarding response: the new org plus a one-time OTP shown exactly once. */
export type OnboardOrgResponse = JsonResponse<"onboardPlatformOrg", 201>;
export type ViewAsRole = PlatformTenantRole;
export type ViewAsStartRequest = JsonRequestBody<"startPlatformViewAs">;
export type ViewAsStartResponse = JsonResponse<"startPlatformViewAs", 200>;
export type TenantContextStartRequest =
  JsonRequestBody<"startPlatformTenantContext">;
export type TenantContextStartResponse = JsonResponse<
  "startPlatformTenantContext",
  200
>;
export type PlatformTenantHealth = components["schemas"]["PlatformTenantHealth"];
export type PlatformOpsResponse = JsonResponse<"getPlatformOps", 200>;

/**
 * Raised when a platform call returns a non-2xx response. `status` lets callers
 * branch on validation (400/422) vs. conflict (409) vs. anything else.
 */
export class PlatformApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code?: string) {
    super(`Platform API request failed with status ${String(status)}`);
    this.name = "PlatformApiError";
    this.status = status;
    this.code = code;
  }
}

function platformBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

async function platformFetch(
  bearerToken: string | undefined,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (bearerToken) {
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }
  // Match the generated client: opt into the cookie refresh transport and send a
  // stable device id so backend rate limiting behaves identically.
  headers.set("X-Auth-Transport", "cookie");
  const deviceId = getDeviceId();
  if (deviceId) {
    headers.set("X-Device-Id", deviceId);
  }

  const response = await fetch(`${platformBaseUrl()}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  // On a 401 from a non-auth endpoint: single-flight refresh then retry once.
  if (response.status === 401 && !isAuthPath(`${platformBaseUrl()}${path}`)) {
    let newToken: string;
    try {
      newToken = await singleFlightRefresh();
    } catch {
      // singleFlightRefresh already called onUnauthenticated(); return the 401
      // so the caller sees a PlatformApiError with status 401.
      return response;
    }

    const retryHeaders = new Headers(headers);
    retryHeaders.set("Authorization", `Bearer ${newToken}`);
    return fetch(`${platformBaseUrl()}${path}`, {
      ...init,
      headers: retryHeaders,
      credentials: "include",
    });
  }

  return response;
}

async function parseError(response: Response): Promise<PlatformApiError> {
  // Backend error bodies expose a machine-readable `error`/`code` string we use
  // to distinguish e.g. a duplicate slug from a malformed slug; tolerate a
  // missing/non-JSON body.
  let code: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: unknown;
      code?: unknown;
    };
    if (typeof body.error === "string") code = body.error;
    else if (
      body.error &&
      typeof body.error === "object" &&
      "code" in body.error &&
      typeof body.error.code === "string"
    ) {
      code = body.error.code;
    } else if (typeof body.code === "string") code = body.code;
  } catch {
    code = undefined;
  }
  return new PlatformApiError(response.status, code);
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function platformOrgPath(id: string): string {
  return PLATFORM_ROUTES.orgById.replace("{id}", encodeSegment(id));
}

function platformGroupPath(id: string): string {
  return PLATFORM_ROUTES.groupById.replace("{id}", encodeSegment(id));
}

function platformGroupAccountsPath(groupId: string): string {
  return PLATFORM_ROUTES.groupAccounts.replace("{id}", encodeSegment(groupId));
}

function platformGroupRolePath(
  groupId: string,
  userId: string,
  role: PlatformGroupRole,
): string {
  return PLATFORM_ROUTES.groupAccountRole
    .replace("{id}", encodeSegment(groupId))
    .replace("{user_id}", encodeSegment(userId))
    .replace("{group_role}", encodeSegment(role));
}

function platformGroupOrganizationPath(groupId: string, orgId: string): string {
  return PLATFORM_ROUTES.groupOrganization
    .replace("{id}", encodeSegment(groupId))
    .replace("{org_id}", encodeSegment(orgId));
}

function normalizePlatformOrg(org: PlatformOrg): PlatformOrg {
  return { ...org, slug: canonicalOrgSlug(org.slug) };
}

function normalizePlatformGroupMember(
  member: PlatformGroupMember,
): PlatformGroupMember {
  return { ...member, slug: canonicalOrgSlug(member.slug) };
}

function normalizePlatformGroup(group: PlatformGroup): PlatformGroup {
  return {
    ...group,
    members: group.members.map(normalizePlatformGroupMember),
  };
}

function normalizePlatformGroupAccount(
  account: PlatformGroupAccount,
): PlatformGroupAccount {
  return { ...account, org_slug: canonicalOrgSlug(account.org_slug) };
}

function normalizePlatformGroupAccountResponse(
  response: CreatePlatformGroupAccountResponse,
): CreatePlatformGroupAccountResponse {
  return {
    ...response,
    account: normalizePlatformGroupAccount(response.account),
  };
}

function normalizePlatformTenantHealth(
  tenant: PlatformTenantHealth,
): PlatformTenantHealth {
  return {
    ...tenant,
    slug: canonicalOrgSlug(tenant.slug),
  };
}

/**
 * POST /api/platform/view-as — mint a SHORT-LIVED, READ-ONLY impersonation token
 * to view a tenant as a given role for troubleshooting. Platform-tier only; the
 * minted token can never mutate (a blanket backend gate rejects every non-GET
 * tenant request it carries).
 */
export async function startViewAs(
  bearerToken: string | undefined,
  body: ViewAsStartRequest,
): Promise<ViewAsStartResponse> {
  const response = await platformFetch(bearerToken, PLATFORM_ROUTES.viewAs, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as ViewAsStartResponse;
}

/**
 * POST /api/platform/view-as/exit — end an impersonation session (audited).
 * Called with the operator's PLATFORM token, not the impersonation token, so it
 * is reachable after the app has switched into the tenant view.
 */
export async function exitViewAs(
  bearerToken: string | undefined,
): Promise<void> {
  const response = await platformFetch(
    bearerToken,
    PLATFORM_ROUTES.viewAsExit,
    { method: "POST" },
  );
  if (!response.ok) throw await parseError(response);
}

/**
 * POST /api/platform/tenant-context — mint a SHORT-LIVED, WRITABLE tenant admin
 * token for one tenant. Platform-tier only; the token is still pinned to one org
 * and audited, but it can mutate through ordinary tenant routes.
 */
export async function startTenantContext(
  bearerToken: string | undefined,
  body: TenantContextStartRequest,
): Promise<TenantContextStartResponse> {
  const response = await platformFetch(
    bearerToken,
    PLATFORM_ROUTES.tenantContext,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as TenantContextStartResponse;
}

/** POST /api/platform/tenant-context/exit — end a writable tenant context (audited). */
export async function exitTenantContext(
  bearerToken: string | undefined,
): Promise<void> {
  const response = await platformFetch(
    bearerToken,
    PLATFORM_ROUTES.tenantContextExit,
    { method: "POST" },
  );
  if (!response.ok) throw await parseError(response);
}

/** GET /api/platform/ops — cross-tenant ops health rollup (audited). */
export async function getPlatformOps(
  bearerToken: string | undefined,
): Promise<PlatformTenantHealth[]> {
  const response = await platformFetch(bearerToken, PLATFORM_ROUTES.ops, {
    method: "GET",
  });
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as PlatformOpsResponse;
  return body.tenants.map(normalizePlatformTenantHealth);
}

/** GET /api/platform/orgs — list every tenant organization. */
export async function listPlatformOrgs(
  bearerToken: string | undefined,
): Promise<PlatformOrg[]> {
  const response = await platformFetch(bearerToken, PLATFORM_ROUTES.orgs, {
    method: "GET",
  });
  if (!response.ok) throw await parseError(response);
  const orgs = (await response.json()) as PlatformOrg[];
  return orgs.map(normalizePlatformOrg);
}

/** POST /api/platform/orgs — onboard a tenant; returns the org + a one-time OTP. */
export async function onboardPlatformOrg(
  bearerToken: string | undefined,
  body: OnboardOrgRequest,
): Promise<OnboardOrgResponse> {
  const response = await platformFetch(bearerToken, PLATFORM_ROUTES.orgs, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await parseError(response);
  const onboarded = (await response.json()) as OnboardOrgResponse;
  return { ...onboarded, org: normalizePlatformOrg(onboarded.org) };
}

/** PATCH /api/platform/orgs/{id} — set a tenant's lifecycle status. */
export async function setPlatformOrgStatus(
  bearerToken: string | undefined,
  id: string,
  status: OrgStatus,
): Promise<PlatformOrg> {
  const response = await platformFetch(
    bearerToken,
    platformOrgPath(id),
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
    },
  );
  if (!response.ok) throw await parseError(response);
  return normalizePlatformOrg((await response.json()) as PlatformOrg);
}

/**
 * DELETE /api/platform/orgs/{id} — GUARDED hard-removal of an empty/test tenant.
 *
 * Succeeds (204) only for an empty tenant. A tenant with real operational data
 * is refused with 409 (`PlatformApiError.status === 409`, code `tenant_has_data`)
 * — the caller surfaces the "archive instead" guidance. A missing tenant is 404.
 */
export async function removePlatformOrg(
  bearerToken: string | undefined,
  id: string,
): Promise<void> {
  const response = await platformFetch(
    bearerToken,
    platformOrgPath(id),
    {
      method: "DELETE",
    },
  );
  if (!response.ok) throw await parseError(response);
}

/**
 * DELETE /api/platform/orgs/{id}?delete_data=true — FORCE hard-removal of a tenant
 * AND all of its data. The DESTRUCTIVE counterpart to {@link removePlatformOrg}.
 *
 * Erases the org and every operational row it owns. Fail-closed by a status rail:
 * the backend refuses with 409 (`PlatformApiError.status === 409`, code
 * `tenant_active`) unless the tenant is ARCHIVED — archive it (reversible) first.
 * A missing tenant is 404. Platform-super-admin only.
 */
export async function forceRemovePlatformOrg(
  bearerToken: string | undefined,
  id: string,
): Promise<void> {
  const response = await platformFetch(
    bearerToken,
    `${platformOrgPath(id)}?delete_data=true`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) throw await parseError(response);
}

/** GET /api/platform/groups — list every group and its member org identities. */
export async function listPlatformGroups(
  bearerToken: string | undefined,
): Promise<PlatformGroup[]> {
  const response = await platformFetch(bearerToken, PLATFORM_ROUTES.groups, {
    method: "GET",
  });
  if (!response.ok) throw await parseError(response);
  const groups = (await response.json()) as PlatformGroup[];
  return groups.map(normalizePlatformGroup);
}

/** POST /api/platform/groups — create a group identity, not a tenant. */
export async function createPlatformGroup(
  bearerToken: string | undefined,
  body: CreatePlatformGroupRequest,
): Promise<PlatformGroup> {
  const response = await platformFetch(bearerToken, PLATFORM_ROUTES.groups, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await parseError(response);
  return normalizePlatformGroup((await response.json()) as PlatformGroup);
}

/** PATCH /api/platform/groups/{id} — update group slug/name/status. */
export async function updatePlatformGroup(
  bearerToken: string | undefined,
  id: string,
  body: UpdatePlatformGroupRequest,
): Promise<PlatformGroup> {
  const response = await platformFetch(
    bearerToken,
    platformGroupPath(id),
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw await parseError(response);
  return normalizePlatformGroup((await response.json()) as PlatformGroup);
}

/** GET /api/platform/groups/{id}/accounts — list tenant-anchored group accounts. */
export async function listPlatformGroupAccounts(
  bearerToken: string | undefined,
  groupId: string,
): Promise<PlatformGroupAccount[]> {
  const response = await platformFetch(
    bearerToken,
    platformGroupAccountsPath(groupId),
    { method: "GET" },
  );
  if (!response.ok) throw await parseError(response);
  const accounts = (await response.json()) as PlatformGroupAccount[];
  return accounts.map(normalizePlatformGroupAccount);
}

/** POST /api/platform/groups/{id}/accounts — create a tenant-anchored group account. */
export async function createPlatformGroupAccount(
  bearerToken: string | undefined,
  groupId: string,
  body: CreatePlatformGroupAccountRequest,
): Promise<CreatePlatformGroupAccountResponse> {
  const response = await platformFetch(
    bearerToken,
    platformGroupAccountsPath(groupId),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw await parseError(response);
  return normalizePlatformGroupAccountResponse(
    (await response.json()) as CreatePlatformGroupAccountResponse,
  );
}

/** DELETE /api/platform/groups/{id}/accounts/{userId}/roles/{role} — revoke one group role. */
export async function revokePlatformGroupRole(
  bearerToken: string | undefined,
  groupId: string,
  userId: string,
  role: PlatformGroupRole,
): Promise<void> {
  const response = await platformFetch(
    bearerToken,
    platformGroupRolePath(groupId, userId, role),
    { method: "DELETE" },
  );
  if (!response.ok) throw await parseError(response);
}

/** PUT /api/platform/groups/{id}/organizations/{orgId} — assign or move org into a group. */
export async function assignPlatformOrgToGroup(
  bearerToken: string | undefined,
  groupId: string,
  orgId: string,
): Promise<PlatformOrg> {
  const response = await platformFetch(
    bearerToken,
    platformGroupOrganizationPath(groupId, orgId),
    { method: "PUT" },
  );
  if (!response.ok) throw await parseError(response);
  return normalizePlatformOrg((await response.json()) as PlatformOrg);
}

/** DELETE /api/platform/groups/{id}/organizations/{orgId} — remove an org from a group. */
export async function removePlatformOrgFromGroup(
  bearerToken: string | undefined,
  groupId: string,
  orgId: string,
): Promise<PlatformOrg> {
  const response = await platformFetch(
    bearerToken,
    platformGroupOrganizationPath(groupId, orgId),
    { method: "DELETE" },
  );
  if (!response.ok) throw await parseError(response);
  return normalizePlatformOrg((await response.json()) as PlatformOrg);
}
