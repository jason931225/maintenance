import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { ConsoleScreenContext } from "../../features/workspace/pin-context";
import { useWorkspacePersistence } from "../../features/workspace/persistence";
import { selectScreenPanels, useWorkspaceStore } from "../../features/workspace/store";
import type { ScreenKey } from "../../features/workspace/types";
import { useAuth } from "../../context/auth";
import { TitleProvider } from "../../context/title";
import { ko } from "../../i18n/ko";
import { ViewAsBanner } from "../../features/platform/ViewAsBanner";
import { AttendancePage } from "../../pages/AttendancePage";
import { WorkHubPage } from "../../pages/WorkHubPage";
import { RouteErrorBoundary } from "../RouteErrorBoundary";
import { ConsoleToast } from "../console/primitives";
import { CommandPalette } from "./CommandPalette";
import {
  isNavItemVisible,
  visibleNavItemsForRoles,
  type NavItemKey,
} from "./nav";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { useConsoleToast } from "./useConsoleToast";
import { FloatWindow } from "./workspace/FloatWindow";
import { QuadrantContainer } from "./workspace/QuadrantContainer";
import { Tray } from "./workspace/Tray";

// The two screens that live in ConsoleShell (UI-M1b). Every other route stays on
// AppShell (two-shell coexistence). Both screens are mounted at once and toggled
// by visibility so panel/layout/fetch state survives navigation between them.
const SCREEN_FOR_PATH: Record<string, ScreenKey> = {
  "/attendance": "attendance",
  "/work-hub": "work-hub",
};

const NAV_ITEM_FOR_SCREEN: Record<ScreenKey, NavItemKey> = {
  "work-hub": "work-hub",
  attendance: "my-attendance",
};

export function ConsoleShell() {
  return (
    <TitleProvider>
      <ConsoleShellContent />
    </TitleProvider>
  );
}

function ConsoleShellContent() {
  const location = useLocation();
  const { api, session } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const { toast, closeToast, undoToast } = useConsoleToast();
  const workspaceRef = useRef<HTMLElement>(null);

  const panels = useWorkspaceStore((s) => s.panels);
  const minimize = useWorkspaceStore((s) => s.minimize);
  const restore = useWorkspaceStore((s) => s.restore);
  const popout = useWorkspaceStore((s) => s.popout);
  const closePanel = useWorkspaceStore((s) => s.close);
  const moveFloat = useWorkspaceStore((s) => s.moveFloat);
  const pin = useWorkspaceStore((s) => s.pin);
  const restoreDefault = useWorkspaceStore((s) => s.restoreDefault);

  const activeScreen = SCREEN_FOR_PATH[location.pathname] ?? "work-hub";

  const visible: Record<ScreenKey, boolean> = {
    "work-hub": isNavItemVisible(
      NAV_ITEM_FOR_SCREEN["work-hub"],
      session?.roles,
      session?.group_roles,
      session?.feature_grants,
    ),
    attendance: isNavItemVisible(
      NAV_ITEM_FOR_SCREEN.attendance,
      session?.roles,
      session?.group_roles,
      session?.feature_grants,
    ),
  };

  useWorkspacePersistence(api, true);

  // Focus the workspace region after each navigation for keyboard/SR users.
  useEffect(() => {
    workspaceRef.current?.focus();
  }, [location.pathname]);

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

  const activePanels = selectScreenPanels(panels, activeScreen);
  const floats = activePanels.filter((p) => p.mode === "float");
  const minimized = activePanels.filter((p) => p.mode === "minimized");

  // Global keys: Cmd/Ctrl+K palette, Esc cascade (minimize the most-recent
  // open panel one layer at a time, then dismiss the palette).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (event.key === "Escape") {
        const open = selectScreenPanels(useWorkspaceStore.getState().panels, activeScreen).filter(
          (p) => p.mode === "pinned" || p.mode === "float",
        );
        const last = open.at(-1);
        if (last) {
          event.preventDefault();
          minimize(last.id);
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeScreen, minimize]);

  if (!visible[activeScreen]) {
    const fallback =
      visibleNavItemsForRoles(
        session?.roles,
        session?.group_roles,
        session?.feature_grants,
      ).find((item) => item.key !== "profile")?.href ?? "/settings/profile";
    return <Navigate to={fallback} replace />;
  }

  return (
    <div className="console flex h-screen overflow-hidden bg-console-canvas">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-console-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-console-ink focus:shadow-md focus:outline-2 focus:outline-console-ink"
      >
        {ko.shell.skipToContent}
      </a>

      <Sidebar
        collapsed={collapsed}
        mobileOpen={sidebarOpen}
        onCollapse={() => {
          setCollapsed((c) => !c);
        }}
        onMobileClose={() => {
          setSidebarOpen(false);
        }}
        session={session}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <ViewAsBanner />
        <Topbar
          onOpenMobileSidebar={() => {
            setSidebarOpen(true);
          }}
          onOpenCommandPalette={() => {
            setCommandPaletteOpen(true);
          }}
        />
        <main
          id="main-content"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <QuadrantContainer
            workspaceRef={workspaceRef}
            panels={activePanels}
            onMinimize={minimize}
            onPopout={popout}
            onClose={closePanel}
          >
            <RouteErrorBoundary resetKey={location.pathname}>
              <ScreenSlot screen="work-hub" active={activeScreen === "work-hub"} mounted={visible["work-hub"]}>
                <WorkHubPage />
              </ScreenSlot>
              <ScreenSlot screen="attendance" active={activeScreen === "attendance"} mounted={visible.attendance}>
                <AttendancePage />
              </ScreenSlot>
            </RouteErrorBoundary>
          </QuadrantContainer>
          <Tray
            minimized={minimized}
            hasAnyPanels={activePanels.length > 0}
            onRestore={restore}
            onRestoreDefault={() => {
              restoreDefault(activeScreen);
            }}
          />
        </main>
      </div>

      {floats.map((panel) => (
        <FloatWindow
          key={panel.id}
          panel={panel}
          workspaceRef={workspaceRef}
          onSnap={(area) => {
            pin(activeScreen, panel.object, area);
          }}
          onMove={(rect) => {
            moveFloat(panel.id, rect);
          }}
          onMinimize={() => {
            minimize(panel.id);
          }}
          onClose={() => {
            closePanel(panel.id);
          }}
        />
      ))}

      {commandPaletteOpen ? (
        <CommandPalette
          onClose={() => {
            setCommandPaletteOpen(false);
          }}
        />
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

// Keeps a screen mounted at all times; the inactive screen is display:none and
// inert (removed from the tab order / a11y tree) but retains React + fetch state.
function ScreenSlot({
  screen,
  active,
  mounted,
  children,
}: {
  screen: ScreenKey;
  active: boolean;
  mounted: boolean;
  children: ReactNode;
}) {
  if (!mounted) return null;
  return (
    <div
      hidden={!active}
      // React 19 forwards the boolean `inert` attribute.
      inert={!active}
      className="h-full px-4 py-6 sm:px-6 lg:px-8"
    >
      <ConsoleScreenContext.Provider value={screen}>{children}</ConsoleScreenContext.Provider>
    </div>
  );
}
