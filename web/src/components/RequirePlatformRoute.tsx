import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";

/**
 * Layout route guard for the vendor platform-admin console (`/platform/*`).
 * Renders the nested route only when the session carries the `platform` JWT
 * claim; a tenant session is redirected into the tenant app. The backend
 * re-checks authorization on every platform data call (a tenant token is
 * rejected on `/api/platform/*` with 403).
 */
export function RequirePlatformRoute() {
  const { session } = useAuth();

  if (!session?.isPlatform) {
    return <Navigate to="/work-hub" replace />;
  }

  return <Outlet />;
}
