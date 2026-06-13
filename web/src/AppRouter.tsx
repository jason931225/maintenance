import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/shell/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";
import { WallBoardPage } from "./pages/WallBoardPage";
import { DispatchPage } from "./pages/DispatchPage";
import { IntakePage } from "./pages/IntakePage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { KpiPage } from "./pages/KpiPage";
import { MessengerPage } from "./pages/MessengerPage";
import { EquipmentPage } from "./pages/EquipmentPage";
import { LocationSettingsPage } from "./pages/LocationSettingsPage";

export function AppRouter() {
  return (
    <Routes>
      {/* Shell-less full-screen routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/wallboard" element={<WallBoardPage />} />

      {/* Auth guard — redirects to /login when unauthenticated */}
      <Route element={<ProtectedRoute />}>
        {/* App shell layout */}
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dispatch" replace />} />
          <Route path="/dispatch" element={<DispatchPage />} />
          <Route path="/intake" element={<IntakePage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/kpi" element={<KpiPage />} />
          <Route path="/messenger" element={<MessengerPage />} />
          <Route path="/equipment" element={<EquipmentPage />} />
          <Route path="/settings" element={<Navigate to="/settings/location" replace />} />
          <Route path="/settings/location" element={<LocationSettingsPage />} />
          <Route path="*" element={<Navigate to="/dispatch" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
