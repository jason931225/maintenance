import { LogOut, MapPin, Menu, RefreshCw, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useActiveBranchId, useAuth } from "../../context/auth";
import { useCurrentTitle } from "../../context/title";
import { ko } from "../../i18n/ko";

interface TopbarProps {
  onOpenMobileSidebar: () => void;
}

export function Topbar({ onOpenMobileSidebar }: TopbarProps) {
  const title = useCurrentTitle();

  return (
    <header className="h-14 flex items-center gap-4 px-4 border-b border-slate-200 bg-white shrink-0 z-30 sticky top-0">
      {/* Mobile hamburger */}
      <button
        className="lg:hidden rounded-md p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-slate-500"
        aria-label={ko.shell.openMenu}
        onClick={onOpenMobileSidebar}
      >
        <Menu size={20} aria-hidden="true" />
      </button>

      {/* Contextual page label — the primary <h1> lives in each page's PageHeader. */}
      <div className="flex-1 min-w-0">
        {title ? (
          <p className="text-sm font-medium text-slate-600 truncate">{title}</p>
        ) : null}
      </div>

      {/* Branch chip */}
      <BranchChip />

      {/* User menu */}
      <UserMenu />
    </header>
  );
}

function BranchChip() {
  const branchId = useActiveBranchId();
  if (!branchId) return null;
  return (
    <span className="hidden sm:inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600">
      {ko.shell.branch}: {branchId.slice(-4)}
    </span>
  );
}

function UserMenu() {
  const { session, logout, refresh } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-slate-500"
      >
        <User size={18} aria-hidden="true" />
        <span className="hidden sm:inline">{session?.user_id ?? ko.shell.user}</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-slate-200 bg-white py-1 shadow-md"
        >
          <div className="border-b border-slate-100 px-4 py-2">
            <p className="text-xs text-slate-500">{ko.shell.user}</p>
            <p className="text-sm font-semibold text-slate-950 truncate">
              {session?.user_id ?? "—"}
            </p>
          </div>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
            onClick={() => { setOpen(false); void refresh(); }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {ko.shell.refreshToken}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
            onClick={() => { setOpen(false); void navigate("/settings/location"); }}
          >
            <MapPin size={16} aria-hidden="true" />
            {ko.shell.locationSettings}
          </button>
          <div className="border-t border-slate-100">
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
