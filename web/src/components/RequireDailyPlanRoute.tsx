import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";
import { hasAnyRole, ROLES } from "./shell/nav";

/**
 * JWT roles that may act on daily work plans (backend `DailyPlanRequest`:
 * MECHANIC/ADMIN/SUPER_ADMIN). Receptionist and Executive are denied — mirrors
 * the `daily-plan` nav gate so a hidden nav item is not reachable by URL.
 */
const DAILY_PLAN_ROLES = [
  ROLES.MECHANIC,
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
] as const;

/**
 * Layout route guard for `/daily-plan`. Renders the nested route when the
 * session carries a DailyPlanRequest-capable role, otherwise redirects to the
 * default landing page — matching the `RequireAdminRoute` pattern so the page is
 * unreachable by direct URL for roles whose nav hides it. The backend re-checks
 * authorization on every call.
 */
export function RequireDailyPlanRoute() {
  const { session } = useAuth();

  if (!hasAnyRole(session?.roles, DAILY_PLAN_ROLES)) {
    return <Navigate to="/dispatch" replace />;
  }

  return <Outlet />;
}
