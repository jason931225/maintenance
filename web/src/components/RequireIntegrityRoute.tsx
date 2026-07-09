import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";
import { FEATURES, hasAnyFeatureGrant, hasAnyRole, ROLES } from "./shell/nav";

/**
 * JWT roles allowed to read and triage integrity findings (backend
 * `IntegrityFindingsRead` / `IntegrityFindingTriage`, matrix row
 * `[D, D, D, D, A, A]` for [MEMBER, RECEPTIONIST, MECHANIC, ADMIN, EXECUTIVE,
 * SUPER_ADMIN]). EXECUTIVE + SUPER_ADMIN only — an ADMIN is deliberately denied
 * because the findings are labor-law sensitive (an ADMIN must not read findings
 * about themselves or their subordinates). This mirrors the `integrity` nav gate.
 */
const INTEGRITY_ROLES = [ROLES.EXECUTIVE, ROLES.SUPER_ADMIN] as const;

/**
 * Layout route guard for `/integrity`. Renders the nested route only when the
 * session carries an EXECUTIVE or SUPER_ADMIN role, otherwise redirects to the
 * default landing page — so the dashboard is unreachable by direct URL for roles
 * (including ADMIN) whose nav hides it. The backend re-checks authorization on
 * every call.
 */
const INTEGRITY_FEATURES = [
  FEATURES.INTEGRITY_FINDINGS_READ,
  FEATURES.INTEGRITY_FINDING_TRIAGE,
] as const;

export function RequireIntegrityRoute() {
  const { session } = useAuth();

  if (
    !hasAnyRole(session?.roles, INTEGRITY_ROLES) &&
    !hasAnyFeatureGrant(session?.feature_grants, INTEGRITY_FEATURES)
  ) {
    return <Navigate to="/overview" replace />;
  }

  return <Outlet />;
}
