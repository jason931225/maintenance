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

  if (session.requires_passkey_setup && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}
