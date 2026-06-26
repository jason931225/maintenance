import { ChevronsLeft, ChevronsRight, PanelsTopLeft } from "lucide-react";
import { NavLink } from "react-router-dom";

import { cn } from "../../lib/utils";
import { ko } from "../../i18n/ko";
import { NAV_GROUPS, isNavItemVisible } from "./nav";
import type { AuthSession } from "../../context/auth";

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapse: () => void;
  onMobileClose: () => void;
  session: AuthSession | undefined;
}

const groupLabels: Record<string, string> = {
  operations: ko.nav.groups.operations,
  executive: ko.nav.groups.executive,
  assets: ko.nav.groups.assets,
  finance: ko.nav.groups.finance,
  organization: ko.nav.groups.organization,
  identity: ko.nav.groups.identity,
  settings: ko.nav.groups.settings,
};

function navGroupLabel(key: string): string {
  return groupLabels[key] ?? key;
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onCollapse,
  onMobileClose,
  session,
}: SidebarProps) {
  const roles = session?.roles;

  const filteredGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => isNavItemVisible(item.key, roles)),
  })).filter((group) => group.items.length > 0);

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
        aria-label={ko.shell.title}
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col bg-white border-r border-line transition-all duration-200",
          collapsed ? "w-16" : "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:translate-x-0 lg:z-auto",
        )}
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-3 px-4 border-b border-line shrink-0">
          <PanelsTopLeft
            size={20}
            className="text-ink shrink-0"
            aria-hidden="true"
          />
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
                  const label = ko.nav[item.key as keyof typeof ko.nav];
                  const labelStr = typeof label === "string" ? label : item.key;
                  return (
                    <NavLink
                      key={item.key}
                      to={item.href}
                      onClick={() => {
                        if (mobileOpen) onMobileClose();
                      }}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                          isActive
                            ? "bg-muted-panel text-ink font-semibold"
                            : "text-steel hover:bg-muted-panel hover:text-ink",
                        )
                      }
                      title={collapsed ? labelStr : undefined}
                    >
                      <item.Icon
                        size={18}
                        aria-hidden="true"
                        className="shrink-0"
                      />
                      {!collapsed && (
                        <span className="truncate">{labelStr}</span>
                      )}
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
