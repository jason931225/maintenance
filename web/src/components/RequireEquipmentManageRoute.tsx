import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";
import { FEATURES, hasAnyFeatureGrant, hasAnyRole, ROLES } from "./shell/nav";

/** JWT roles that hold EquipmentManage (backend matrix: ADMIN/EXECUTIVE/SUPER_ADMIN). */
const EQUIPMENT_MANAGE_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;
const EQUIPMENT_MANAGE_FEATURES = [FEATURES.EQUIPMENT_MANAGE] as const;

/**
 * Layout route guard for the equipment-manage surface. Renders the nested
 * route when the session carries an EquipmentManage role claim; otherwise
 * redirects to the equipment browse page. The backend re-checks the feature
 * gate on every write call.
 */
export function RequireEquipmentManageRoute() {
  const { session } = useAuth();
  const canManage =
    hasAnyRole(session?.roles, EQUIPMENT_MANAGE_ROLES) ||
    hasAnyFeatureGrant(session?.feature_grants, EQUIPMENT_MANAGE_FEATURES);

  if (!canManage) {
    return <Navigate to="/equipment" replace />;
  }

  return <Outlet />;
}
