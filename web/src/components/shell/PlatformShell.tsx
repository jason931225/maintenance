import {
  Building2,
  Gauge,
  LogOut,
  Network,
  ServerCog,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { Suspense, useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { TitleProvider } from "../../context/title";
import { ko } from "../../i18n/ko";
import { cn, identityLabel } from "../../lib/utils";
import { RouteErrorBoundary } from "../RouteErrorBoundary";
import { PageSpinner } from "../states/PageSpinner";

const NAV_ITEMS = [
  { href: "/platform/tenants", labelKey: "tenants" as const, Icon: Building2 },
  { href: "/platform/groups", labelKey: "groups" as const, Icon: Network },
  { href: "/platform/ops", labelKey: "ops" as const, Icon: Gauge },
  { href: "/platform/onboard", labelKey: "onboard" as const, Icon: UserPlus },
  { href: "/platform/account", labelKey: "account" as const, Icon: ShieldCheck },
];

/**
 * Minimal shell for the vendor platform-admin console. Deliberately separate
 * from the tenant AppShell so platform admins never see tenant navigation,
 * branch chips, or tenant-scoped settings.
 */
export function PlatformShell() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.focus();
  }, [location.pathname]);

  return (
    <TitleProvider>
      <div className="console flex h-screen overflow-hidden bg-console-canvas">
        <a
          href="#platform-main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-md focus:outline-2 focus:outline-ink"
        >
          {ko.shell.skipToContent}
        </a>

        <aside
          aria-label={ko.platform.shell.title}
          className="hidden w-60 shrink-0 flex-col border-r border-line bg-white sm:flex"
        >
          <div className="flex h-14 items-center gap-3 border-b border-line px-4">
            <ServerCog
              size={20}
              className="shrink-0 text-ink"
              aria-hidden="true"
            />
            <span className="truncate font-bold text-ink">
              {ko.platform.shell.title}
            </span>
          </div>
          <nav
            aria-label={ko.platform.shell.nav}
            className="grid content-start gap-1 px-2 py-4"
          >
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.href}
                to={item.href}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-muted-panel font-semibold text-ink"
                      : "text-steel hover:bg-muted-panel hover:text-ink",
                  )
                }
              >
                <item.Icon size={18} aria-hidden="true" className="shrink-0" />
                <span className="truncate">
                  {ko.platform.nav[item.labelKey]}
                </span>
              </NavLink>
            ))}
          </nav>
        </aside>

        <div className="flex flex-1 flex-col overflow-hidden">
          <PlatformTopbar />
          <main
            ref={mainRef}
            id="platform-main"
            className="flex-1 overflow-y-auto px-4 py-6 focus:outline-none sm:px-6 lg:px-8"
            tabIndex={-1}
          >
            <RouteErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<PageSpinner />}>
                <Outlet />
              </Suspense>
            </RouteErrorBoundary>
          </main>
        </div>
      </div>
    </TitleProvider>
  );
}

function PlatformTopbar() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    void navigate("/login");
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-white px-4">
      <span className="inline-flex items-center rounded-md border border-line bg-muted-panel px-2 py-1 text-xs font-semibold text-steel">
        {ko.platform.shell.badge}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-steel">
          {identityLabel(session, ko.platform.shell.operator)}
        </p>
      </div>
      <button
        type="button"
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-red-700"
        onClick={() => {
          void handleLogout();
        }}
      >
        <LogOut size={16} aria-hidden="true" />
        {ko.shell.logout}
      </button>
    </header>
  );
}
