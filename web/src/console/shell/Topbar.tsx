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
  onScopeSelect,
  userName,
  userInitial,
  userRoleLabel,
}: {
  kbdLabel: string;
  onOpenPalette: () => void;
  scopeLabel: string;
  scopeOptions: ScopeOption[];
  selectedScopeId: string;
  scopeOpen: boolean;
  onScopeToggle: () => void;
  onScopeSelect: (id: string) => void;
  userName: string;
  userInitial: string;
  userRoleLabel: string;
}) {
  return (
    <header
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
      <div style={{ position: "relative", flex: "none" }}>
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
          <Icon name="building" size={14} strokeWidth={2} style={{ color: "var(--steel)" }} />
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

      {/* user / role card — presentational identity chrome; the self personnel
          card modal (onClick target in the prototype) arrives in a later slice,
          so P0.1 renders it as a labelled group, not an unwired button. */}
      <div
        role="group"
        aria-label={S.user.menu}
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "4px 9px 4px 5px",
          borderRadius: 9,
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
            {userRoleLabel}
          </span>
        </span>
      </div>
    </header>
  );
}
