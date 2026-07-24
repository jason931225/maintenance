import { useEffect, useRef, useState } from "react";

import { ko } from "../../i18n/ko";
import { Icon } from "./icons";
import type { ScopeOption } from "./authz";

const S = ko.console.shell;

export function Topbar({
  kbdLabel,
  onOpenPalette,
  scopeLabel,
  scopeOptions,
  selectedScopeId,
  scopeOpen,
  onScopeToggle,
  onScopeClose,
  onScopeSelect,
  userName,
  userInitial,
  userRoleLabel,
  userTeamLabel,
  onOpenNavigation,
  navigationDrawerOpen = false,
  onOpenComms,
  commsDrawerOpen = false,
  onLogout,
  onLocalRoleSwitch,
  localRoleSwitchLabel,
}: {
  kbdLabel: string;
  onOpenPalette: () => void;
  scopeLabel: string;
  scopeOptions: ScopeOption[];
  selectedScopeId: string;
  scopeOpen: boolean;
  onScopeToggle: () => void;
  onScopeClose: () => void;
  onScopeSelect: (id: string) => void;
  userName: string;
  userInitial: string;
  userRoleLabel: string;
  /** Team affiliation, rendered as `team · role` when present (else role only). */
  userTeamLabel?: string;
  onOpenNavigation?: () => void;
  navigationDrawerOpen?: boolean;
  onOpenComms?: () => void;
  commsDrawerOpen?: boolean;
  onLogout?: () => void;
  /** Present only for the local DEV-only dynamic chunk. */
  onLocalRoleSwitch?: () => void;
  localRoleSwitchLabel?: string;
}) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const userMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const localRoleSwitchEnabled = Boolean(
    onLocalRoleSwitch && localRoleSwitchLabel,
  );
  const userMenuItemCount =
    Number(localRoleSwitchEnabled) + Number(Boolean(onLogout));

  function restoreUserMenuTriggerFocus() {
    userMenuTriggerRef.current?.focus();
  }

  function closeUserMenu(restoreFocus = false) {
    setUserMenuOpen(false);
    if (restoreFocus) restoreUserMenuTriggerFocus();
  }

  function openUserMenu() {
    setUserMenuOpen(true);
  }

  function moveUserMenuFocus(
    currentIndex: number,
    direction: "first" | "last" | -1 | 1,
  ) {
    if (!userMenuItemCount) return;
    const nextIndex =
      direction === "first"
        ? 0
        : direction === "last"
          ? userMenuItemCount - 1
          : (currentIndex + direction + userMenuItemCount) % userMenuItemCount;
    userMenuItemRefs.current[nextIndex]?.focus();
  }

  useEffect(() => {
    if (!scopeOpen) return undefined;

    function onMouseDown(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Node && scopeRef.current?.contains(target)) return;
      onScopeClose();
    }

    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onScopeClose, scopeOpen]);

  useEffect(() => {
    if (!userMenuOpen) return;
    userMenuItemRefs.current[0]?.focus();
  }, [userMenuOpen]);

  useEffect(() => {
    if (!userMenuOpen) return undefined;
    function onMouseDown(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Node && userMenuRef.current?.contains(target))
        return;
      setUserMenuOpen(false);
      restoreUserMenuTriggerFocus();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        restoreUserMenuTriggerFocus();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [userMenuOpen]);

  return (
    <header
      data-cshell-topbar
      style={{
        flex: "none",
        height: 56,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      {onOpenNavigation && (
        <button
          type="button"
          onClick={onOpenNavigation}
          aria-label={S.sidebar.open}
          aria-controls="console-navigation-drawer"
          aria-expanded={navigationDrawerOpen}
          className="cshell-mobile-trigger cshell-hoverable cshell-focusable"
        >
          <Icon name="chevronsRight" size={18} strokeWidth={2} />
        </button>
      )}
      {/* search / palette trigger */}
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label={S.palette.label}
        aria-keyshortcuts="Meta+K Control+K"
        className="cshell-search cshell-focusable"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          flex: "0 1 340px",
          minWidth: 110,
          padding: "6px 11px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--canvas)",
          color: "var(--faint)",
          fontSize: 12.5,
          overflow: "hidden",
        }}
      >
        <Icon name="search" size={14} strokeWidth={2} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {S.search.placeholder}
        </span>
        <span
          aria-hidden="true"
          style={{
            flex: "none",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 700,
            padding: "1px 5px",
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--surface)",
          }}
        >
          {kbdLabel}
        </span>
      </button>

      {/* scope switcher */}
      <div ref={scopeRef} style={{ position: "relative", flex: "none" }}>
        <button
          type="button"
          onClick={onScopeToggle}
          aria-haspopup="listbox"
          aria-expanded={scopeOpen}
          aria-label={S.scope.label}
          className="cshell-scope cshell-focusable"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 11px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--ink)",
            fontSize: 12.5,
            fontWeight: 700,
            whiteSpace: "nowrap",
          }}
        >
          <Icon
            name="building"
            size={14}
            strokeWidth={2}
            style={{ color: "var(--steel)" }}
          />
          <span>{scopeLabel}</span>
          <Icon
            name="chevronDown"
            size={12}
            strokeWidth={2}
            style={{ color: "var(--faint)" }}
          />
        </button>
        {scopeOpen && (
          <div
            role="listbox"
            aria-label={S.scope.list}
            className="cshell-pop"
            style={{
              position: "absolute",
              left: 0,
              top: "calc(100% + 6px)",
              zIndex: 70,
              width: 250,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "var(--shadow-pop)",
              padding: 5,
            }}
          >
            {scopeOptions.map((opt) => {
              const selected = opt.id === selectedScopeId;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onScopeSelect(opt.id);
                  }}
                  className="cshell-hoverable cshell-focusable"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    width: "100%",
                    padding: "7.5px 10px",
                    borderRadius: 7,
                    border: "none",
                    background: "transparent",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      fontWeight: selected ? 800 : 600,
                      color: "var(--ink)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {opt.label}
                  </span>
                  {selected && (
                    <Icon
                      name="circleCheck"
                      size={14}
                      strokeWidth={2.5}
                      style={{ color: "var(--ok-solid)" }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {onOpenComms && (
        <button
          type="button"
          onClick={onOpenComms}
          aria-label={S.rail.open}
          aria-controls="console-comms-drawer"
          aria-expanded={commsDrawerOpen}
          className="cshell-mobile-trigger cshell-hoverable cshell-focusable"
        >
          <Icon name="msg" size={18} strokeWidth={2} />
        </button>
      )}

      <div ref={userMenuRef} style={{ position: "relative", flex: "none" }}>
        <button
          ref={userMenuTriggerRef}
          type="button"
          aria-label={S.user.menu}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          onClick={() => {
            if (userMenuOpen) closeUserMenu(false);
            else openUserMenu();
          }}
          className="cshell-hoverable cshell-focusable"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "4px 9px 4px 5px",
            border: "none",
            borderRadius: 9,
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              flex: "none",
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "var(--ink)",
              color: "var(--surface)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {userInitial}
          </span>
          <span style={{ textAlign: "left" }}>
            <span
              style={{
                display: "block",
                fontSize: 12.5,
                fontWeight: 700,
                color: "var(--ink)",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
              }}
            >
              {userName}
            </span>
            <span
              style={{
                display: "block",
                fontSize: 10,
                fontWeight: 600,
                color: "var(--faint)",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
              }}
            >
              {[userTeamLabel, userRoleLabel].filter(Boolean).join(" · ")}
            </span>
          </span>
        </button>
        {userMenuOpen && (
          <div
            role="menu"
            aria-label={S.user.menu}
            className="cshell-pop"
            onKeyDown={(event) => {
              const currentIndex = userMenuItemRefs.current.findIndex(
                (item) => item === document.activeElement,
              );
              if (event.key === "Escape") {
                event.preventDefault();
                closeUserMenu(true);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                moveUserMenuFocus(currentIndex, 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveUserMenuFocus(currentIndex, -1);
              } else if (event.key === "Home") {
                event.preventDefault();
                moveUserMenuFocus(currentIndex, "first");
              } else if (event.key === "End") {
                event.preventDefault();
                moveUserMenuFocus(currentIndex, "last");
              }
            }}
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              zIndex: 70,
              minWidth: 190,
              padding: 5,
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--surface)",
              boxShadow: "var(--shadow-pop)",
            }}
          >
            {localRoleSwitchEnabled && (
              <button
                ref={(node) => {
                  userMenuItemRefs.current[0] = node;
                }}
                type="button"
                role="menuitem"
                className="cshell-hoverable cshell-focusable"
                onClick={() => {
                  closeUserMenu(true);
                  onLocalRoleSwitch?.();
                }}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  border: "none",
                  borderRadius: 7,
                  background: "transparent",
                  color: "var(--ink)",
                  textAlign: "left",
                }}
              >
                {localRoleSwitchLabel}
              </button>
            )}
            {onLogout && (
              <button
                ref={(node) => {
                  userMenuItemRefs.current[Number(localRoleSwitchEnabled)] =
                    node;
                }}
                type="button"
                role="menuitem"
                className="cshell-hoverable cshell-focusable"
                onClick={() => {
                  closeUserMenu(true);
                  onLogout();
                }}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  border: "none",
                  borderRadius: 7,
                  background: "transparent",
                  color: "var(--ink)",
                  textAlign: "left",
                }}
              >
                {S.user.logout}
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
