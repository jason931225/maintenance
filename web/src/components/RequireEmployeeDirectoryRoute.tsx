import { Navigate, Outlet } from "react-router-dom";

import { FEATURES, hasAnyFeatureGrant, hasAnyRole, ROLES } from "./shell/nav";
import { useAuth } from "../context/auth";

/** HR employee directory read roles: ADMIN/EXECUTIVE/SUPER_ADMIN. */
const EMPLOYEE_DIRECTORY_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

const EMPLOYEE_DIRECTORY_FEATURES = [FEATURES.EMPLOYEE_DIRECTORY_READ] as const;

export function RequireEmployeeDirectoryRoute() {
  const { session } = useAuth();

  if (
    !hasAnyRole(session?.roles, EMPLOYEE_DIRECTORY_ROLES) &&
    !hasAnyFeatureGrant(session?.feature_grants, EMPLOYEE_DIRECTORY_FEATURES)
  ) {
    return <Navigate to="/overview" replace />;
  }

  return <Outlet />;
}
