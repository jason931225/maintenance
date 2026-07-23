import { ko } from "../../i18n/ko";
import type { Ref } from "react";
import { Icon } from "./icons";
import type { VisibleNavGroup } from "./nav";
import type { ThemeMode } from "./theme";
import { nextTheme } from "./theme";

export interface NavBadge {
  count: number;
  tone: "urgent" | "neutral";
}

const S = ko.console.shell;

function get(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v === "string") return v;
  if (import.meta.env.DEV) {
    console.warn(`[console-shell] missing i18n key: ${key}`);
  }
  return key;
}

function ThemeButton({
  theme,
  onCycle,
  mobile,
}: {
  theme: ThemeMode;
  onCycle: () => void;
  mobile: boolean;
}) {
  const next = nextTheme(theme);
  const title =
    next === "light" ? S.theme.toLight : next === "dark" ? S.theme.toDark : S.theme.toSystem;
  return (
    <button
      type="button"
      onClick={onCycle}
      title={title}
      aria-label={title}
      className="cshell-hoverable cshell-focusable"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: mobile ? 44 : 28,
        height: mobile ? 44 : 28,
        borderRadius: 7,
        border: "none",
        background: "transparent",
        color: "var(--steel)",
      }}
    >
      <Icon name={theme === "dark" ? "moon" : "sun"} size={15} strokeWidth={2} />
    </button>
  );
}

export function Sidebar({
  collapsed,
  groups,
  activeScreen,
  badges,
  theme,
  onSelect,
  onToggleCollapse,
  onCycleTheme,
  mobile = false,
  drawerOpen = false,
  drawerModal = false,
  drawerRef,
}: {
  collapsed: boolean;
  groups: VisibleNavGroup[];
  activeScreen: string;
  badges: Record<string, NavBadge | undefined>;
  theme: ThemeMode;
  onSelect: (screen: string) => void;
  onToggleCollapse: () => void;
  onCycleTheme: () => void;
  mobile?: boolean;
  drawerOpen?: boolean;
  drawerModal?: boolean;
  drawerRef?: Ref<HTMLDivElement>;
}) {
  const collapseTitle = collapsed ? S.sidebar.expand : S.sidebar.collapse;
  // A plain container, not <aside>: the inner <nav> is the sole navigation
  // landmark, and a second complementary landmark (the comms rail is <aside>)
  // would trip axe's landmark-unique rule.
  return (
    <div
      data-cshell-sidebar
      data-collapsed={collapsed}
      data-cshell-drawer={mobile ? "left" : undefined}
      data-cshell-drawer-open={mobile && drawerOpen ? "true" : undefined}
      ref={drawerRef}
      role={drawerModal ? "dialog" : undefined}
      aria-modal={drawerModal ? "true" : undefined}
      aria-label={drawerModal ? S.sidebar.label : undefined}
      aria-hidden={mobile && !drawerOpen ? "true" : undefined}
      inert={mobile && !drawerOpen ? true : undefined}
      style={{
        flex: "none",
        width: mobile ? 244 : collapsed ? 62 : 236,
        transition: "width 0.18s ease",
        overflow: "hidden",
        borderRight: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        ...(mobile
          ? {
              position: "fixed" as const,
              inset: "0 auto 0 0",
              zIndex: 82,
              transform: drawerOpen ? "translateX(0)" : "translateX(-101%)",
              boxShadow: drawerOpen ? "var(--shadow-pop)" : "none",
            }
          : {}),
      }}
    >
      {/* brand band */}
      <div
        style={{
          flex: "none",
          height: 56,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 16px",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            flex: "none",
            width: 24,
            height: 24,
            borderRadius: 7,
            background: "var(--signal)",
            color: "#141a21",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 900,
          }}
        >
          A
        </span>
        {!collapsed && (
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 14.5,
                fontWeight: 800,
                letterSpacing: "-0.2px",
                whiteSpace: "nowrap",
              }}
            >
              {S.brand.name}
            </div>
            <div
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                color: "var(--faint)",
                letterSpacing: "0.6px",
                whiteSpace: "nowrap",
              }}
            >
              {S.brand.wordmark}
            </div>
          </div>
        )}
        <ThemeButton theme={theme} onCycle={onCycleTheme} mobile={mobile} />
      </div>

      {/* nav groups */}
      <nav
        aria-label={S.sidebar.label}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "12px 10px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {groups.map((group) => (
          <div
            key={group.labelId}
            style={{ display: "flex", flexDirection: "column", gap: 2 }}
          >
            {!collapsed && (
              <p
                style={{
                  margin: "0 0 5px",
                  padding: "0 12px",
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: "0.9px",
                  color: "var(--faint)",
                  whiteSpace: "nowrap",
                }}
              >
                {get(S.nav.groups, group.labelId)}
              </p>
            )}
            {group.items.map((item) => {
              const active = item.screen === activeScreen;
              const label = get(S.nav, item.screen);
              const badge = badges[item.screen];
              return (
                <button
                  key={item.screen}
                  type="button"
                  onClick={() => {
                    onSelect(item.screen);
                  }}
                  title={label}
                  aria-label={label}
                  aria-current={active ? "true" : undefined}
                  className="cshell-hoverable cshell-focusable"
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    width: "100%",
                    minHeight: mobile ? 44 : undefined,
                    padding: "7.5px 12px",
                    borderRadius: 8,
                    border: "none",
                    background: active ? "var(--muted)" : "transparent",
                    color: active ? "var(--ink)" : "var(--steel)",
                    fontSize: 13,
                    fontWeight: active ? 800 : 500,
                    textAlign: "left",
                    whiteSpace: "nowrap",
                  }}
                >
                  <Icon name={item.icon} size={16} strokeWidth={1.9} />
                  {!collapsed && (
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {label}
                    </span>
                  )}
                  {badge && badge.count > 0 && !collapsed && (
                    <span
                      style={{
                        flex: "none",
                        minWidth: 19,
                        height: 17,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "0 5px",
                        borderRadius: 9,
                        background:
                          badge.tone === "neutral" ? "var(--muted)" : "var(--danger-solid)",
                        color: badge.tone === "neutral" ? "var(--steel)" : "#fff",
                        fontSize: 10,
                        fontWeight: 800,
                      }}
                    >
                      {badge.count > 99 ? "99+" : String(badge.count)}
                    </span>
                  )}
                  {badge && badge.count > 0 && collapsed && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        right: 7,
                        top: 7,
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--danger-solid)",
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* collapse footer */}
      <div
        style={{
          flex: "none",
          borderTop: "1px solid var(--border-soft)",
          padding: 9,
        }}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title={collapseTitle}
          aria-label={collapseTitle}
          aria-expanded={!collapsed}
          data-cshell-collapse
          className="cshell-hoverable cshell-focusable"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            width: "100%",
            minHeight: mobile ? 44 : undefined,
            padding: "7px 12px",
            borderRadius: 8,
            border: "none",
            background: "transparent",
            color: "var(--faint)",
            fontSize: 12,
            fontWeight: 600,
            textAlign: "left",
          }}
        >
          <Icon
            name={collapsed ? "chevronsRight" : "chevronsLeft"}
            size={15}
            strokeWidth={2}
          />
          {!collapsed && <span style={{ whiteSpace: "nowrap" }}>{collapseTitle}</span>}
        </button>
      </div>
    </div>
  );
}
