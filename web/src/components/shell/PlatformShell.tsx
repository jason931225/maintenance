import { Building2, Gauge, LogOut, ServerCog, UserPlus } from "lucide-react";
import { Suspense, useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { TitleProvider } from "../../context/title";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";
import { RouteErrorBoundary } from "../RouteErrorBoundary";
import { PageSpinner } from "../states/PageSpinner";

const NAV_ITEMS = [
  { href: "/platform/tenants", labelKey: "tenants" as const, Icon: Building2 },
  { href: "/platform/ops", labelKey: "ops" as const, Icon: Gauge },
  { href: "/platform/onboard", labelKey: "onboard" as const, Icon: UserPlus },
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
      <div className="flex h-screen overflow-hidden bg-slate-50">
        <a
          href="#platform-main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950 focus:shadow-md focus:outline-2 focus:outline-slate-950"
        >
          {ko.shell.skipToContent}
        </a>

        <aside
          aria-label={ko.platform.shell.title}
          className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white sm:flex"
        >
          <div className="flex h-14 items-center gap-3 border-b border-slate-200 px-4">
            <ServerCog
              size={20}
              className="shrink-0 text-slate-950"
              aria-hidden="true"
            />
            <span className="truncate font-bold text-slate-950">
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
                      ? "bg-slate-100 font-semibold text-slate-950"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-950",
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
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-4">
      <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-600">
        {ko.platform.shell.badge}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-600">
          {session?.user_id ?? ko.shell.user}
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
