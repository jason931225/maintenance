import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { ko } from "../../i18n/ko";
import { useAuth } from "../../context/auth";
import { useConsoleAuthz, useConsoleScopes, UNION_SCOPE_ID } from "./authz";
import { CommsRailPanel, CommsRailFallback } from "./CommsRailPanel";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { Icon } from "./icons";
import {
  consoleScreenPath,
  defaultScreen,
  EXPOSED_SCREEN_KEYS,
  isMountedScreenKey,
  screenFromConsolePath,
  visibleConsoleNav,
} from "./nav";
import type { MountedScreenKey } from "./nav";
import { useNavBadges } from "./navBadges";
import { Sidebar } from "./Sidebar";
import { useSelfProfile } from "./useSelfProfile";
import { Topbar } from "./Topbar";
import { isCommunicationScreen, resolveShellLayout } from "./shellLayout";
import { markConsoleRoute } from "../rum/rum";
import { SCREEN_REGISTRY } from "../screens/registry";
import type { ThemeMode } from "./theme";

const S = ko.console.shell;

const ROLE_PRIORITY = [
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
  "MEMBER",
] as const;

function roleLabel(roles: readonly string[], groupRoles: readonly string[]): string {
  if (groupRoles.includes("GROUP_ADMIN")) return S.user.roles.GROUP_ADMIN;
  const top = ROLE_PRIORITY.find((r) => roles.includes(r));
  return top ? S.user.roles[top] : S.user.roles.MEMBER;
}

function kbdLabel(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Mac|iPhone|iPad/i.test(ua) ? "⌘K" : "Ctrl K";
}

export function ConsoleShell({
  theme,
  onCycleTheme,
  screenKeys = EXPOSED_SCREEN_KEYS,
}: {
  theme: ThemeMode;
  onCycleTheme: () => void;
  screenKeys?: readonly MountedScreenKey[];
}) {
  const { session } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { grants, source: authzSource, ready: authzReady } = useConsoleAuthz();
  const groups = useMemo(() => visibleConsoleNav(grants, screenKeys), [grants, screenKeys]);
  const { options: scopeOptions } = useConsoleScopes(S.scope.all);

  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );

  // Responsive auto-collapse under 1280px, overridable by the user.
  const [sbUser, setSbUser] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    // `matchMedia` is absent in some test environments; cast to a nullable type
    // so the runtime guard is honest (and not linted away as an always-true check).
    const matchMediaFn = window.matchMedia as
      | ((query: string) => MediaQueryList)
      | undefined;
    const onResize = () => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener("resize", onResize);
    if (!matchMediaFn) {
      return () => {
        window.removeEventListener("resize", onResize);
      };
    }
    const mq = matchMediaFn.call(window, "(max-width: 1279px)");
    const mobileMq = matchMediaFn.call(window, "(max-width: 767px)");
    const apply = () => {
      setNarrow(mq.matches);
      setMobile(mobileMq.matches);
      setViewportWidth(window.innerWidth);
    };
    const onChange = () => {
      if (!mobileMq.matches) setDrawer(null);
      apply();
    };
    apply();
    mq.addEventListener("change", onChange);
    mobileMq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      mobileMq.removeEventListener("change", onChange);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  // The media query is authoritative in embedded/test environments where
  // `innerWidth` is not kept in sync with the visual viewport.
  const shellLayout = resolveShellLayout(mobile ? 0 : viewportWidth);
  const collapsed = mobile ? false : sbUser ?? narrow;

  // The comms rail is expanded on desktop, compact by default on tablet, and
  // becomes an explicit drawer on mobile. The user's desktop/tablet toggle is
  // intentionally session-local until there is a product preference contract.
  const [railUser, setRailUser] = useState<boolean | null>(null);
  const railOpen = railUser ?? !narrow;
  const expandedRailWidth = narrow ? 300 : shellLayout.rail;
  const activeDrawer = mobile ? drawer : null;
  const sidebarRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const drawerReturnRef = useRef<HTMLElement | null>(null);
  const focusMainAfterDrawerCloseRef = useRef(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteInputRef = useRef<HTMLInputElement>(null);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);

  const openDrawer = useCallback((next: "left" | "right") => {
    drawerReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(false);
    setDrawer(next);
  }, []);
  const closeDrawer = useCallback((restoreFocus = true) => {
    if (!restoreFocus) drawerReturnRef.current = null;
    setDrawer(null);
  }, []);

  useEffect(() => {
    if (!activeDrawer) return undefined;
    const container = activeDrawer === "left" ? sidebarRef.current : railRef.current;
    const focusable = () =>
      Array.from(container?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!container?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      window.removeEventListener("keydown", onKeyDown);
      drawerReturnRef.current?.focus();
    };
  }, [activeDrawer, closeDrawer]);

  const routeScreen = screenFromConsolePath(location.pathname);
  const activeScreen =
    routeScreen &&
    isMountedScreenKey(routeScreen) &&
    screenKeys.includes(routeScreen) &&
    groups.some((g) => g.items.some((i) => i.screen === routeScreen))
      ? routeScreen
      : defaultScreen(grants, screenKeys);
  const ScreenBody = activeScreen ? SCREEN_REGISTRY[activeScreen] : undefined;
  const communicationScreen = activeScreen ? isCommunicationScreen(activeScreen) : false;

  useEffect(() => {
    if (!focusMainAfterDrawerCloseRef.current || activeDrawer) return;
    focusMainAfterDrawerCloseRef.current = false;
    mainRef.current?.focus();
  }, [activeDrawer, activeScreen]);

  // Canonicalize bare, invalid, unshipped, and unauthorized destinations. A
  // replacement avoids trapping Back on a location the user cannot render.
  useEffect(() => {
    if (!activeScreen) return;
    const canonicalPath = consoleScreenPath(activeScreen);
    if (location.pathname !== canonicalPath) {
      void navigate(
        { pathname: canonicalPath, search: location.search, hash: location.hash },
        { replace: true },
      );
    }
  }, [activeScreen, location.hash, location.pathname, location.search, navigate]);

  const routeSampleReady = useRef(false);
  const lastSampledScreen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!activeScreen) return;
    const markOnce = () => {
      lastSampledScreen.current = activeScreen;
      markConsoleRoute(activeScreen);
    };
    if (!routeSampleReady.current) {
      if (authzSource === "authz" || routeScreen !== undefined) {
        routeSampleReady.current = true;
        markOnce();
      }
      return;
    }
    if (lastSampledScreen.current !== activeScreen) markOnce();
  }, [activeScreen, authzSource, routeScreen]);

  const [scopeOpen, setScopeOpen] = useState(false);
  const closeScope = useCallback(() => {
    setScopeOpen(false);
  }, []);
  const [selectedScopeId, setSelectedScopeId] = useState(UNION_SCOPE_ID);
  // Global keys: ⌘/Ctrl+K toggles the palette (works everywhere); Escape peels
  // back the topmost transient surface (palette, then scope dropdown).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (activeDrawer) return;
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        if (activeDrawer) return;
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        if (scopeOpen) {
          setScopeOpen(false);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [activeDrawer, paletteOpen, scopeOpen]);

  useEffect(() => {
    if (paletteOpen) {
      const id = window.setTimeout(() => paletteInputRef.current?.focus(), 60);
      return () => {
        window.clearTimeout(id);
      };
    }
    return undefined;
  }, [paletteOpen]);

  const selectedLabel =
    scopeOptions.find((o) => o.id === selectedScopeId)?.label ?? S.scope.all;

  const profile = useSelfProfile();
  const userName =
    profile.displayName ?? session?.display_name ?? session?.email ?? S.user.unknown;
  const userInitial = Array.from(userName.trim())[0] ?? "·";
  const userRoleLabelText = roleLabel(session?.roles ?? [], session?.group_roles ?? []);
  const userTeamLabel = profile.team ? ko.users.teams[profile.team] : undefined;

  // Real nav count badges from the caller's action inbox + unread summary
  // (navBadges.ts). Fails soft to an empty map, so the shell never depends on it.
  const badges = useNavBadges(session?.access_token);

  // A live capability-only grant may be the sole reason this console is
  // visible. Do not redirect before its authoritative projection settles.
  if (!authzReady) return null;
  if (!activeScreen || !ScreenBody) return <Navigate to="/overview" replace />;

  return (
    <div
      data-cshell-root
      data-cshell-mobile={mobile || undefined}
      data-cshell-layout={mobile ? "mobile" : narrow ? "compact" : "desktop"}
      style={{ flex: "1 1 auto", display: "flex", minHeight: 0, minWidth: 0, overflowX: "hidden" }}
    >
      {mobile && activeDrawer && (
        <button
          type="button"
          aria-label={S.drawer.close}
          data-cshell-drawer-backdrop
          onClick={() => {
            closeDrawer();
          }}
        />
      )}
      <Sidebar
        collapsed={collapsed}
        groups={groups}
        activeScreen={activeScreen}
        badges={badges}
        theme={theme}
        onSelect={(nextScreen) => {
          if (mobile) closeDrawer();
          void navigate({
            pathname: consoleScreenPath(nextScreen),
            search: location.search,
            hash: location.hash,
          });
        }}
        onToggleCollapse={() => {
          setSbUser(!collapsed);
        }}
        onCycleTheme={onCycleTheme}
        mobile={mobile}
        width={collapsed ? 62 : 236}
        drawerOpen={activeDrawer === "left"}
        drawerRef={sidebarRef}
        drawerModal={activeDrawer === "left"}
      />

      <main
        ref={mainRef}
        tabIndex={-1}
        inert={activeDrawer ? true : undefined}
        aria-hidden={activeDrawer ? "true" : undefined}
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          position: "relative",
        }}
      >
        <Topbar
          kbdLabel={kbdLabel()}
          onOpenPalette={() => {
            setPaletteOpen(true);
          }}
          scopeLabel={selectedLabel}
          scopeOptions={scopeOptions}
          selectedScopeId={selectedScopeId}
          scopeOpen={scopeOpen}
          onScopeToggle={() => {
            setScopeOpen((v) => !v);
          }}
          onScopeClose={closeScope}
          onScopeSelect={(id) => {
            setSelectedScopeId(id);
            setScopeOpen(false);
          }}
          userName={userName}
          userInitial={userInitial}
          userRoleLabel={userRoleLabelText}
          userTeamLabel={userTeamLabel}
          onOpenNavigation={
            mobile
              ? () => {
                  openDrawer("left");
                }
              : undefined
          }
          onOpenComms={
            mobile && !communicationScreen
              ? () => {
                  openDrawer("right");
                }
              : undefined
          }
        />

        {/* URL-driven body, constrained to evidence-exposed + authorized nav. */}
        <section
          aria-label={S.body.label}
          data-cshell-screen={activeScreen}
          style={{ flex: "1 1 auto", minHeight: 0, minWidth: 0, background: "var(--canvas)" }}
        >
          <ScreenBody />
        </section>
      </main>

      {/* Comms rail — shell-level, default-expanded on every screen (round 5).
          The single "커뮤니케이션" complementary landmark stays exactly as
          deduped in #459: this is still the only element carrying that name. */}
      {!communicationScreen && <aside
        aria-label={S.rail.label}
        data-cshell-rail
        data-cshell-rail-open={(mobile || railOpen) || undefined}
        data-cshell-drawer={mobile ? "right" : undefined}
        data-cshell-drawer-open={mobile && activeDrawer === "right" ? "true" : undefined}
        ref={railRef}
        role={activeDrawer === "right" ? "dialog" : undefined}
        aria-modal={activeDrawer === "right" ? "true" : undefined}
        aria-hidden={mobile && activeDrawer !== "right" ? "true" : undefined}
        inert={mobile && activeDrawer !== "right" ? true : undefined}
        style={{
          flex: "none",
          // `width` + `maxWidth` is equivalent to the prototype's
          // min(320px, 86vw) and remains measurable in jsdom/browser tests.
          width: mobile ? "86vw" : railOpen ? expandedRailWidth : 54,
          maxWidth: mobile ? 320 : undefined,
          borderLeft: "1px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
          ...(mobile
            ? {
                position: "fixed" as const,
                inset: "0 0 0 auto",
                zIndex: 82,
                transform: activeDrawer === "right" ? "translateX(0)" : "translateX(101%)",
                boxShadow: activeDrawer === "right" ? "var(--shadow-pop)" : "none",
              }
            : {}),
        }}
      >
        {(mobile || railOpen) ? (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "12px 12px 0",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                {S.rail.label}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (mobile) closeDrawer();
                  else setRailUser(false);
                }}
                title={S.rail.collapse}
                aria-label={S.rail.collapse}
                data-cshell-rail-toggle
                className="cshell-hoverable cshell-focusable"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: mobile ? 44 : 28,
                  height: mobile ? 44 : 28,
                  border: "none",
                  borderRadius: 7,
                  background: "transparent",
                  color: "var(--steel)",
                  cursor: "pointer",
                }}
              >
                <Icon name="chevronsRight" size={15} strokeWidth={2} />
              </button>
            </div>
            <ErrorBoundary fallback={<CommsRailFallback />}>
              <CommsRailPanel
                accessToken={session?.access_token}
                onOpenMessengerThread={(threadId) => {
                  if (activeDrawer) {
                    focusMainAfterDrawerCloseRef.current = true;
                    closeDrawer(false);
                  }
                  void navigate({
                    pathname: consoleScreenPath("messenger"),
                    search: `?thread=${encodeURIComponent(threadId)}`,
                  });
                }}
              />
            </ErrorBoundary>
          </>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              padding: "12px 0",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setRailUser(true);
              }}
              title={S.rail.expand}
              aria-label={S.rail.expand}
              data-cshell-rail-toggle
              className="cshell-hoverable cshell-focusable"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 34,
                height: 34,
                border: "none",
                borderRadius: 9,
                background: "transparent",
                color: "var(--steel)",
                cursor: "pointer",
              }}
            >
              <Icon name="chevronsLeft" size={15} strokeWidth={2} />
            </button>
            <span
              aria-hidden="true"
              style={{ width: 18, height: 1, background: "var(--border)" }}
            />
            <RailGlyph name="msg" label={S.rail.messenger} />
            <RailGlyph name="mail" label={S.rail.mail} />
            <RailGlyph name="bell" label={S.rail.notif} />
          </div>
        )}
      </aside>}

      {paletteOpen && (
        <div
          data-cshell-palette-backdrop
          onClick={closePalette}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            background: "rgba(15, 22, 30, 0.32)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "12vh",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={S.palette.label}
            className="cshell-pop"
            onClick={(e) => {
              e.stopPropagation();
            }}
            style={{
              width: "min(560px, 92vw)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              boxShadow: "var(--shadow-pop)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 14px",
                borderBottom: "1px solid var(--border-soft)",
              }}
            >
              <Icon name="search" size={16} strokeWidth={2} style={{ color: "var(--faint)" }} />
              <input
                ref={paletteInputRef}
                type="text"
                aria-label={S.palette.label}
                placeholder={S.palette.placeholder}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: "var(--ink)",
                  fontSize: 14,
                }}
              />
              <button
                type="button"
                onClick={closePalette}
                aria-label={S.palette.close}
                className="cshell-hoverable cshell-focusable"
                style={{
                  flex: "none",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  background: "var(--surface)",
                  color: "var(--steel)",
                }}
              >
                Esc
              </button>
            </div>
            {/* Empty results surface — the full palette (result rows, keyboard
                nav, run handlers) is a later slice. No explanatory placeholder
                copy (§4-12); the input placeholder already drives the action. */}
            <div data-cshell-palette-results style={{ minHeight: 96 }} />
          </div>
        </div>
      )}
    </div>
  );
}

function RailGlyph({
  name,
  label,
  decorative,
}: {
  name: Parameters<typeof Icon>[0]["name"];
  label?: string;
  decorative?: boolean;
}) {
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={decorative ? undefined : label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 34,
        height: 34,
        borderRadius: 9,
        color: "var(--steel)",
      }}
    >
      <Icon name={name} size={15} strokeWidth={2} />
    </span>
  );
}
