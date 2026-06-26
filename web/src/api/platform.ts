import { getDeviceId } from "./device";
import { isAuthPath, singleFlightRefresh } from "./refresh";

/**
 * Vendor platform-admin (multi-tenant) API. These `/api/platform/*` routes are
 * an internal vendor API and are intentionally NOT in the served OpenAPI, so they
 * are NOT on the generated `ConsoleApiClient`. We call them with a small raw
 * `fetch` wrapper that mirrors the auth/transport behavior of the generated
 * client (bearer header, cookie transport opt-in, X-Device-Id, credentials).
 *
 * They live under `/api` so the ingress `/api`→backend rule reaches them, with no
 * path collision with the SPA's own `/platform/*` browser routes (which the
 * client-side router owns).
 */

export type OrgStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED";

export interface PlatformOrg {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  group_id?: string | null;
  group_slug?: string | null;
  group_name?: string | null;
  created_at: string;
}

export interface PlatformGroupMember {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
}

export interface PlatformGroup {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  member_count: number;
  members: PlatformGroupMember[];
  created_at: string;
  updated_at: string;
}

export interface CreatePlatformGroupRequest {
  name: string;
  slug: string;
}

export interface UpdatePlatformGroupRequest {
  slug?: string;
  name?: string;
  status?: OrgStatus;
}

export type PlatformGroupRole =
  | "GROUP_ADMIN"
  | "GROUP_VIEWER"
  | "GROUP_FINANCE";

export type PlatformAccountStatus = "ACTIVE" | "PENDING_SETUP" | "DEACTIVATED";

export interface PlatformGroupAccount {
  user_id: string;
  display_name: string;
  phone?: string | null;
  tenant_roles: string[];
  is_active: boolean;
  has_passkey: boolean;
  account_status: PlatformAccountStatus;
  org_id: string;
  org_slug: string;
  org_name: string;
  group_roles: PlatformGroupRole[];
  created_at: string;
}

export interface CreatePlatformGroupAccountRequest {
  org_id: string;
  display_name: string;
  phone?: string;
  tenant_roles?: string[];
  group_role?: PlatformGroupRole;
}

export interface CreatePlatformGroupAccountResponse {
  account: PlatformGroupAccount;
  otp: string;
  otp_expires_at: string;
}

/** Onboarding response: the new org plus a one-time OTP shown exactly once. */
export interface OnboardOrgResponse {
  org: PlatformOrg;
  /** Single-use code to deliver out-of-band; never returned again. */
  otp: string;
}

export interface OnboardOrgRequest {
  name: string;
  slug: string;
}

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

/**
 * The canonical tenant role codes a platform operator may impersonate, matching
 * the backend `Role` enum. Kept here (not derived from a generated client) since
 * the `/api/platform/*` API is intentionally outside the served OpenAPI.
 */
export type ViewAsRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "EXECUTIVE"
  | "MECHANIC"
  | "RECEPTIONIST"
  | "MEMBER";

/** Request body for POST /api/platform/view-as. */
export interface ViewAsStartRequest {
  org_id: string;
  role: ViewAsRole;
}

/** Response of POST /api/platform/view-as: the short-lived read-only token. */
export interface ViewAsStartResponse {
  access_token: string;
  token_type: string;
  acting_org_id: string;
  acting_org_name: string;
  acting_role: string;
  expires_at: string;
}

/** Request body for POST /api/platform/tenant-context. */
export interface TenantContextStartRequest {
  org_id: string;
}

/** Response of POST /api/platform/tenant-context: short-lived writable tenant token. */
export interface TenantContextStartResponse {
  access_token: string;
  token_type: string;
  acting_org_id: string;
  acting_org_name: string;
  acting_role: "SUPER_ADMIN";
  expires_at: string;
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
  const response = await platformFetch(bearerToken, "/api/platform/view-as", {
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
    "/api/platform/view-as/exit",
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
    "/api/platform/tenant-context",
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
    "/api/platform/tenant-context/exit",
    { method: "POST" },
  );
  if (!response.ok) throw await parseError(response);
}

/** One tenant's health/usage numbers from the platform ops dashboard. */
export interface PlatformTenantHealth {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  group_id?: string | null;
  group_slug?: string | null;
  group_name?: string | null;
  user_count: number;
  active_user_count: number;
  active_work_orders: number;
  open_work_orders: number;
  last_activity_at: string | null;
}

/** Response shape of GET /api/platform/ops. */
export interface PlatformOpsResponse {
  tenants: PlatformTenantHealth[];
}

/** GET /platform/ops â cross-tenant ops health rollup (audited). */
export async function getPlatformOps(
  bearerToken: string | undefined,
): Promise<PlatformTenantHealth[]> {
  const response = await platformFetch(bearerToken, "/api/platform/ops", {
    method: "GET",
  });
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as PlatformOpsResponse;
  return body.tenants;
}

/** GET /platform/orgs â list every tenant organization. */
export async function listPlatformOrgs(
  bearerToken: string | undefined,
): Promise<PlatformOrg[]> {
  const response = await platformFetch(bearerToken, "/api/platform/orgs", {
    method: "GET",
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformOrg[];
}

/** POST /platform/orgs â onboard a tenant; returns the org + a one-time OTP. */
export async function onboardPlatformOrg(
  bearerToken: string | undefined,
  body: OnboardOrgRequest,
): Promise<OnboardOrgResponse> {
  const response = await platformFetch(bearerToken, "/api/platform/orgs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as OnboardOrgResponse;
}

/** PATCH /platform/orgs/{id} â set a tenant's lifecycle status. */
export async function setPlatformOrgStatus(
  bearerToken: string | undefined,
  id: string,
  status: OrgStatus,
): Promise<PlatformOrg> {
  const response = await platformFetch(
    bearerToken,
    `/api/platform/orgs/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
    },
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformOrg;
}

/**
 * DELETE /platform/orgs/{id} — GUARDED hard-removal of an empty/test tenant.
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
    `/api/platform/orgs/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) throw await parseError(response);
}

/**
 * DELETE /platform/orgs/{id}?delete_data=true — FORCE hard-removal of a tenant
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
    `/api/platform/orgs/${encodeURIComponent(id)}?delete_data=true`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) throw await parseError(response);
}

/** GET /platform/groups — list every group and its member org identities. */
export async function listPlatformGroups(
  bearerToken: string | undefined,
): Promise<PlatformGroup[]> {
  const response = await platformFetch(bearerToken, "/api/platform/groups", {
    method: "GET",
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformGroup[];
}

/** POST /platform/groups — create a group identity, not a tenant. */
export async function createPlatformGroup(
  bearerToken: string | undefined,
  body: CreatePlatformGroupRequest,
): Promise<PlatformGroup> {
  const response = await platformFetch(bearerToken, "/api/platform/groups", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformGroup;
}

/** PATCH /platform/groups/{id} — update group slug/name/status. */
export async function updatePlatformGroup(
  bearerToken: string | undefined,
  id: string,
  body: UpdatePlatformGroupRequest,
): Promise<PlatformGroup> {
  const response = await platformFetch(
    bearerToken,
    `/api/platform/groups/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformGroup;
}

/** GET /platform/groups/{id}/accounts — list tenant-anchored group accounts. */
export async function listPlatformGroupAccounts(
  bearerToken: string | undefined,
  groupId: string,
): Promise<PlatformGroupAccount[]> {
  const response = await platformFetch(
    bearerToken,
    `/api/platform/groups/${encodeURIComponent(groupId)}/accounts`,
    { method: "GET" },
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformGroupAccount[];
}

/** POST /platform/groups/{id}/accounts — create a tenant-anchored group account. */
export async function createPlatformGroupAccount(
  bearerToken: string | undefined,
  groupId: string,
  body: CreatePlatformGroupAccountRequest,
): Promise<CreatePlatformGroupAccountResponse> {
  const response = await platformFetch(
    bearerToken,
    `/api/platform/groups/${encodeURIComponent(groupId)}/accounts`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as CreatePlatformGroupAccountResponse;
}

/** DELETE /platform/groups/{id}/accounts/{userId}/roles/{role} — revoke one group role. */
export async function revokePlatformGroupRole(
  bearerToken: string | undefined,
  groupId: string,
  userId: string,
  role: PlatformGroupRole,
): Promise<void> {
  const response = await platformFetch(
    bearerToken,
    `/api/platform/groups/${encodeURIComponent(groupId)}/accounts/${encodeURIComponent(userId)}/roles/${encodeURIComponent(role)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw await parseError(response);
}

/** PUT /platform/groups/{id}/organizations/{orgId} — assign or move org into a group. */
export async function assignPlatformOrgToGroup(
  bearerToken: string | undefined,
  groupId: string,
  orgId: string,
): Promise<PlatformOrg> {
  const response = await platformFetch(
    bearerToken,
    `/api/platform/groups/${encodeURIComponent(groupId)}/organizations/${encodeURIComponent(orgId)}`,
    { method: "PUT" },
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformOrg;
}

/** DELETE /platform/groups/{id}/organizations/{orgId} — remove an org from a group. */
export async function removePlatformOrgFromGroup(
  bearerToken: string | undefined,
  groupId: string,
  orgId: string,
): Promise<PlatformOrg> {
  const response = await platformFetch(
    bearerToken,
    `/api/platform/groups/${encodeURIComponent(groupId)}/organizations/${encodeURIComponent(orgId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformOrg;
}
