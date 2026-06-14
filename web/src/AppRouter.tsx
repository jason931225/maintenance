import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/shell/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { RequireAdminRoute } from "./components/RequireAdminRoute";
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
        {/* Shell-less initial-settings passkey enrollment (first OTP sign-in) */}
        <Route
          path="/onboarding"
          element={
            <Suspense fallback={<PageSpinner />}>
              <OnboardingPage />
            </Suspense>
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
          <Route path="/settings" element={<Navigate to="/settings/location" replace />} />
          <Route path="/settings/location" element={<LocationSettingsPage />} />
          <Route element={<RequireAdminRoute />}>
            <Route path="/settings/security" element={<AdminSettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/dispatch" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
