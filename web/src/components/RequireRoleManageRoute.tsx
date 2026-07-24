import { Navigate, Outlet } from "react-router";

import { useAuth } from "../context/auth";
import { hasAnyRole, ROLES } from "./shell/nav";

/**
 * RoleManage is an elevated/system-only capability until the Cedar PBAC cutover
 * provides an authoritative elevated-decision source. The backend intentionally
 * strips RoleManage from runtime-effective custom-role grants, so a stale
 * `feature_grants: ["role_manage"]` claim must not open RoleManage-tier pages.
 */
const ROLE_MANAGE_ROLES = [ROLES.SUPER_ADMIN] as const;

/** Route guard for RoleManage-tier surfaces. Backend re-checks RoleManage where applicable. */
export function RequireRoleManageRoute() {
  const { session } = useAuth();
  const canManageRoles = hasAnyRole(session?.roles, ROLE_MANAGE_ROLES);

  if (!canManageRoles) {
    return <Navigate to="/overview" replace />;
  }

  return <Outlet />;
}
