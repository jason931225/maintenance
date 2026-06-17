import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/shell/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { RequireAdminRoute } from "./components/RequireAdminRoute";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { PageSpinner } from "./components/states/PageSpinner";
import { LoginPage } from "./pages/LoginPage";
import { WallBoardPage } from "./pages/WallBoardPage";
import { CustomerIntakePage } from "./pages/CustomerIntakePage";

// Authenticated-shell pages are code-split so the login / wallboard / public
// intake fast paths don't pay for them. Each module uses a named export, so we
// re-map it to the `default` shape React.lazy expects.
const OnboardingPage = lazy(() =>
  import("./pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage })),
);
const DispatchPage = lazy(() =>
  import("./pages/DispatchPage").then((m) => ({ default: m.DispatchPage })),
);
const IntakePage = lazy(() =>
  import("./pages/IntakePage").then((m) => ({ default: m.IntakePage })),
);
const ApprovalsPage = lazy(() =>
  import("./pages/ApprovalsPage").then((m) => ({ default: m.ApprovalsPage })),
);
const KpiPage = lazy(() =>
  import("./pages/KpiPage").then((m) => ({ default: m.KpiPage })),
);
const MessengerPage = lazy(() =>
  import("./pages/MessengerPage").then((m) => ({ default: m.MessengerPage })),
);
const SupportPage = lazy(() =>
  import("./pages/SupportPage").then((m) => ({ default: m.SupportPage })),
);
const EquipmentPage = lazy(() =>
  import("./pages/EquipmentPage").then((m) => ({ default: m.EquipmentPage })),
);
const LocationSettingsPage = lazy(() =>
  import("./pages/LocationSettingsPage").then((m) => ({
    default: m.LocationSettingsPage,
  })),
);
const AdminSettingsPage = lazy(() =>
  import("./pages/AdminSettingsPage").then((m) => ({
    default: m.AdminSettingsPage,
  })),
);
const UsersPage = lazy(() =>
  import("./pages/UsersPage").then((m) => ({ default: m.UsersPage })),
);
const OrgPage = lazy(() =>
  import("./pages/OrgPage").then((m) => ({ default: m.OrgPage })),
);
const ProfilePage = lazy(() =>
  import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })),
);

export function AppRouter() {
  return (
    <Routes>
      {/* Shell-less full-screen routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/wallboard" element={<WallBoardPage />} />
      {/* Public, unauthenticated customer support intake */}
      <Route path="/support/new" element={<CustomerIntakePage />} />

      {/* Auth guard — redirects to /login when unauthenticated */}
      <Route element={<ProtectedRoute />}>
        {/* Shell-less initial-settings passkey enrollment (first OTP sign-in).
            Renders outside the shell, so it needs its own error boundary to
            contain a crash rather than falling through to the blank top-level
            fallback. */}
        <Route
          path="/onboarding"
          element={
            <RouteErrorBoundary>
              <Suspense fallback={<PageSpinner />}>
                <OnboardingPage />
              </Suspense>
            </RouteErrorBoundary>
          }
        />

        {/* App shell layout */}
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dispatch" replace />} />
          <Route path="/dispatch" element={<DispatchPage />} />
          <Route path="/intake" element={<IntakePage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/kpi" element={<KpiPage />} />
          <Route path="/messenger" element={<MessengerPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/equipment" element={<EquipmentPage />} />
          <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="/settings/profile" element={<ProfilePage />} />
          <Route path="/settings/location" element={<LocationSettingsPage />} />
          <Route element={<RequireAdminRoute />}>
            <Route path="/settings/users" element={<UsersPage />} />
            <Route path="/settings/org" element={<OrgPage />} />
            <Route path="/settings/security" element={<AdminSettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/dispatch" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
