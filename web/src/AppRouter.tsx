import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { isConsoleHost } from "./lib/consoleUrl";
import { ConsoleRolloutBoundary } from "./console/rollout/ConsoleRolloutBoundary";
import { isConsoleDevelopmentPreviewEnabled } from "./console/rollout/developmentPreview";
import {
  EXPOSED_SCREEN_KEYS,
  MOUNTED_SCREEN_KEYS,
} from "./console/shell/nav";

import { PublicLayout } from "./components/public/PublicLayout";
import { AppShell } from "./components/shell/AppShell";
import { PlatformShell } from "./components/shell/PlatformShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { RequireAdminRoute } from "./components/RequireAdminRoute";
import { RequireEquipmentManageRoute } from "./components/RequireEquipmentManageRoute";
import { RequireEmployeeDirectoryRoute } from "./components/RequireEmployeeDirectoryRoute";
import { RequireDailyPlanRoute } from "./components/RequireDailyPlanRoute";
import { RequireGroupAdminRoute } from "./components/RequireGroupAdminRoute";
import { RequireIntegrityRoute } from "./components/RequireIntegrityRoute";
import { RequireKpiRoute } from "./components/RequireKpiRoute";
import { RequireMailUseRoute } from "./components/RequireMailUseRoute";
import { RequireNavItemRoute } from "./components/RequireNavItemRoute";
import { RequirePlatformRoute } from "./components/RequirePlatformRoute";
import { RequireRoleManageRoute } from "./components/RequireRoleManageRoute";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { PageSpinner } from "./components/states/PageSpinner";
import { LoginPage } from "./pages/LoginPage";
import { WallBoardPage } from "./pages/WallBoardPage";
import { CustomerIntakePage } from "./pages/CustomerIntakePage";
// KNL storefront (#6). Public marketing pages render inside <PublicLayout/> and
// supersede the previous #10 LandingPage as the primary public surface. Default
// exports, eager-loaded — they sit on the public, unauthenticated fast path.
import StorefrontHomePage from "./pages/StorefrontHomePage";
import RentalPage from "./pages/RentalPage";
import UsedSalesPage from "./pages/UsedSalesPage";
import MaintenancePage from "./pages/MaintenancePage";
import AboutPage from "./pages/AboutPage";
import ContactPage from "./pages/ContactPage";
import PrivacyNoticePage from "./pages/PrivacyNoticePage";
import PlatformFsmPage from "./pages/PlatformFsmPage";

// Authenticated-shell pages are code-split so the login / public intake fast
// paths don't pay for them. Each module uses a named export, so we
// re-map it to the `default` shape React.lazy expects.
const OnboardingPage = lazy(() =>
  import("./pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage })),
);
const PendingPage = lazy(() =>
  import("./pages/PendingPage").then((m) => ({ default: m.PendingPage })),
);
// ConsoleShell hosts the mounted-persistent /overview and /attendance screens
// (UI-M1b). It imports those pages directly, so they are no longer lazy here.
const ConsoleShell = lazy(() =>
  import("./components/shell/ConsoleShell").then((m) => ({ default: m.ConsoleShell })),
);
// Mounted carbon-copy development inventory. Production routing remains behind
// both the server-owned rollout decision and the ADR-0025 evidence manifest.
const ConsoleApp = lazy(() =>
  import("./console/ConsoleApp").then((m) => ({ default: m.ConsoleApp })),
);
// Dev-only capture harness for the carbon-copy window/pin engine (P0.2). Behind
// the auth guard like /console; carries no product nav, exists so the fidelity
// rig can screenshot the four window states in isolation before the engine is
// integrated into the shell in a later slice.
const WindowEngineHarness = lazy(() =>
  import("./console/window/harness").then((m) => ({ default: m.WindowEngineHarness })),
);
// Standalone dev harness for the P0.4 generic module template (charter §3 P0.4).
// Not a product surface — it renders one ModuleScreen against a live read to
// prove the template end to end until the P0.1 shell hosts modules for real.
const ModuleHarness = lazy(() =>
  import("./console/module/ModuleHarness").then((m) => ({ default: m.ModuleHarness })),
);
// Dev-only lifecycle-card capture harness (P0.5). Standalone, shell-less.
const LifecycleHarness = lazy(() =>
  import("./console/lifecycle/harness").then((m) => ({ default: m.LifecycleHarness })),
);
const DispatchPage = lazy(() =>
  import("./pages/DispatchPage").then((m) => ({ default: m.DispatchPage })),
);
const WorkOrderDetailPage = lazy(() =>
  import("./pages/WorkOrderDetailPage").then((m) => ({
    default: m.WorkOrderDetailPage,
  })),
);
const DispatchMapPage = lazy(() =>
  import("./pages/DispatchMapPage").then((m) => ({
    default: m.DispatchMapPage,
  })),
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
const CollaborationPage = lazy(() =>
  import("./pages/CollaborationPage").then((m) => ({
    default: m.CollaborationPage,
  })),
);
const KpiPage = lazy(() =>
  import("./pages/KpiPage").then((m) => ({ default: m.KpiPage })),
);
const OperationsIntelligencePage = lazy(() =>
  import("./pages/OperationsIntelligencePage").then((m) => ({
    default: m.OperationsIntelligencePage,
  })),
);
const InspectionPage = lazy(() =>
  import("./pages/InspectionPage").then((m) => ({ default: m.InspectionPage })),
);
const OpsDashboardPage = lazy(() =>
  import("./pages/OpsDashboardPage").then((m) => ({
    default: m.OpsDashboardPage,
  })),
);
const ReportingPage = lazy(() =>
  import("./pages/ReportingPage").then((m) => ({ default: m.ReportingPage })),
);
const MessengerPage = lazy(() =>
  import("./pages/MessengerPage").then((m) => ({ default: m.MessengerPage })),
);
const MailPage = lazy(() =>
  import("./pages/MailPage").then((m) => ({ default: m.MailPage })),
);
const SupportPage = lazy(() =>
  import("./pages/SupportPage").then((m) => ({ default: m.SupportPage })),
);
const FacilitiesPage = lazy(() =>
  import("./pages/FacilitiesPage").then((m) => ({ default: m.FacilitiesPage })),
);
const EquipmentPage = lazy(() =>
  import("./pages/EquipmentPage").then((m) => ({ default: m.EquipmentPage })),
);
const EquipmentBrowsePage = lazy(() =>
  import("./pages/EquipmentBrowsePage").then((m) => ({
    default: m.EquipmentBrowsePage,
  })),
);
const EquipmentDetailPage = lazy(() =>
  import("./pages/EquipmentDetailPage").then((m) => ({
    default: m.EquipmentDetailPage,
  })),
);
const EquipmentManagePage = lazy(() =>
  import("./pages/EquipmentManagePage").then((m) => ({
    default: m.EquipmentManagePage,
  })),
);
const Equipment3rConsoleRoute = lazy(() =>
  import("./console/equipment").then((m) => ({
    default: m.EquipmentScreenBody,
  })),
);
const ConsoleModuleRoute = lazy(() =>
  import("./console/modules").then((m) => ({
    default: m.ConsoleModuleRoute,
  })),
);
const FinancialPage = lazy(() =>
  import("./pages/FinancialPage").then((m) => ({ default: m.FinancialPage })),
);
const PayrollPage = lazy(() =>
  import("./pages/PayrollPage").then((m) => ({ default: m.PayrollPage })),
);
const LeaveManagementPage = lazy(() =>
  import("./pages/LeaveManagementPage").then((m) => ({
    default: m.LeaveManagementPage,
  })),
);
const InsuranceAssistPage = lazy(() =>
  import("./pages/InsuranceAssistPage").then((m) => ({
    default: m.InsuranceAssistPage,
  })),
);
const EmployeesPage = lazy(() =>
  import("./pages/EmployeesPage").then((m) => ({ default: m.EmployeesPage })),
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
const PolicyStudioPage = lazy(() =>
  import("./pages/PolicyStudioPage").then((m) => ({
    default: m.PolicyStudioPage,
  })),
);
const WorkflowStudioPage = lazy(() =>
  import("./pages/WorkflowStudioPage").then((m) => ({
    default: m.WorkflowStudioPage,
  })),
);
const OrgPage = lazy(() =>
  import("./pages/OrgPage").then((m) => ({ default: m.OrgPage })),
);
const GroupAdminPage = lazy(() =>
  import("./pages/GroupAdminPage").then((m) => ({
    default: m.GroupAdminPage,
  })),
);
const SitesPage = lazy(() =>
  import("./pages/SitesPage").then((m) => ({ default: m.SitesPage })),
);
const ProfilePage = lazy(() =>
  import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })),
);
const PlatformTenantsPage = lazy(() =>
  import("./pages/PlatformTenantsPage").then((m) => ({
    default: m.PlatformTenantsPage,
  })),
);
const PlatformGroupsPage = lazy(() =>
  import("./pages/PlatformGroupsPage").then((m) => ({
    default: m.PlatformGroupsPage,
  })),
);
const PlatformOnboardPage = lazy(() =>
  import("./pages/PlatformOnboardPage").then((m) => ({
    default: m.PlatformOnboardPage,
  })),
);
const PlatformAccountPage = lazy(() =>
  import("./pages/PlatformAccountPage").then((m) => ({
    default: m.PlatformAccountPage,
  })),
);
const PlatformOpsPage = lazy(() =>
  import("./features/platform/PlatformOpsPage").then((m) => ({
    default: m.PlatformOpsPage,
  })),
);
const CatalogAdminPage = lazy(() =>
  import("./pages/CatalogAdminPage").then((m) => ({
    default: m.CatalogAdminPage,
  })),
);
const IntegrityPage = lazy(() =>
  import("./pages/IntegrityPage").then((m) => ({ default: m.IntegrityPage })),
);
// Foundry / analytics surfaces reshaped in the console overhaul (Phase A). The
// ontology workspace wraps the object explorer; ontology / automate /
// config-console are REST-wired (Phase C wave 1); forecast is a wire-pending
// stub that reserves its route + nav slot.
const OntologyPage = lazy(() =>
  import("./pages/OntologyPage").then((m) => ({ default: m.OntologyPage })),
);
const AutomatePage = lazy(() =>
  import("./pages/AutomatePage").then((m) => ({ default: m.AutomatePage })),
);
const ForecastPage = lazy(() =>
  import("./pages/ForecastPage").then((m) => ({ default: m.ForecastPage })),
);
const ConfigConsolePage = lazy(() =>
  import("./pages/ConfigConsolePage").then((m) => ({
    default: m.ConfigConsolePage,
  })),
);

// Public KNL storefront/marketing paths. On the dedicated console host these
// public-site pages don't belong on the ops origin, so `/` (+ every marketing
// path) bounces to /console; on apex/www they render the storefront as normal.
// NOTE: /support/new is deliberately excluded — the fsm-console-redirect Traefik
// middleware 301s fsm.<domain>/<path> → console.<domain>/<path> path-preserving,
// so already-distributed customer intake links/QR codes land on the console host
// and must still reach the public intake, not bounce to /console.
const STOREFRONT_PATHS = [
  "/",
  "/home",
  "/landing",
  "/rental",
  "/used",
  "/maintenance",
  "/about",
  "/contact",
  "/privacy",
  "/platform-fsm",
];

export function AppRouter() {
  // Host-level decision (not the per-org rollout flag): the console host serves
  // the console at its root, apex/www keep the storefront. localhost/dev is not
  // a console host, so dev e2e still lands on `/` = storefront.
  const consoleHost = isConsoleHost();
  // Local-only full-console preview. Both guards are required: Vite replaces
  // DEV with false in production builds, while the explicit flag keeps normal
  // development and test runs on the production-faithful rollout path.
  const consoleDevelopmentPreview = isConsoleDevelopmentPreviewEnabled({
    dev: import.meta.env.DEV,
    flag: import.meta.env.VITE_CONSOLE_DEV_PREVIEW,
  });
  return (
    <Routes>
      {/* Shell-less full-screen routes */}
      {/* Public KNL storefront (#6). Nested under PublicLayout (site-header +
          footer); each page renders only its own <main>. This unifies and
          replaces the previous #10 LandingPage — `/` and `/landing` both resolve
          to the KNL home, the primary public surface. Placed before the
          ProtectedRoute guard so it stays unauthenticated. */}
      {consoleHost ? (
        // Console host: the storefront/marketing paths belong on apex/www, so
        // land the SPA root (and the rest) on the console. /login, the /console
        // app, and the public /support/new intake (hoisted below) are declared
        // outside this block and stay intact.
        <>
          {STOREFRONT_PATHS.map((path) => (
            <Route
              key={path}
              path={path}
              element={<Navigate to="/console" replace />}
            />
          ))}
        </>
      ) : (
      <Route element={<PublicLayout />}>
        <Route path="/" element={<StorefrontHomePage />} />
        <Route path="/home" element={<StorefrontHomePage />} />
        <Route path="/landing" element={<StorefrontHomePage />} />
        <Route path="/rental" element={<RentalPage />} />
        <Route path="/used" element={<UsedSalesPage />} />
        <Route path="/maintenance" element={<MaintenancePage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/privacy" element={<PrivacyNoticePage />} />
        {/* Public FSM-platform showcase. The gated console owns /platform; this
            public marketing surface is mounted at /platform-fsm so it stays
            unauthenticated. */}
        <Route path="/platform-fsm" element={<PlatformFsmPage />} />
      </Route>
      )}
      {/* Public, unauthenticated customer support intake — the dominant
          storefront CTA target, mounted on EVERY host (declared once: the
          enterprise-ux-parity gate forbids duplicate path strings). On apex/www
          it is the storefront CTA; on the console host the path-preserving
          fsm→console 301 lands already-distributed intake links/QR codes here,
          so it must not bounce to /console. PublicLayout supplies the KNL
          header/nav/footer chrome on both. */}
      <Route element={<PublicLayout />}>
        <Route path="/support/new" element={<CustomerIntakePage />} />
      </Route>
      <Route path="/login" element={<LoginPage />} />

      {/* Auth guard — redirects to /login when unauthenticated */}
      <Route element={<ProtectedRoute />}>
        {/* Shell-less wallboard. It reads tenant work-order/KPI data, so route
            through the auth guard before the page starts protected API calls. */}
        <Route path="/wallboard" element={<WallBoardPage />} />

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

        {/* Shell-less landing for a just-signed-up user with no role grant yet
            (empty roles or `["MEMBER"]`). ProtectedRoute redirects such a session
            here instead of onto /overview (which the backend 403s). Rendered
            outside the shell — the MEMBER has no nav surface beyond Profile, which
            the page links to. */}
        <Route
          path="/pending"
          element={
            <RouteErrorBoundary>
              <Suspense fallback={<PageSpinner />}>
                <PendingPage />
              </Suspense>
            </RouteErrorBoundary>
          }
        />

        {/* Vendor platform-admin console — its own shell + nav, gated by the
            `platform` JWT claim. A tenant session hitting /platform is bounced
            to /overview by RequirePlatformRoute; a platform session hitting a
            tenant route is bounced to /platform by ProtectedRoute. */}
        <Route element={<RequirePlatformRoute />}>
          <Route path="/platform" element={<PlatformShell />}>
            <Route
              index
              element={<Navigate to="/platform/tenants" replace />}
            />
            <Route path="tenants" element={<PlatformTenantsPage />} />
            <Route path="groups" element={<PlatformGroupsPage />} />
            <Route path="ops" element={<PlatformOpsPage />} />
            <Route path="onboard" element={<PlatformOnboardPage />} />
            <Route path="account" element={<PlatformAccountPage />} />
            <Route
              path="*"
              element={<Navigate to="/platform/tenants" replace />}
            />
          </Route>
        </Route>

        {/* App shell layout. No index (`/`) route: `/` is the public KNL
            storefront home (#6); authenticated entry lands on /overview via the
            login redirect, and the shell catch-all below bounces unknown
            authenticated paths there. */}
        {/* ConsoleShell (UI-M1b) — the window-engine shell owns only /overview
            and /attendance. Keep the pathless shell parent constrained by the
            two explicit child paths below; an unconstrained pathless layout here
            would match every protected URL before AppShell can claim it. */}
        <Route
          element={
            <RouteErrorBoundary>
              <Suspense fallback={<PageSpinner />}>
                <ConsoleShell />
              </Suspense>
            </RouteErrorBoundary>
          }
        >
          <Route path="/overview" element={null} />
          <Route path="/attendance" element={null} />
        </Route>

        {/* The mounted console is DARK inventory until both server rollout and
            the ADR-0025 evidence manifest allow it. Every uncertain state
            returns to the working legacy overview without flashing console UI. */}
        <Route
          path="/console/*"
          element={
            <RouteErrorBoundary>
              <Suspense fallback={<PageSpinner />}>
                {consoleDevelopmentPreview ? (
                  <ConsoleApp screenKeys={MOUNTED_SCREEN_KEYS} />
                ) : (
                  <ConsoleRolloutBoundary approvedScreenKeys={EXPOSED_SCREEN_KEYS}>
                    <ConsoleApp screenKeys={EXPOSED_SCREEN_KEYS} />
                  </ConsoleRolloutBoundary>
                )}
              </Suspense>
            </RouteErrorBoundary>
          }
        />
        <Route
          path="/console/equipment-3r"
          element={
            <RouteErrorBoundary>
              <Suspense fallback={<PageSpinner />}>
                <Equipment3rConsoleRoute />
              </Suspense>
            </RouteErrorBoundary>
          }
        />
        {import.meta.env.DEV && (
          <>
            {/* Dev-only window-engine capture harness (P0.2). Shell-less like
                /console; own error boundary so a crash is contained. */}
            <Route
              path="/console-dev/window"
              element={
                <RouteErrorBoundary>
                  <Suspense fallback={<PageSpinner />}>
                    <WindowEngineHarness />
                  </Suspense>
                </RouteErrorBoundary>
              }
            />

            {/* P0.4 generic module template dev harness. Standalone, behind
                ProtectedRoute; renders one ModuleScreen against a live typed-client
                read (?config=support switches the proof config). Its own error
                boundary contains a crash (it renders shell-less). Route-audit entry
                classified as a dev harness (not a product route). */}
            <Route
              path="/console-dev/module"
              element={
                <RouteErrorBoundary>
                  <Suspense fallback={<PageSpinner />}>
                    <ModuleHarness />
                  </Suspense>
                </RouteErrorBoundary>
              }
            />

            {/* Dev-only lifecycle-card capture harness (P0.5). Shell-less like
                /console; own error boundary so a crash is contained. */}
            <Route
              path="/console-dev/lifecycle"
              element={
                <RouteErrorBoundary>
                  <Suspense fallback={<PageSpinner />}>
                    <LifecycleHarness />
                  </Suspense>
                </RouteErrorBoundary>
              }
            />
          </>
        )}

        {/* UI-M3: /overview replaces /work-hub. Old links and bookmarks keep
            working via this redirect. */}
        <Route path="/work-hub" element={<Navigate to="/overview" replace />} />

        <Route element={<AppShell />}>
          <Route element={<RequireNavItemRoute itemKey="dispatch" />}>
            <Route path="/dispatch" element={<DispatchPage />} />
            {/* Work-order detail (read gate is WorkOrderReadAll). Write controls
                inside are gated to the assigned mechanic. */}
            <Route path="/work-orders/:id" element={<WorkOrderDetailPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="dispatch-map" />}>
            <Route path="/dispatch-map" element={<DispatchMapPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="intake" />}>
            <Route path="/intake" element={<IntakePage />} />
          </Route>
          <Route element={<RequireDailyPlanRoute />}>
            <Route path="/daily-plan" element={<DailyPlanPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="collaboration" />}>
            <Route path="/collaboration" element={<CollaborationPage />} />
          </Route>
          <Route element={<RequireKpiRoute />}>
            <Route path="/kpi" element={<KpiPage />} />
            <Route
              path="/intelligence"
              element={<OperationsIntelligencePage />}
            />
          </Route>
          {/* /integrity: governance findings (#12 / #34). EXECUTIVE/SUPER_ADMIN
              only — RequireIntegrityRoute mirrors the backend matrix and the
              `integrity` nav gate; ADMIN is intentionally excluded. */}
          <Route element={<RequireIntegrityRoute />}>
            <Route path="/integrity" element={<IntegrityPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="reporting" />}>
            <Route path="/reporting" element={<ReportingPage />} />
          </Route>
          {/* Foundry / analytics surfaces (Phase A). Each is PBAC-gated by its
              nav registry entry via RequireNavItemRoute — ontology/forecast on
              the KPI-read gate, automate on the RoleManage (SUPER_ADMIN) gate,
              config-console on the admin gate. */}
          <Route element={<RequireNavItemRoute itemKey="ontology" />}>
            <Route path="/ontology" element={<OntologyPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="automate" />}>
            <Route path="/automate" element={<AutomatePage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="forecast" />}>
            <Route path="/forecast" element={<ForecastPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="config-console" />}>
            <Route path="/config-console" element={<ConfigConsolePage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="messenger" />}>
            <Route path="/messenger" element={<MessengerPage />} />
          </Route>
          <Route element={<RequireMailUseRoute />}>
            <Route path="/mail" element={<MailPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="support" />}>
            <Route path="/support" element={<SupportPage />} />
          </Route>
          {/* /equipment/manage: equipment CRUD (EquipmentManage roles only) */}
          <Route
            element={
              <RequireNavItemRoute
                itemKey="equipment-manage"
                redirectTo="/equipment"
              />
            }
          >
            <Route element={<RequireEquipmentManageRoute />}>
              <Route path="/equipment/manage" element={<EquipmentManagePage />} />
            </Route>
          </Route>
          {/* /equipment: equipment browse list */}
          <Route element={<RequireNavItemRoute itemKey="equipment" />}>
            <Route path="/equipment" element={<EquipmentBrowsePage />} />
            <Route path="/equipment/:id" element={<EquipmentDetailPage />} />
            {/* Legacy equipment page: kept at /equipment/legacy during transition */}
            <Route path="/equipment/legacy" element={<EquipmentPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="facilities" />}>
            <Route path="/facilities" element={<FacilitiesPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="financial" />}>
            <Route path="/financial" element={<FinancialPage />} />
          </Route>
          {/* Module engine surface (L-Modules). Lives at /modules — the carbon-
              copy console owns /console/* (its own viewport, no AppShell), so the
              module engine must not sit at the exact /console path, which would
              outrank the /console/* splat in the router and shadow the shell. */}
          <Route element={<RequireNavItemRoute itemKey="finance" />}>
            <Route path="/modules" element={<ConsoleModuleRoute />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="payroll" />}>
            <Route path="/payroll" element={<PayrollPage />} />
          </Route>
          <Route
            path="/settings"
            element={<Navigate to="/settings/profile" replace />}
          />
          <Route path="/settings/profile" element={<ProfilePage />} />
          <Route element={<RequireNavItemRoute itemKey="location" />}>
            <Route path="/settings/location" element={<LocationSettingsPage />} />
          </Route>
          <Route element={<RequireEmployeeDirectoryRoute />}>
            <Route path="/settings/employees" element={<EmployeesPage />} />
            <Route path="/hr/leave-management" element={<LeaveManagementPage />} />
            <Route path="/hr/insurance" element={<InsuranceAssistPage />} />
          </Route>
          <Route element={<RequireGroupAdminRoute />}>
            <Route path="/settings/group" element={<GroupAdminPage />} />
          </Route>
          <Route element={<RequireRoleManageRoute />}>
            <Route path="/settings/policy" element={<PolicyStudioPage />} />
            <Route path="/settings/workflows" element={<WorkflowStudioPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="catalog" />}>
            <Route path="/catalog" element={<CatalogAdminPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="approvals" />}>
            <Route path="/approvals" element={<ApprovalsPage />} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="inspection" />}>
            <Route path="/inspection" element={<InspectionPage />} />
          </Route>
          <Route element={<RequireAdminRoute />}>
            <Route path="/ops" element={<OpsDashboardPage />} />
            <Route path="/settings/users" element={<UsersPage />} />
            <Route path="/settings/org" element={<OrgPage />} />
            <Route path="/settings/sites" element={<SitesPage />} />
            <Route path="/settings/security" element={<AdminSettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
