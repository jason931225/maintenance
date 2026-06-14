import { Suspense, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { TitleProvider } from "../../context/title";
import { ko } from "../../i18n/ko";
import { PageSpinner } from "../states/PageSpinner";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { session } = useAuth();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // Move focus to the main content region after each navigation so keyboard
  // and screen-reader users land on the new page content.
  useEffect(() => {
    mainRef.current?.focus();
  }, [location.pathname]);

  return (
    <TitleProvider>
      <div className="flex h-screen overflow-hidden bg-slate-50">
        {/* Skip-to-main */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950 focus:shadow-md focus:outline-2 focus:outline-slate-950"
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
          <Topbar onOpenMobileSidebar={() => { setSidebarOpen(true); }} />
          <main
            ref={mainRef}
            id="main-content"
            className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 focus:outline-none"
            tabIndex={-1}
          >
            {/* Routed pages are code-split; keep the shell mounted and show the
                shared spinner while a page chunk loads. */}
            <Suspense fallback={<PageSpinner />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>
    </TitleProvider>
  );
}
