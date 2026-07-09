import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { NavLink } from "react-router-dom";

import type { AuthSession } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";
import { consoleIcons } from "../console/icons";
import { NAV_GROUPS, isNavItemVisible } from "./nav";
import { navGroupLabel, navItemLabel } from "./nav-labels";
import { useCommsStore } from "../../features/comms/store";

// ponytail: the brand tile reuses the existing "overview" console icon as the
// app mark instead of a per-tenant logo upload pipeline — swap for real
// tenant branding when a milestone asks for it.
const BrandMark = consoleIcons.overview;

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapse: () => void;
  onMobileClose: () => void;
  session: AuthSession | undefined;
}

interface NavBadge {
  primary: number;
  secondary?: number;
  ariaLabel: string;
  secondaryLabel?: string;
  tone?: "attention" | "neutral";
}

type NavCounts = Partial<Record<string, NavBadge>>;

function badgeLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function hasBadge(badge: NavBadge | undefined): badge is NavBadge {
  return Boolean(badge && (badge.primary > 0 || (badge.secondary ?? 0) > 0));
}

function navBadgeAria(template: string, label: string, count: number): string {
  return template.replace("{label}", label).replace("{count}", String(count));
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onCollapse,
  onMobileClose,
  session,
}: SidebarProps) {
  const panelRef = useRef<HTMLElement>(null);
  const roles = session?.roles;
  const groupRoles = session?.group_roles;
  const featureGrants = session?.feature_grants;

  // Badge counts come from the shared comms store (fetched once by the comms
  // rail runtime) instead of the sidebar re-fetching them itself.
  const approvals = useCommsStore((s) => s.counts.approvals);
  const messengerUnread = useCommsStore((s) => s.counts.messenger);
  const mailUnread = useCommsStore((s) => s.counts.mail);
  const supportOpen = useCommsStore((s) => s.counts.supportOpen);
  const supportUnread = useCommsStore((s) => s.counts.supportUnread);

  const counts = useMemo<NavCounts>(() => {
    const next: NavCounts = {};
    if (approvals > 0) {
      next.approvals = {
        primary: approvals,
        tone: "attention",
        ariaLabel: navBadgeAria(
          ko.shell.navBadges.pendingApprovals,
          navItemLabel("approvals"),
          approvals,
        ),
      };
    }
    if (messengerUnread > 0) {
      next.messenger = {
        primary: messengerUnread,
        tone: "attention",
        ariaLabel: navBadgeAria(
          ko.shell.navBadges.unreadMessages,
          navItemLabel("messenger"),
          messengerUnread,
        ),
      };
    }
    if (mailUnread > 0) {
      next.mail = {
        primary: mailUnread,
        tone: "attention",
        ariaLabel: navBadgeAria(
          ko.shell.navBadges.unreadMail,
          navItemLabel("mail"),
          mailUnread,
        ),
      };
    }
    if (supportOpen > 0 || supportUnread > 0) {
      next.support = {
        primary: supportUnread,
        secondary: supportOpen,
        tone: supportUnread > 0 ? "attention" : "neutral",
        ariaLabel: ko.shell.navBadges.supportSummary
          .replace("{unread}", String(supportUnread))
          .replace("{open}", String(supportOpen)),
        secondaryLabel: ko.shell.navBadges.openShort,
      };
    }
    return next;
  }, [approvals, messengerUnread, mailUnread, supportOpen, supportUnread]);

  const filteredGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          isNavItemVisible(item.key, roles, groupRoles, featureGrants),
        ),
      })).filter((group) => group.items.length > 0),
    [featureGrants, groupRoles, roles],
  );

  useEffect(() => {
    if (!mobileOpen) return undefined;

    const panel = panelRef.current;
    const previouslyFocused = document.activeElement;
    if (!panel) return undefined;
    const panelEl = panel;

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    function focusableElements() {
      return Array.from(
        panelEl.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => {
        // getClientRects() is empty when the element OR any ancestor is
        // display:none — unlike getComputedStyle(element).display, which only
        // sees the element's own value. This excludes the desktop-only collapse
        // toggle (its wrapper is `hidden lg:block`, so display:none at the
        // mobile drawer width); otherwise it was wrongly picked as the trap's
        // last stop and Shift+Tab focused an unrendered button instead of the
        // last nav link. visibility is inherited, so the element's own computed
        // value already reflects an ancestor's visibility:hidden.
        if (element.getClientRects().length === 0) return false;
        return window.getComputedStyle(element).visibility !== "hidden";
      });
    }

    window.requestAnimationFrame(() => {
      (focusableElements()[0] ?? panelEl).focus();
    });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        panelEl.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!panelEl.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, [mobileOpen]);

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-console-ink/40 lg:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside
        ref={panelRef}
        aria-label={ko.shell.title}
        aria-modal={mobileOpen ? "true" : undefined}
        role={mobileOpen ? "dialog" : undefined}
        tabIndex={-1}
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col bg-console-surface border-r border-console-border transition-all duration-200",
          collapsed ? "w-16" : "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:translate-x-0 lg:z-auto",
        )}
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-3 px-4 border-b border-console-border shrink-0">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-console-signal text-console-ink"
          >
            <BrandMark size={16} strokeWidth={2.5} />
          </span>
          {!collapsed && (
            <span className="font-bold text-console-ink truncate">
              {ko.shell.title}
            </span>
          )}
        </div>

        {/* Nav */}
        <nav
          aria-label={ko.shell.mainNav}
          className="flex-1 overflow-y-auto py-4 px-2 grid content-start gap-6"
        >
          {filteredGroups.map((group) => (
            <div key={group.key}>
              {!collapsed && (
                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-console-steel">
                  {navGroupLabel(group.key)}
                </p>
              )}
              <div className="grid gap-1">
                {group.items.map((item) => {
                  const labelStr = navItemLabel(item.key);
                  const badge = counts[item.key];
                  const showBadge = hasBadge(badge);
                  return (
                    <NavLink
                      key={item.key}
                      to={item.href}
                      aria-label={collapsed || showBadge ? `${labelStr}${showBadge ? `, ${badge.ariaLabel}` : ""}` : undefined}
                      onClick={() => {
                        if (mobileOpen) onMobileClose();
                      }}
                      className={({ isActive }) =>
                        cn(
                          "relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                          isActive
                            ? "bg-console-muted text-console-ink font-semibold"
                            : "text-console-steel hover:bg-console-muted hover:text-console-ink",
                        )
                      }
                      title={collapsed ? (showBadge ? `${labelStr} · ${badge.ariaLabel}` : labelStr) : undefined}
                    >
                      <item.Icon
                        size={18}
                        aria-hidden="true"
                        className="shrink-0"
                      />
                      {!collapsed && (
                        <span className="min-w-0 flex-1 truncate">{labelStr}</span>
                      )}
                      {showBadge && collapsed ? (
                        // Collapsed icon rail: a plain unread dot (no digits fit
                        // at 64px) — the full count is still announced via the
                        // NavLink's aria-label and hover `title` above.
                        <span
                          aria-hidden="true"
                          className={cn(
                            "absolute right-1.5 top-1.5 h-2 w-2 rounded-full",
                            badge.tone === "neutral" ? "bg-console-steel" : "bg-console-danger-solid",
                          )}
                        />
                      ) : null}
                      {showBadge && !collapsed ? (
                        <span
                          className="ml-auto inline-flex min-w-10 justify-end gap-1"
                          aria-label={badge.ariaLabel}
                        >
                          {badge.primary > 0 ? (
                            <span
                              aria-hidden="true"
                              className={cn(
                                "inline-flex min-h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none text-console-surface",
                                badge.tone === "neutral" ? "bg-console-steel" : "bg-console-danger-solid",
                              )}
                            >
                              {badgeLabel(badge.primary)}
                            </span>
                          ) : null}
                          {(badge.secondary ?? 0) > 0 ? (
                            <span
                              aria-hidden="true"
                              className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-console-muted px-1.5 text-[11px] font-bold leading-none text-console-steel ring-1 ring-console-border"
                              title={badge.secondaryLabel}
                            >
                              {badgeLabel(badge.secondary ?? 0)}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Collapse toggle (desktop only) */}
        <div className="border-t border-console-border px-2 py-3 hidden lg:block">
          <button
            aria-label={collapsed ? ko.shell.expandMenu : ko.shell.collapseMenu}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-console-steel hover:bg-console-muted"
            onClick={onCollapse}
          >
            {collapsed ? (
              <ChevronsRight size={16} aria-hidden="true" />
            ) : (
              <ChevronsLeft size={16} aria-hidden="true" />
            )}
            {!collapsed && <span>{ko.shell.collapseMenu}</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
