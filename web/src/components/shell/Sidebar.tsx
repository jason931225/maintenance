import { ChevronsLeft, ChevronsRight, Wrench } from "lucide-react";
import { NavLink } from "react-router-dom";

import { cn } from "../../lib/utils";
import { ko } from "../../i18n/ko";
import { NAV_GROUPS } from "./nav";
import type { AuthSession } from "../../context/auth";

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapse: () => void;
  onMobileClose: () => void;
  session: AuthSession | undefined;
}

type Role = NonNullable<AuthSession["role"]>;

const groupLabels: Record<string, string> = {
  operations: ko.nav.groups.operations,
  data: ko.nav.groups.data,
  settings: ko.nav.groups.settings,
};

function navGroupLabel(key: string): string {
  return groupLabels[key] ?? key;
}

function isItemVisible(itemKey: string, role: Role | undefined): boolean {
  if (itemKey === "kpi" && role !== "executive" && role !== "admin" && role !== "super-admin") {
    return false;
  }
  if (itemKey === "approvals" && role !== "admin" && role !== "super-admin") {
    return false;
  }
  if (itemKey === "intake" && role !== "admin" && role !== "super-admin" && role !== "technician") {
    return false;
  }
  return true;
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onCollapse,
  onMobileClose,
  session,
}: SidebarProps) {
  const role = session?.role;

  const filteredGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => isItemVisible(item.key, role)),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-slate-950/40 lg:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside
        aria-label={ko.shell.title}
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col bg-white border-r border-slate-200 transition-all duration-200",
          collapsed ? "w-16" : "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:translate-x-0 lg:z-auto",
        )}
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-3 px-4 border-b border-slate-200 shrink-0">
          <Wrench size={20} className="text-slate-950 shrink-0" aria-hidden="true" />
          {!collapsed && (
            <span className="font-bold text-slate-950 truncate">{ko.shell.title}</span>
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
                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
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
                            ? "bg-slate-100 text-slate-950 font-semibold"
                            : "text-slate-600 hover:bg-slate-50 hover:text-slate-950",
                        )
                      }
                      title={collapsed ? labelStr : undefined}
                    >
                      <item.Icon
                        size={18}
                        aria-hidden="true"
                        className="shrink-0"
                      />
                      {!collapsed && <span className="truncate">{labelStr}</span>}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Collapse toggle (desktop only) */}
        <div className="border-t border-slate-200 px-2 py-3 hidden lg:block">
          <button
            aria-label={collapsed ? ko.shell.expandMenu : ko.shell.collapseMenu}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            onClick={onCollapse}
          >
            {collapsed ? <ChevronsRight size={16} aria-hidden="true" /> : <ChevronsLeft size={16} aria-hidden="true" />}
            {!collapsed && <span>{ko.shell.collapseMenu}</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
