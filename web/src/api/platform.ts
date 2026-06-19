import { getDeviceId } from "./device";
import { isAuthPath, singleFlightRefresh } from "./refresh";

/**
 * Vendor platform-admin (multi-tenant) API. These `/platform/*` routes are an
 * internal vendor API and are intentionally NOT in the served OpenAPI, so they
 * are NOT on the generated `ConsoleApiClient`. We call them with a small raw
 * `fetch` wrapper that mirrors the auth/transport behavior of the generated
 * client (bearer header, cookie transport opt-in, X-Device-Id, credentials).
 */

export type OrgStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED";

export interface PlatformOrg {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  created_at: string;
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
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") code = body.error;
    else if (typeof body.code === "string") code = body.code;
  } catch {
    code = undefined;
  }
  return new PlatformApiError(response.status, code);
}

/** One tenant's health/usage numbers from the platform ops dashboard. */
export interface PlatformTenantHealth {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  user_count: number;
  active_user_count: number;
  active_work_orders: number;
  open_work_orders: number;
  last_activity_at: string | null;
}

/** Response shape of GET /platform/ops. */
export interface PlatformOpsResponse {
  tenants: PlatformTenantHealth[];
}

/** GET /platform/ops — cross-tenant ops health rollup (audited). */
export async function getPlatformOps(
  bearerToken: string | undefined,
): Promise<PlatformTenantHealth[]> {
  const response = await platformFetch(bearerToken, "/platform/ops", {
    method: "GET",
  });
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as PlatformOpsResponse;
  return body.tenants;
}

/** GET /platform/orgs — list every tenant organization. */
export async function listPlatformOrgs(
  bearerToken: string | undefined,
): Promise<PlatformOrg[]> {
  const response = await platformFetch(bearerToken, "/platform/orgs", {
    method: "GET",
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformOrg[];
}

/** POST /platform/orgs — onboard a tenant; returns the org + a one-time OTP. */
export async function onboardPlatformOrg(
  bearerToken: string | undefined,
  body: OnboardOrgRequest,
): Promise<OnboardOrgResponse> {
  const response = await platformFetch(bearerToken, "/platform/orgs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as OnboardOrgResponse;
}

/** PATCH /platform/orgs/{id} — set a tenant's lifecycle status. */
export async function setPlatformOrgStatus(
  bearerToken: string | undefined,
  id: string,
  status: OrgStatus,
): Promise<PlatformOrg> {
  const response = await platformFetch(
    bearerToken,
    `/platform/orgs/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
    },
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PlatformOrg;
}
