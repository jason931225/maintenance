import { Navigate, Outlet, useLocation } from "react-router-dom";

import { PageSpinner } from "./states/PageSpinner";
import { hasGrantedConsoleAccess } from "./shell/nav";
import { useAuth } from "../context/auth";

/**
 * Paths a no-grant MEMBER may still reach: the pending landing, their own
 * profile, and principal-bound My Attendance self-service. Any other tenant
 * path is redirected to /pending so they never land on a 403 screen.
 */
const MEMBER_ALLOWED_PATHS = ["/pending", "/settings/profile", "/attendance"];

/**
 * Used as a layout route element: renders <Outlet /> when authenticated,
 * redirects to /login otherwise. A session that still requires passkey setup
 * (first OTP sign-in) is forced into the /onboarding enrollment step until a
 * passkey is enrolled.
 *
 * The session is recovered on boot via an async silent cookie refresh, so we
 * must WAIT for that to settle before deciding authenticated-vs-redirect —
 * otherwise a hard page reload would briefly bounce a logged-in user to /login.
 */
export function ProtectedRoute({ children }: { children?: React.ReactNode }) {
  const { session, restoring } = useAuth();
  const location = useLocation();

  if (restoring) {
    return <PageSpinner />;
  }

  if (!session) {
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname)}`}
        replace
      />
    );
  }

  // Forced passkey enrollment is a shared pre-tenant step: a first OTP sign-in
  // (tenant OR platform admin) must enroll a passkey before reaching any console.
  // Handle it entirely here — redirecting to /onboarding, or rendering it when
  // already there — so a passkey-less platform admin is NOT bounced to /platform
  // (below) before it can enroll.
  if (session.requires_passkey_setup) {
    if (location.pathname !== "/onboarding") {
      return <Navigate to="/onboarding" replace />;
    }
    return children ? <>{children}</> : <Outlet />;
  }

  // A platform-admin (vendor) session belongs in the /platform console; bounce it
  // out of any tenant route. The mirror case (a tenant session on /platform) is
  // handled by RequirePlatformRoute. The backend re-checks on every call.
  if (session.isPlatform && !location.pathname.startsWith("/platform")) {
    return <Navigate to="/platform" replace />;
  }

  // A just-signed-up tenant user with no role, group-admin, or runtime feature
  // grant yet (empty roles or `["MEMBER"]`) is default-denied every Feature but
  // Login by the backend, so every gated destination 403s. Route them to /pending
  // instead of onto a generic error screen; allow only their pending/profile/
  // attendance self-service floor. The /console exception remains unchanged.
  if (
    !hasGrantedConsoleAccess(
      session.roles,
      session.group_roles,
      session.feature_grants,
    ) &&
    !MEMBER_ALLOWED_PATHS.includes(location.pathname) &&
    !location.pathname.startsWith("/console")
  ) {
    return <Navigate to="/pending" replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}
