import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/shell/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { RequireAdminRoute } from "./components/RequireAdminRoute";
import { LoginPage } from "./pages/LoginPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { WallBoardPage } from "./pages/WallBoardPage";
import { DispatchPage } from "./pages/DispatchPage";
import { IntakePage } from "./pages/IntakePage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { KpiPage } from "./pages/KpiPage";
import { MessengerPage } from "./pages/MessengerPage";
import { SupportPage } from "./pages/SupportPage";
import { CustomerIntakePage } from "./pages/CustomerIntakePage";
import { EquipmentPage } from "./pages/EquipmentPage";
import { LocationSettingsPage } from "./pages/LocationSettingsPage";
import { AdminSettingsPage } from "./pages/AdminSettingsPage";

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
        <Route path="/onboarding" element={<OnboardingPage />} />

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
