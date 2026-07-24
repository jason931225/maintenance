import { Navigate, Outlet } from "react-router";

import { useAuth } from "../context/auth";

/** JWT roles that may access admin-only surfaces. */
const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN"];

/**
 * Layout route guard for admin-only pages. Renders the nested route when the
 * session carries an ADMIN / SUPER_ADMIN role claim, otherwise redirects to the
 * default landing page. The backend re-checks authorization on every call.
 */
export function RequireAdminRoute() {
  const { session } = useAuth();
  const isAdmin = (session?.roles ?? []).some((role) =>
    ADMIN_ROLES.includes(role),
  );

  if (!isAdmin) {
    return <Navigate to="/overview" replace />;
  }

  return <Outlet />;
}
