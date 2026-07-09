import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";
import { FEATURES, hasAnyFeatureGrant, hasAnyRole, ROLES } from "./shell/nav";

/**
 * MailUse holders (backend `MailUse`): receptionist, admin, executive, and
 * super admin. Mechanics and MEMBER sessions do not receive the corporate
 * mailbox route, matching the nav gate for `mail`.
 */
const MAIL_USE_ROLES = [
  ROLES.RECEPTIONIST,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

const MAIL_USE_FEATURES = [FEATURES.MAIL_USE] as const;

export function RequireMailUseRoute() {
  const { session } = useAuth();

  if (
    !hasAnyRole(session?.roles, MAIL_USE_ROLES) &&
    !hasAnyFeatureGrant(session?.feature_grants, MAIL_USE_FEATURES)
  ) {
    return <Navigate to="/overview" replace />;
  }

  return <Outlet />;
}
