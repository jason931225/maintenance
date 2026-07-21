import { Suspense, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { useAuth, type AuthSession, type ViewAsState } from "../../context/auth";
import { TitleProvider } from "../../context/title";
import { ko } from "../../i18n/ko";
import { ViewAsBanner } from "../../features/platform/ViewAsBanner";
import { WindowManagerProvider } from "../../console/window";
import { RouteErrorBoundary } from "../RouteErrorBoundary";
import { PageSpinner } from "../states/PageSpinner";
import { CommandPalette } from "./CommandPalette";
import { CommsRail, type CommsSurface } from "./CommsRail";
import { ShellDock } from "./ShellDock";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/** Personal presentation setting (§3.9.0-①) — direct-save, no API round-trip. */
const COMMS_OPEN_STORAGE_KEY = "oyatie.console.commsRail.open";
/** The rail defaults open only where the 3-column layout has room (ref ≥1440px). */
const COMMS_DEFAULT_OPEN_QUERY = "(min-width: 1440px)";

function sortedClaims(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizedIdentity(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function authorityClaims(session: AuthSession | undefined) {
  return {
    roles: sortedClaims(session?.roles),
    groupRoles: sortedClaims(session?.group_roles),
    featureGrants: sortedClaims(session?.feature_grants),
    branches: sortedClaims(session?.branches),
    isPlatform: session?.isPlatform === true,
  };
}

/** Non-secret authority + exact provider-owned incarnation partition. */
function shellWindowAuthorityKey(
  session: AuthSession | undefined,
  viewAs: ViewAsState | undefined,
): string | null {
  const effectiveIncarnation = normalizedIdentity(
    session?.client_session_incarnation,
  );
  const sourceIncarnation = viewAs
    ? normalizedIdentity(viewAs.platformSession.client_session_incarnation)
    : null;
  if (!effectiveIncarnation || (viewAs && !sourceIncarnation)) return null;

  return JSON.stringify({
    version: 3,
    effective: {
      incarnation: effectiveIncarnation,
      orgId: normalizedIdentity(viewAs?.actingOrgId ?? session?.org_id),
      userId:
        normalizedIdentity(session?.user_id) ??
        (viewAs ? normalizedIdentity(viewAs.platformSession.user_id) : null),
      ...authorityClaims(session),
    },
    viewAs: viewAs
      ? {
          orgId: viewAs.actingOrgId,
          role: viewAs.actingRole,
          mode: viewAs.mode ?? null,
          source: viewAs.source ?? null,
          sourceIdentity: {
            incarnation: sourceIncarnation,
            orgId: normalizedIdentity(viewAs.platformSession.org_id),
            userId: normalizedIdentity(viewAs.platformSession.user_id),
            ...authorityClaims(viewAs.platformSession),
          },
        }
      : null,
  });
}

function readInitialCommsOpen(): boolean {
  try {
    const stored = globalThis.localStorage.getItem(COMMS_OPEN_STORAGE_KEY);
    if (stored !== null) return stored === "1";
  } catch {
    // storage unavailable — fall through to the viewport default
  }
  // typeof guard: jsdom (tests) ships no matchMedia despite the DOM lib types.
  if (typeof globalThis.matchMedia === "function") {
    return globalThis.matchMedia(COMMS_DEFAULT_OPEN_QUERY).matches;
  }
  return false;
}

function writeCommsOpen(open: boolean): void {
  try {
    globalThis.localStorage.setItem(COMMS_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // storage unavailable — setting stays in-memory only
  }
}

export function AppShell() {
  return (
    <TitleProvider>
      <AppShellContent />
    </TitleProvider>
  );
}

function AppShellContent() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Communication rail (DESIGN §4.8): the rail's selected surface is shared with
  // the main region — "풀뷰 열기" promotes it to that surface's full-view page.
  // Default-open on wide viewports; the user's toggle persists per device.
  const [commsOpen, setCommsOpen] = useState(readInitialCommsOpen);
  const [commsSurface, setCommsSurface] = useState<CommsSurface>("messenger");
  const { session, viewAs } = useAuth();
  const windowAuthorityKey = shellWindowAuthorityKey(session, viewAs);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  function toggleComms() {
    setCommsOpen((open) => {
      const next = !open;
      writeCommsOpen(next);
      return next;
    });
  }

  // Move focus to the main content region after each navigation so keyboard
  // and screen-reader users land on the new page content.
  useEffect(() => {
    mainRef.current?.focus();
  }, [location.pathname]);

  // Dismiss the mobile sidebar drawer on Escape, matching the backdrop-click
  // dismissal so the overlay is keyboard-accessible.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSidebarOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sidebarOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // The WindowManagerProvider wraps the whole shell (§4.7) so a pinned object
  // panel survives navigation AND the minimized-window tray can live in the
  // persistent bottom dock (ShellDock hosts TrayDock; renderTray=false stops
  // the provider's floating fallback from duplicating it).
  return (
    <WindowManagerProvider
      key={windowAuthorityKey ?? "owned-incarnation-required"}
      authorityPartition={windowAuthorityKey ?? undefined}
      retentionEnabled={windowAuthorityKey !== null}
      renderTray={false}
    >
      <div className="console flex h-screen flex-col overflow-hidden bg-console-canvas">
        {/* Skip-to-main */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-md focus:outline-2 focus:outline-ink"
        >
          {ko.shell.skipToContent}
        </a>

        <div className="flex min-h-0 flex-1">
          <Sidebar
            collapsed={collapsed}
            mobileOpen={sidebarOpen}
            onCollapse={() => { setCollapsed((c) => !c); }}
            onMobileClose={() => { setSidebarOpen(false); }}
            session={session}
          />

          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Persistent read-only "view as" banner — renders only while a
                platform operator is impersonating a tenant, on every page. */}
            <ViewAsBanner />
            <Topbar
              onOpenMobileSidebar={() => { setSidebarOpen(true); }}
              onOpenCommandPalette={() => { setCommandPaletteOpen(true); }}
              onToggleComms={toggleComms}
              commsOpen={commsOpen}
            />
            <main
              ref={mainRef}
              id="main-content"
              className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 focus:outline-none"
              tabIndex={-1}
            >
              {/* Routed pages are code-split; keep the shell mounted and show the
                  shared spinner while a page chunk loads. The error boundary is
                  keyed by the route path so a single page's render crash is
                  contained here (shell + nav stay usable) and clears when the
                  user navigates away. */}
              <RouteErrorBoundary resetKey={location.pathname}>
                <Suspense fallback={<PageSpinner />}>
                  <Outlet />
                </Suspense>
              </RouteErrorBoundary>
            </main>
          </div>
          <CommsRail
            open={commsOpen}
            surface={commsSurface}
            onSurfaceChange={setCommsSurface}
            onClose={toggleComms}
          />
        </div>

        {/* Persistent bottom chrome: quick-actions dock + minimized-window tray. */}
        <ShellDock onOpenCommandPalette={() => { setCommandPaletteOpen(true); }} />

        {commandPaletteOpen ? (
          <CommandPalette onClose={() => { setCommandPaletteOpen(false); }} />
        ) : null}
      </div>
    </WindowManagerProvider>
  );
}
