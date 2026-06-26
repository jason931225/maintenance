import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";
import { hasGroupAdminRole } from "./shell/nav";

/**
 * Layout route guard for tenant-side group management. A tenant ADMIN is not
 * enough: only a live GROUP_ADMIN grant (surfaced in the signed token as a UI
 * hint and re-checked by the backend) may enter this surface.
 */
export function RequireGroupAdminRoute() {
  const { session } = useAuth();
  if (!hasGroupAdminRole(session?.group_roles)) {
    return <Navigate to="/dispatch" replace />;
  }

  return <Outlet />;
}
