import { Suspense, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { TitleProvider } from "../../context/title";
import { ko } from "../../i18n/ko";
import { ViewAsBanner } from "../../features/platform/ViewAsBanner";
import { RouteErrorBoundary } from "../RouteErrorBoundary";
import { PageSpinner } from "../states/PageSpinner";
import { BackStackBreadcrumbs } from "./BackStackBreadcrumbs";
import { CommandPalette } from "./CommandPalette";
import { ConsoleToast } from "../console/primitives";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { useConsoleToast } from "./useConsoleToast";

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
  const { session } = useAuth();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const { toast, closeToast, undoToast } = useConsoleToast();

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

  return (
    <div className="console flex h-screen overflow-hidden bg-console-canvas">
      {/* Skip-to-main */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-md focus:outline-2 focus:outline-ink"
      >
        {ko.shell.skipToContent}
      </a>

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
        />
        <main
          ref={mainRef}
          id="main-content"
          className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 focus:outline-none"
          tabIndex={-1}
        >
          <BackStackBreadcrumbs />
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
      {commandPaletteOpen ? (
        <CommandPalette onClose={() => { setCommandPaletteOpen(false); }} />
      ) : null}
      {toast ? (
        <ConsoleToast
          message={toast.message}
          onUndo={toast.onUndo ? undoToast : undefined}
          onClose={closeToast}
        />
      ) : null}
    </div>
  );
}
