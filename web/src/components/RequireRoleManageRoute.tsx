import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";
import { FEATURES, hasAnyFeatureGrant, hasAnyRole, ROLES } from "./shell/nav";

/** Built-in RoleManage matrix grants SUPER_ADMIN; custom roles can add RoleManage. */
const ROLE_MANAGE_ROLES = [ROLES.SUPER_ADMIN] as const;
const ROLE_MANAGE_FEATURES = [FEATURES.ROLE_MANAGE] as const;

/** Route guard for the Policy Studio surface. Backend re-checks RoleManage. */
export function RequireRoleManageRoute() {
  const { session } = useAuth();
  const canManageRoles =
    hasAnyRole(session?.roles, ROLE_MANAGE_ROLES) ||
    hasAnyFeatureGrant(session?.feature_grants, ROLE_MANAGE_FEATURES);

  if (!canManageRoles) {
    return <Navigate to="/work-hub" replace />;
  }

  return <Outlet />;
}
