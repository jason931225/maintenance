import { Bell, LogOut, MapPin, Menu, PanelRight, RefreshCw, Search, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useActiveBranchId, useAuth } from "../../context/auth";
import { GroupScopeSwitcher } from "../../features/group/GroupScopeSwitcher";
import { roleLabel } from "../../features/org/org-format";
import { ko } from "../../i18n/ko";
import { useActiveBranchName } from "../../lib/useActiveBranchName";
import { NOTIFICATION_COUNTS_INVALIDATED } from "../../lib/notification-events";
import { cn, identityLabel, safeLabel } from "../../lib/utils";
import {
  FEATURES,
  hasAnyFeatureGrant,
  hasGroupAdminRole,
  hasGrantedConsoleAccess,
  isNavItemVisible,
} from "./nav";

interface TopbarProps {
  onOpenMobileSidebar: () => void;
  onOpenCommandPalette?: () => void;
  onToggleComms?: () => void;
  commsOpen?: boolean;
}

export function Topbar({
  onOpenMobileSidebar,
  onOpenCommandPalette,
  onToggleComms,
  commsOpen = false,
}: TopbarProps) {
  return (
    <header className="h-14 flex items-center gap-4 px-4 border-b border-line bg-white shrink-0 z-30 sticky top-0">
      {/* Mobile hamburger */}
      <button
        className="lg:hidden rounded-md p-2 text-steel hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-ink"
        aria-label={ko.shell.openMenu}
        onClick={onOpenMobileSidebar}
      >
        <Menu size={20} aria-hidden="true" />
      </button>

      {onOpenCommandPalette ? (
        <button
          type="button"
          aria-label={ko.shell.commandPalette.open}
          onClick={onOpenCommandPalette}
          className="hidden min-w-44 items-center justify-between gap-3 rounded-lg border border-line bg-muted-panel/60 px-3 py-1.5 text-sm text-steel transition hover:bg-muted-panel hover:text-ink focus-visible:outline-2 focus-visible:outline-signal md:flex"
        >
          <span className="inline-flex min-w-0 items-center gap-2">
            <Search size={15} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{ko.shell.commandPalette.trigger}</span>
          </span>
          <kbd className="rounded border border-line bg-white px-1.5 py-0.5 text-[10px] font-semibold text-steel">
            Ctrl/⌘K
          </kbd>
        </button>
      ) : null}

      <GroupScopeSwitcher />

      {/* The page title's single source is each page's PageHeader <h1>. */}
      <div className="flex-1" />

      {onToggleComms ? (
        <button
          type="button"
          aria-label={commsOpen ? ko.commsRail.close : ko.commsRail.open}
          aria-pressed={commsOpen}
          onClick={onToggleComms}
          className="hidden rounded-md p-2 text-steel hover:bg-muted-panel hover:text-ink focus-visible:outline-2 focus-visible:outline-ink lg:inline-flex"
        >
          <PanelRight size={18} aria-hidden="true" />
        </button>
      ) : null}

      <NotificationBell />

      {/* Branch chip */}
      <BranchChip />

      {/* User menu */}
      <UserMenu />
    </header>
  );
}

interface NotificationCounts {
  pendingApprovals: number;
  submittedDocuments: number;
  completedApprovals: number;
  messenger: number;
  mail: number;
  supportUnread: number;
  supportOpen: number;
  other: number;
}

const emptyNotificationCounts: NotificationCounts = {
  pendingApprovals: 0,
  submittedDocuments: 0,
  completedApprovals: 0,
  messenger: 0,
  mail: 0,
  supportUnread: 0,
  supportOpen: 0,
  other: 0,
};
const MAIL_BADGE_FEATURES = [FEATURES.MAIL_USE] as const;


function notificationTotal(counts: NotificationCounts): number {
  return counts.pendingApprovals + counts.messenger + counts.mail + counts.supportUnread + counts.other;
}

function notificationBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function isCompletedApprovalStatus(status: string): boolean {
  return ["APPROVED", "ADMIN_APPROVED", "EXECUTIVE_APPROVED", "COMPLETED"].includes(status);
}

function isOpenSupportStatus(status: string): boolean {
  return status === "OPEN" || status === "IN_PROGRESS" || status === "ON_HOLD";
}

function NotificationBell() {
  const { api, session } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<NotificationCounts>(emptyNotificationCounts);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const roles = session?.roles;
  const groupRoles = session?.group_roles;
  const featureGrants = session?.feature_grants;
  const canLoadApprovals = isNavItemVisible("approvals", roles, groupRoles, featureGrants);
  const canLoadMessenger = isNavItemVisible("messenger", roles, groupRoles, featureGrants);
  const canLoadMail = hasAnyFeatureGrant(featureGrants, MAIL_BADGE_FEATURES);
  const canLoadSupport = isNavItemVisible("support", roles, groupRoles, featureGrants);
  const notificationItems = notificationRows(counts);
  const total = notificationTotal(counts);

  useEffect(() => {
    let ignore = false;
    async function loadNotifications() {
      let failed = false;
      setLoading(true);
      const next: NotificationCounts = { ...emptyNotificationCounts };
      await Promise.all([
        canLoadApprovals
          ? api
              .GET("/api/approval-items", { params: { query: { limit: 100, offset: 0 } } })
              .then((response) => {
                const approvalItems = response.data?.items ?? [];
                const sourceTotal = response.data?.sources.reduce(
                  (sum, source) => sum + source.count,
                  0,
                );
                next.pendingApprovals = response.data?.total ?? approvalItems.length;
                next.submittedDocuments = sourceTotal ?? next.pendingApprovals;
                next.completedApprovals = approvalItems.filter((item) =>
                  isCompletedApprovalStatus(item.status),
                ).length;
              })
              .catch(() => { failed = true; })
          : Promise.resolve(),
        canLoadMessenger
          ? api
              .GET("/api/messenger/threads", { params: { query: { limit: 100 } } })
              .then((response) => {
                next.messenger = response.data?.items.reduce(
                  (sum, thread) => sum + Math.max(0, thread.unread_count),
                  0,
                ) ?? 0;
              })
              .catch(() => { failed = true; })
          : Promise.resolve(),
        canLoadMail
          ? api
              .GET("/api/v1/mail/folders")
              .then((response) => {
                next.mail = response.data?.reduce(
                  (sum, folder) => sum + Math.max(0, folder.unread_count),
                  0,
                ) ?? 0;
              })
              .catch(() => { failed = true; })
          : Promise.resolve(),
        canLoadSupport
          ? api
              .GET("/api/v1/support/tickets", {
                params: { query: { include_untriaged: true, limit: 100 } },
              })
              .then((response) => {
                const tickets = response.data?.items ?? [];
                next.supportOpen = tickets.filter((ticket) =>
                  isOpenSupportStatus(ticket.status),
                ).length;
                next.supportUnread = tickets.filter(
                  (ticket) => ticket.origin === "CUSTOMER" && isOpenSupportStatus(ticket.status),
                ).length;
              })
              .catch(() => { failed = true; })
          : Promise.resolve(),
      ]);
      if (!ignore) {
        setCounts(next);
        setLoadError(failed);
        setLoading(false);
      }
    }
    void loadNotifications();
    function reloadNotifications() {
      void loadNotifications();
    }
    window.addEventListener(NOTIFICATION_COUNTS_INVALIDATED, reloadNotifications);
    const timer = window.setInterval(() => { void loadNotifications(); }, 30_000);
    return () => {
      ignore = true;
      window.removeEventListener(NOTIFICATION_COUNTS_INVALIDATED, reloadNotifications);
      window.clearInterval(timer);
    };
  }, [api, canLoadApprovals, canLoadMail, canLoadMessenger, canLoadSupport]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={ko.shell.notifications.open}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); }}
        className="relative rounded-md p-2 text-steel hover:bg-muted-panel hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
      >
        <Bell size={18} aria-hidden="true" />
        {total > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
            {notificationBadge(total)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-line bg-white p-3 shadow-md"
          role="dialog"
          aria-label={ko.shell.notifications.title}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink">{ko.shell.notifications.title}</p>
            <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
              {notificationBadge(total)}
            </span>
          </div>
          {loading ? (
            <p className="mb-2 rounded-md bg-muted-panel px-2 py-1 text-xs text-steel">
              {ko.shell.notifications.loading}
            </p>
          ) : null}
          {loadError ? (
            <p role="alert" className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">
              {ko.shell.notifications.loadFailed}
            </p>
          ) : null}
          {!loading && !loadError && total === 0 ? (
            <p className="mb-2 rounded-md border border-dashed border-line px-2 py-2 text-sm text-steel">
              {ko.shell.notifications.empty}
            </p>
          ) : null}
          <ul className="grid gap-2 text-sm text-steel">
            {notificationItems.map((item) => (
              <NotificationCountRow
                key={item.href}
                label={item.label}
                count={item.count}
                onClick={() => {
                  setOpen(false);
                  void navigate(item.href);
                }}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

interface NotificationRowItem {
  label: string;
  count: number;
  href: string;
}

function notificationRows(counts: NotificationCounts): NotificationRowItem[] {
  return [
    {
      label: ko.shell.notifications.approvals,
      count: counts.pendingApprovals,
      href: "/approvals",
    },
    {
      label: ko.shell.notifications.messages,
      count: counts.messenger,
      href: "/messenger",
    },
    {
      label: ko.shell.notifications.mail,
      count: counts.mail,
      href: "/mail",
    },
    {
      label: ko.shell.notifications.supportUnread,
      count: counts.supportUnread,
      href: "/support",
    },
  ].filter((item) => item.count > 0);
}

function NotificationCountRow({
  label,
  count,
  onClick,
}: {
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-signal"
        onClick={onClick}
      >
        <span>{label}</span>
        <strong className="text-ink">{count}</strong>
      </button>
    </li>
  );
}

export function BranchChip() {
  const branchId = useActiveBranchId();
  const branchName = useActiveBranchName();
  if (!branchId) return null;
  // Show the resolved branch NAME, never the raw UUID. While the name is still
  // loading, fall back to a neutral label; safeLabel guarantees a UUID-shaped
  // value can never reach the chip.
  return (
    <span className="hidden sm:inline-flex items-center rounded-md border border-line bg-muted-panel px-2 py-1 text-xs font-medium text-steel">
      {ko.shell.branch}: {safeLabel(branchName, ko.shell.branchUnknown)}
    </span>
  );
}

function UserMenu() {
  const { session, logout, refresh } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Identity for the menu chrome: the display name (JWT `name` claim), then
  // email, then a generic label — never the raw user_id UUID (identityLabel
  // enforces this). The role chip shows the granted role, or a pending-approval
  // badge for a just-signed-up user with no console grant yet.
  const name = identityLabel(session, ko.shell.user);
  const isGroupAdmin = hasGroupAdminRole(session?.group_roles);
  const pending = !hasGrantedConsoleAccess(
    session?.roles,
    session?.group_roles,
    session?.feature_grants,
  );
  const canOpenLocationSettings = isNavItemVisible(
    "location",
    session?.roles,
    session?.group_roles,
    session?.feature_grants,
  );
  const primaryRole = session?.roles?.find((role) => role !== "MEMBER");
  const roleChip = pending
    ? ko.shell.pendingApproval
    : primaryRole
      ? roleLabel(primaryRole)
      : isGroupAdmin
        ? ko.shell.groupAdmin
        : undefined;

  // Close on outside click and on Escape — the interactions users expect from a
  // menu (the previous <details> element offered neither).
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function handleLogout() {
    setOpen(false);
    await logout();
    void navigate("/login");
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ko.shell.userMenu}
        onClick={() => { setOpen((value) => !value); }}
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-steel hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-ink"
      >
        <User size={18} aria-hidden="true" />
        <span className="hidden sm:inline">{name}</span>
        {roleChip ? (
          <span
            className={cn(
              "hidden items-center rounded-md px-1.5 py-0.5 text-xs font-medium sm:inline-flex",
              pending
                ? "border border-amber-300 bg-amber-50 text-amber-900"
                : "border border-line bg-muted-panel text-steel",
            )}
          >
            {roleChip}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-line bg-white py-1 shadow-md"
        >
          <div className="border-b border-line px-4 py-2">
            <p className="text-xs text-steel">{ko.shell.user}</p>
            <p className="text-sm font-semibold text-ink truncate">{name}</p>
            {roleChip ? (
              <p className="mt-0.5 text-xs text-steel">{roleChip}</p>
            ) : null}
          </div>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-4 py-2 text-sm text-steel hover:bg-muted-panel"
            onClick={() => { setOpen(false); void refresh(); }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {ko.shell.refreshToken}
          </button>
          {canOpenLocationSettings ? (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-steel hover:bg-muted-panel"
              onClick={() => { setOpen(false); void navigate("/settings/location"); }}
            >
              <MapPin size={16} aria-hidden="true" />
              {ko.shell.locationSettings}
            </button>
          ) : null}
          <div className="border-t border-line">
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-700 hover:bg-red-50"
              onClick={() => { void handleLogout(); }}
            >
              <LogOut size={16} aria-hidden="true" />
              {ko.shell.logout}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
