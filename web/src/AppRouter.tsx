import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/shell/AppShell";
import { PlatformShell } from "./components/shell/PlatformShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { RequireAdminRoute } from "./components/RequireAdminRoute";
import { RequirePlatformRoute } from "./components/RequirePlatformRoute";
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
const DailyPlanPage = lazy(() =>
  import("./pages/DailyPlanPage").then((m) => ({ default: m.DailyPlanPage })),
);
const KpiPage = lazy(() =>
  import("./pages/KpiPage").then((m) => ({ default: m.KpiPage })),
);
const OpsDashboardPage = lazy(() =>
  import("./pages/OpsDashboardPage").then((m) => ({
    default: m.OpsDashboardPage,
  })),
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
const FinancialPage = lazy(() =>
  import("./pages/FinancialPage").then((m) => ({ default: m.FinancialPage })),
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
const PlatformTenantsPage = lazy(() =>
  import("./pages/PlatformTenantsPage").then((m) => ({
    default: m.PlatformTenantsPage,
  })),
);
const PlatformOnboardPage = lazy(() =>
  import("./pages/PlatformOnboardPage").then((m) => ({
    default: m.PlatformOnboardPage,
  })),
);
const PlatformOpsPage = lazy(() =>
  import("./features/platform/PlatformOpsPage").then((m) => ({
    default: m.PlatformOpsPage,
  })),
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

        {/* Vendor platform-admin console — its own shell + nav, gated by the
            `platform` JWT claim. A tenant session hitting /platform is bounced
            to /dispatch by RequirePlatformRoute; a platform session hitting a
            tenant route is bounced to /platform by ProtectedRoute. */}
        <Route element={<RequirePlatformRoute />}>
          <Route path="/platform" element={<PlatformShell />}>
            <Route index element={<Navigate to="/platform/tenants" replace />} />
            <Route path="tenants" element={<PlatformTenantsPage />} />
            <Route path="ops" element={<PlatformOpsPage />} />
            <Route path="onboard" element={<PlatformOnboardPage />} />
            <Route path="*" element={<Navigate to="/platform/tenants" replace />} />
          </Route>
        </Route>

        {/* App shell layout */}
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dispatch" replace />} />
          <Route path="/dispatch" element={<DispatchPage />} />
          <Route path="/intake" element={<IntakePage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/daily-plan" element={<DailyPlanPage />} />
          <Route path="/kpi" element={<KpiPage />} />
          <Route path="/messenger" element={<MessengerPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/equipment" element={<EquipmentPage />} />
          <Route path="/financial" element={<FinancialPage />} />
          <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="/settings/profile" element={<ProfilePage />} />
          <Route path="/settings/location" element={<LocationSettingsPage />} />
          <Route element={<RequireAdminRoute />}>
            <Route path="/ops" element={<OpsDashboardPage />} />
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
