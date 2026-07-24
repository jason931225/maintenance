import { Navigate, Outlet } from "react-router";

import { useAuth } from "../context/auth";
import { FEATURES, hasAnyFeatureGrant, hasAnyRole, ROLES } from "./shell/nav";

/**
 * JWT roles allowed to read KPI dashboards (backend `KpiRead`:
 * ADMIN/EXECUTIVE/SUPER_ADMIN). Receptionist and Mechanic are denied — mirrors
 * the `kpi` nav gate so a hidden nav item is not reachable by URL.
 */
const KPI_ROLES = [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.SUPER_ADMIN] as const;

/**
 * Layout route guard for `/kpi`. Renders the nested route when the session
 * carries a KpiRead-capable role, otherwise redirects to the default landing
 * page — matching the `RequireAdminRoute` pattern so the dashboard is
 * unreachable by direct URL for roles whose nav hides it. The backend re-checks
 * authorization on every call.
 */
const KPI_FEATURES = [FEATURES.KPI_READ] as const;

export function RequireKpiRoute() {
  const { session } = useAuth();

  if (
    !hasAnyRole(session?.roles, KPI_ROLES) &&
    !hasAnyFeatureGrant(session?.feature_grants, KPI_FEATURES)
  ) {
    return <Navigate to="/overview" replace />;
  }

  return <Outlet />;
}
