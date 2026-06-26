import { LogOut, MapPin, Menu, RefreshCw, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useActiveBranchId, useAuth } from "../../context/auth";
import { useCurrentTitle } from "../../context/title";
import { roleLabel } from "../../features/org/org-format";
import { ko } from "../../i18n/ko";
import { useActiveBranchName } from "../../lib/useActiveBranchName";
import { cn, identityLabel, safeLabel } from "../../lib/utils";
import { hasGroupAdminRole, isPendingMember } from "./nav";

interface TopbarProps {
  onOpenMobileSidebar: () => void;
}

export function Topbar({ onOpenMobileSidebar }: TopbarProps) {
  const title = useCurrentTitle();

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

      {/* Contextual page label — the primary <h1> lives in each page's PageHeader. */}
      <div className="flex-1 min-w-0">
        {title ? (
          <p className="text-sm font-medium text-steel truncate">{title}</p>
        ) : null}
      </div>

      {/* Branch chip */}
      <BranchChip />

      {/* User menu */}
      <UserMenu />
    </header>
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
  // badge for a just-signed-up user with no role yet.
  const name = identityLabel(session, ko.shell.user);
  const isGroupAdmin = hasGroupAdminRole(session?.group_roles);
  const pending = isPendingMember(session?.roles) && !isGroupAdmin;
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
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-4 py-2 text-sm text-steel hover:bg-muted-panel"
            onClick={() => { setOpen(false); void navigate("/settings/location"); }}
          >
            <MapPin size={16} aria-hidden="true" />
            {ko.shell.locationSettings}
          </button>
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
