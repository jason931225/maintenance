import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ko } from "../../i18n/ko";
import { useAuth } from "../../context/auth";
import { useConsoleAuthz, useConsoleScopes, UNION_SCOPE_ID } from "./authz";
import { Icon } from "./icons";
import { defaultScreen, visibleConsoleNav } from "./nav";
import { Sidebar } from "./Sidebar";
import type { NavBadge } from "./Sidebar";
import { Topbar } from "./Topbar";
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
}: {
  theme: ThemeMode;
  onCycleTheme: () => void;
}) {
  const { session } = useAuth();
  const { grants, source: authzSource } = useConsoleAuthz();
  const groups = useMemo(() => visibleConsoleNav(grants), [grants]);
  const { options: scopeOptions } = useConsoleScopes(S.scope.all);

  // Responsive auto-collapse under 1280px, overridable by the user.
  const [sbUser, setSbUser] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    // `matchMedia` is absent in some test environments; cast to a nullable type
    // so the runtime guard is honest (and not linted away as an always-true check).
    const matchMediaFn = window.matchMedia as
      | ((query: string) => MediaQueryList)
      | undefined;
    if (!matchMediaFn) return undefined;
    const mq = matchMediaFn.call(window, "(max-width: 1279px)");
    const apply = () => {
      setNarrow(mq.matches);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
    };
  }, []);
  const collapsed = sbUser ?? narrow;

  const [screen, setScreen] = useState<string | null>(null);
  const activeScreen =
    screen && groups.some((g) => g.items.some((i) => i.screen === screen))
      ? screen
      : defaultScreen(grants);
  const ScreenBody = SCREEN_REGISTRY[activeScreen];

  const routeSampleReady = useRef(false);
  const lastSampledScreen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const markOnce = () => {
      lastSampledScreen.current = activeScreen;
      markConsoleRoute(activeScreen);
    };
    if (!routeSampleReady.current) {
      if (authzSource === "authz" || screen !== null) {
        routeSampleReady.current = true;
        markOnce();
      }
      return;
    }
    if (lastSampledScreen.current !== activeScreen) markOnce();
  }, [activeScreen, authzSource, screen]);

  const [scopeOpen, setScopeOpen] = useState(false);
  const closeScope = useCallback(() => {
    setScopeOpen(false);
  }, []);
  const [selectedScopeId, setSelectedScopeId] = useState(UNION_SCOPE_ID);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteInputRef = useRef<HTMLInputElement>(null);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);

  // Global keys: ⌘/Ctrl+K toggles the palette (works everywhere); Escape peels
  // back the topmost transient surface (palette, then scope dropdown).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
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
  }, [paletteOpen, scopeOpen]);

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

  const userName = session?.display_name ?? session?.email ?? S.user.unknown;
  const userInitial = Array.from(userName.trim())[0] ?? "·";
  const userRoleLabelText = roleLabel(session?.roles ?? [], session?.group_roles ?? []);

  // No live count sources in P0.1 — badges wire in with their screens (P1/P2).
  const badges: Record<string, NavBadge | undefined> = {};

  return (
    <div
      data-cshell-root
      style={{ flex: "1 1 auto", display: "flex", minHeight: 0, minWidth: 0 }}
    >
      <Sidebar
        collapsed={collapsed}
        groups={groups}
        activeScreen={activeScreen}
        badges={badges}
        theme={theme}
        onSelect={setScreen}
        onToggleCollapse={() => {
          setSbUser(!collapsed);
        }}
        onCycleTheme={onCycleTheme}
      />

      <main
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
        />

        {/* Screen body — state.screen-driven slot, keyed off SCREEN_REGISTRY.
            A screen with no registered body still renders the themed canvas
            (chrome-only, unchanged from before content lanes landed). */}
        <section
          aria-label={S.body.label}
          data-cshell-screen={activeScreen}
          style={{ flex: "1 1 auto", minHeight: 0, minWidth: 0, background: "var(--canvas)" }}
        >
          {ScreenBody ? <ScreenBody /> : null}
        </section>
      </main>

      {/* Comms rail — collapsed strip only (chrome). The interactive rail (open
          views: messenger/mail/notif) arrives in P2, so the strip is
          presentational here: no unwired handlers. */}
      <aside
        aria-label={S.rail.label}
        data-cshell-rail
        style={{
          flex: "none",
          width: 54,
          borderLeft: "1px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            padding: "12px 0",
          }}
        >
          <RailGlyph name="chevronsLeft" decorative />
          <span
            aria-hidden="true"
            style={{ width: 18, height: 1, background: "var(--border)" }}
          />
          <RailGlyph name="msg" label={S.rail.messenger} />
          <RailGlyph name="mail" label={S.rail.mail} />
          <RailGlyph name="bell" label={S.rail.notif} />
        </div>
      </aside>

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
