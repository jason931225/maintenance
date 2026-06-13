import { Navigate, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../context/auth";

/**
 * Used as a layout route element: renders <Outlet /> when authenticated,
 * redirects to /login otherwise. A session that still requires passkey setup
 * (first OTP sign-in) is forced into the /onboarding enrollment step until a
 * passkey is enrolled.
 *
 * The session hydrates synchronously from sessionStorage, so there is no async
 * loading phase to guard against here.
 */
export function ProtectedRoute({ children }: { children?: React.ReactNode }) {
  const { session } = useAuth();
  const location = useLocation();

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
