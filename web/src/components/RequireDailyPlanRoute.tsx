import { Navigate, Outlet } from "react-router";

import { useAuth } from "../context/auth";
import { FEATURES, hasAnyFeatureGrant, hasAnyRole, ROLES } from "./shell/nav";

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
const DAILY_PLAN_FEATURES = [
  FEATURES.DAILY_PLAN_REQUEST,
  FEATURES.DAILY_PLAN_REVIEW,
  FEATURES.ORG_WIDE_QUEUE_TRIAGE,
] as const;

export function RequireDailyPlanRoute() {
  const { session } = useAuth();

  if (
    !hasAnyRole(session?.roles, DAILY_PLAN_ROLES) &&
    !hasAnyFeatureGrant(session?.feature_grants, DAILY_PLAN_FEATURES)
  ) {
    return <Navigate to="/overview" replace />;
  }

  return <Outlet />;
}
