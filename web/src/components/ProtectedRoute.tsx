import { Navigate, Outlet, useLocation } from "react-router-dom";

import { PageSpinner } from "./states/PageSpinner";
import { useAuth } from "../context/auth";

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

  return children ? <>{children}</> : <Outlet />;
}
