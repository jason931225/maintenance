import type { CSSProperties, ReactNode } from "react";

import { ko } from "../../i18n/ko";
import { HEADER_BAND_MAX } from "./windowModel";

const T = ko.console.window;

const frameStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  background: "var(--surface)",
  color: "var(--ink)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  boxShadow: "var(--shadow-pop)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  minHeight: 48,
  maxHeight: HEADER_BAND_MAX,
  padding: "0 var(--sp-2) 0 var(--sp-4)",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
};

const titleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  color: "var(--ink)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  letterSpacing: "var(--tracking-tight)",
};

const controlsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-1)",
  flexShrink: 0,
};

const controlButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 44,
  height: 44,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--steel)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "var(--sp-5)",
};

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-window-control=""
      aria-label={label}
      title={label}
      onClick={onClick}
      style={controlButtonStyle}
    >
      {children}
    </button>
  );
}

const iconStyle: CSSProperties = { width: 16, height: 16, display: "block" };

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" focusable="false" style={iconStyle}>
      <path d="M3 12h10" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" focusable="false" style={iconStyle}>
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Pinned-panel chrome: title band (≤54px) + the minimize/close control cluster.
 * Popout (팝아웃) is omitted this slice, so per §4.7 the pinned panel exposes only
 * minimize + close; the pin/unpin toggle is the double-click-header gesture the
 * host wires through `togglePin`, not a redundant button here.
 */
export function WindowFrame({
  title,
  labelId,
  onMinimize,
  onClose,
  children,
}: {
  title: string;
  labelId: string;
  onMinimize: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div style={frameStyle}>
      <div style={headerStyle}>
        <span id={labelId} style={titleStyle}>
          {title}
        </span>
        <div style={controlsStyle}>
          <ControlButton label={T.minimize} onClick={onMinimize}>
            <MinimizeIcon />
          </ControlButton>
          <ControlButton label={T.close} onClick={onClose}>
            <CloseIcon />
          </ControlButton>
        </div>
      </div>
      <div style={bodyStyle}>{children}</div>
    </div>
  );
}

const trayDockStyle: CSSProperties = {
  position: "fixed",
  left: "var(--sp-5)",
  bottom: "var(--sp-5)",
  zIndex: 1200,
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
  maxWidth: "min(92vw, 620px)",
  padding: "var(--sp-2)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-pill)",
  boxShadow: "var(--shadow-pop)",
};

const trayChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: "0 var(--sp-4)",
  border: "1px solid var(--border)",
  background: "var(--muted)",
  color: "var(--ink)",
  borderRadius: "var(--radius-pill)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export interface TrayItem {
  id: string;
  title: string;
}

/** Minimized-window dock (§4.7 최소화). Each chip restores its window on activate.
 * `style` lets a host band (e.g. the shell bottom dock) flow it inline instead
 * of the default floating-pill placement. */
export function TrayDock({
  items,
  onRestore,
  style,
}: {
  items: TrayItem[];
  onRestore: (id: string) => void;
  style?: CSSProperties;
}) {
  if (items.length === 0) return null;
  return (
    <div className="console" role="group" aria-label={T.tray} style={{ ...trayDockStyle, ...style }}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-window-control=""
          aria-label={T.restoreItem(item.title)}
          title={T.restore}
          onClick={() => {
            onRestore(item.id);
          }}
          style={trayChipStyle}
        >
          {item.title}
        </button>
      ))}
    </div>
  );
}
