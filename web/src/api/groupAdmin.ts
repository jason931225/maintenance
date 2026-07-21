import { canonicalOrgSlug } from "../lib/orgSlug";
import { getDeviceId } from "./device";
import { singleFlightRefresh } from "./refresh";
import type { RefreshAuthority } from "./refresh";

export interface GroupAdminMemberOrg {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export interface GroupAdminGroup {
  id: string;
  slug: string;
  name: string;
  status: string;
  members: GroupAdminMemberOrg[];
}

export interface GroupAdminGroupsResponse {
  groups: GroupAdminGroup[];
}

export interface GroupTenantContextStartResponse {
  access_token: string;
  token_type: string;
  acting_org_id: string;
  acting_org_name: string;
  acting_role: "GROUP_ADMIN_DELEGATED_ADMIN";
  expires_at: string;
}

function normalizeGroupAdminMember(
  member: GroupAdminMemberOrg,
): GroupAdminMemberOrg {
  return { ...member, slug: canonicalOrgSlug(member.slug) };
}

function normalizeGroupAdminGroup(group: GroupAdminGroup): GroupAdminGroup {
  return {
    ...group,
    members: group.members.map(normalizeGroupAdminMember),
  };
}

export class GroupAdminApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(`Group admin API request failed with status ${String(status)}`);
    this.name = "GroupAdminApiError";
    this.status = status;
    this.code = code;
  }
}

function apiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

async function groupAdminFetch(
  bearerToken: string | undefined,
  path: string,
  init: RequestInit,
  refreshAuthority?: RefreshAuthority,
): Promise<Response> {
  const request = (token: string | undefined) => {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    headers.set("X-Auth-Transport", "cookie");
    const deviceId = getDeviceId();
    if (deviceId) {
      headers.set("X-Device-Id", deviceId);
    }

    return fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
  };

  const response = await request(bearerToken);
  if (response.status !== 401) return response;

  try {
    const freshBearer = await singleFlightRefresh(refreshAuthority);
    return await request(freshBearer);
  } catch {
    return response;
  }
}

async function parseError(response: Response): Promise<GroupAdminApiError> {
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
  return new GroupAdminApiError(response.status, code);
}

export async function listGroupAdminGroups(
  bearerToken: string | undefined,
  refreshAuthority?: RefreshAuthority,
): Promise<GroupAdminGroup[]> {
  const response = await groupAdminFetch(
    bearerToken,
    "/api/v1/group-admin/groups",
    { method: "GET" },
    refreshAuthority,
  );
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as GroupAdminGroupsResponse;
  return body.groups.map(normalizeGroupAdminGroup);
}

export async function startGroupTenantContext(
  bearerToken: string | undefined,
  orgId: string,
  refreshAuthority?: RefreshAuthority,
): Promise<GroupTenantContextStartResponse> {
  const response = await groupAdminFetch(
    bearerToken,
    "/api/v1/group-admin/tenant-context",
    {
      method: "POST",
      body: JSON.stringify({ org_id: orgId }),
    },
    refreshAuthority,
  );
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as GroupTenantContextStartResponse;
}

export async function exitGroupTenantContext(
  bearerToken: string | undefined,
  orgId: string,
  refreshAuthority?: RefreshAuthority,
): Promise<void> {
  const response = await groupAdminFetch(
    bearerToken,
    "/api/v1/group-admin/tenant-context/exit",
    {
      method: "POST",
      body: JSON.stringify({ org_id: orgId }),
    },
    refreshAuthority,
  );
  if (!response.ok) throw await parseError(response);
}
