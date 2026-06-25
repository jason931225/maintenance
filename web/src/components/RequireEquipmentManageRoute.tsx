import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";

/** JWT roles that hold EquipmentManage (backend matrix: ADMIN/EXECUTIVE/SUPER_ADMIN). */
const EQUIPMENT_MANAGE_ROLES = ["ADMIN", "EXECUTIVE", "SUPER_ADMIN"];

/**
 * Layout route guard for the equipment-manage surface. Renders the nested
 * route when the session carries an EquipmentManage role claim; otherwise
 * redirects to the equipment browse page. The backend re-checks the feature
 * gate on every write call.
 */
export function RequireEquipmentManageRoute() {
  const { session } = useAuth();
  const canManage = (session?.roles ?? []).some((role) =>
    EQUIPMENT_MANAGE_ROLES.includes(role),
  );

  if (!canManage) {
    return <Navigate to="/equipment" replace />;
  }

  return <Outlet />;
}
