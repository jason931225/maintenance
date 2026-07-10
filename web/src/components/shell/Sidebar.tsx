import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

import type { components } from "@maintenance/api-client-ts";
import type { AuthSession } from "../../context/auth";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { NOTIFICATION_COUNTS_INVALIDATED } from "../../lib/notification-events";
import { cn } from "../../lib/utils";
import {
  FEATURES,
  hasAnyFeatureGrant,
  NAV_GROUPS,
  isNavItemVisible,
} from "./nav";
import { navGroupLabel, navItemLabel } from "./nav-labels";

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapse: () => void;
  onMobileClose: () => void;
  session: AuthSession | undefined;
}

type SupportTicketSummary = components["schemas"]["SupportTicketSummary"];

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

function isOpenSupportTicket(ticket: Pick<SupportTicketSummary, "status">): boolean {
  return ticket.status === "OPEN" || ticket.status === "IN_PROGRESS" || ticket.status === "ON_HOLD";
}

const MAIL_BADGE_FEATURES = [FEATURES.MAIL_USE] as const;

export function Sidebar({
  collapsed,
  mobileOpen,
  onCollapse,
  onMobileClose,
  session,
}: SidebarProps) {
  const { api } = useAuth();
  const roles = session?.roles;
  const groupRoles = session?.group_roles;
  const featureGrants = session?.feature_grants;
  const [counts, setCounts] = useState<NavCounts>({});
  const panelRef = useRef<HTMLElement>(null);

  // Mobile drawer is a modal dialog (role/aria-modal set below): trap focus
  // while open and restore it on close. The rebuilt shell dropped this; without
  // it the 320px drawer is an unlabeled complementary and fails the a11y guard.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const panelEl = panelRef.current;
    if (!panelEl) return undefined;
    const previouslyFocused = document.activeElement;

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
        // getClientRects() is empty when the element or an ancestor is
        // display:none (e.g. the desktop-only collapse toggle inside the mobile
        // drawer) — excludes it from the trap's last stop.
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
  const visibleItemKeys = useMemo(
    () => new Set(filteredGroups.flatMap((group) => group.items.map((item) => item.key))),
    [filteredGroups],
  );
  const canLoadMailBadge = hasAnyFeatureGrant(featureGrants, MAIL_BADGE_FEATURES);


  useEffect(() => {
    let ignore = false;
    async function loadCounts() {
      const next: NavCounts = {};
      await Promise.all([
        visibleItemKeys.has("approvals")
          ? api
              .GET("/api/approval-items", { params: { query: { limit: 100, offset: 0 } } })
              .then((response) => {
                const count = response.data?.total ?? response.data?.items.length ?? 0;
                if (count > 0) {
                  next.approvals = {
                    primary: count,
                    tone: "attention",
                    ariaLabel: navBadgeAria(
                      ko.shell.navBadges.pendingApprovals,
                      navItemLabel("approvals"),
                      count,
                    ),
                  };
                }
              })
              .catch(() => undefined)
          : Promise.resolve(),
        visibleItemKeys.has("messenger")
          ? api
              .GET("/api/messenger/threads", { params: { query: { limit: 100 } } })
              .then((response) => {
                const count =
                  response.data?.items.reduce(
                    (sum, thread) => sum + Math.max(0, thread.unread_count),
                    0,
                  ) ?? 0;
                if (count > 0) {
                  next.messenger = {
                    primary: count,
                    tone: "attention",
                    ariaLabel: navBadgeAria(
                      ko.shell.navBadges.unreadMessages,
                      navItemLabel("messenger"),
                      count,
                    ),
                  };
                }
              })
              .catch(() => undefined)
          : Promise.resolve(),
        visibleItemKeys.has("mail") && canLoadMailBadge
          ? api
              .GET("/api/v1/mail/folders")
              .then((response) => {
                const count =
                  response.data?.reduce(
                    (sum, folder) => sum + Math.max(0, folder.unread_count),
                    0,
                  ) ?? 0;
                if (count > 0) {
                  next.mail = {
                    primary: count,
                    tone: "attention",
                    ariaLabel: navBadgeAria(
                      ko.shell.navBadges.unreadMail,
                      navItemLabel("mail"),
                      count,
                    ),
                  };
                }
              })
              .catch(() => undefined)
          : Promise.resolve(),
        visibleItemKeys.has("support")
          ? api
              .GET("/api/v1/support/tickets", {
                params: { query: { include_untriaged: true, limit: 100 } },
              })
              .then((response) => {
                const tickets = response.data?.items ?? [];
                const open = tickets.filter(isOpenSupportTicket).length;
                const customerUnread = tickets.filter(
                  (ticket) => ticket.origin === "CUSTOMER" && isOpenSupportTicket(ticket),
                ).length;
                if (open > 0 || customerUnread > 0) {
                  next.support = {
                    primary: customerUnread,
                    secondary: open,
                    tone: customerUnread > 0 ? "attention" : "neutral",
                    ariaLabel: ko.shell.navBadges.supportSummary
                      .replace("{unread}", String(customerUnread))
                      .replace("{open}", String(open)),
                    secondaryLabel: ko.shell.navBadges.openShort,
                  };
                }
              })
              .catch(() => undefined)
          : Promise.resolve(),
      ]);
      if (!ignore) setCounts(next);
    }
    void loadCounts();
    function reloadCounts() {
      void loadCounts();
    }
    window.addEventListener(NOTIFICATION_COUNTS_INVALIDATED, reloadCounts);
    return () => {
      ignore = true;
      window.removeEventListener(NOTIFICATION_COUNTS_INVALIDATED, reloadCounts);
    };
  }, [api, canLoadMailBadge, visibleItemKeys]);

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-ink/40 lg:hidden"
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
          "fixed inset-y-0 left-0 z-30 flex flex-col bg-white border-r border-line transition-all duration-200",
          collapsed ? "w-16" : "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:translate-x-0 lg:z-auto",
        )}
      >
        {/* Brand — DS letter mark: rounded brand-amber square + bold "C" (no logo asset). */}
        <div className="flex h-14 items-center gap-3 px-4 border-b border-line shrink-0">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-signal text-base font-black text-ink"
          >
            C
          </span>
          {!collapsed && (
            <span className="font-bold text-ink truncate">
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
                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-steel">
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
                          // Active-nav brand accent (DS: amber active accents), via tokens.
                          isActive
                            ? "bg-muted-panel text-ink font-semibold before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-signal before:content-['']"
                            : "text-steel hover:bg-muted-panel hover:text-ink",
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
                      {showBadge ? (
                        <span
                          className={cn(
                            "ml-auto inline-flex min-w-10 justify-end gap-1",
                            collapsed && "absolute right-1 top-1 ml-0 min-w-0",
                          )}
                          aria-label={badge.ariaLabel}
                        >
                          {badge.primary > 0 ? (
                            <span
                              aria-hidden="true"
                              className={cn(
                                "inline-flex min-h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none text-white",
                                badge.tone === "neutral" ? "bg-steel" : "bg-red-600",
                                collapsed && "min-h-4 min-w-4 px-1 text-[10px]",
                              )}
                            >
                              {badgeLabel(badge.primary)}
                            </span>
                          ) : null}
                          {(badge.secondary ?? 0) > 0 ? (
                            <span
                              aria-hidden="true"
                              className={cn(
                                "inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-muted-panel px-1.5 text-[11px] font-bold leading-none text-steel ring-1 ring-line",
                                collapsed && "hidden",
                              )}
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
        <div className="border-t border-line px-2 py-3 hidden lg:block">
          <button
            aria-label={collapsed ? ko.shell.expandMenu : ko.shell.collapseMenu}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-steel hover:bg-muted-panel"
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
