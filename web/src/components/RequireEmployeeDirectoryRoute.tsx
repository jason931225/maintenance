import { Navigate, Outlet } from "react-router-dom";

import { hasAnyRole, ROLES } from "./shell/nav";
import { useAuth } from "../context/auth";

/** HR employee directory read roles: ADMIN/EXECUTIVE/SUPER_ADMIN. */
const EMPLOYEE_DIRECTORY_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

export function RequireEmployeeDirectoryRoute() {
  const { session } = useAuth();

  if (!hasAnyRole(session?.roles, EMPLOYEE_DIRECTORY_ROLES)) {
    return <Navigate to="/dispatch" replace />;
  }

  return <Outlet />;
}
