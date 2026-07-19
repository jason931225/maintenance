import type { CSSProperties } from "react";

import { ko } from "../../../i18n/ko";
import { StatusChip } from "../../components";
import "../../tokens.css";

const P = ko.page;
const X = ko.console.explore;

export interface WorkspaceStat {
  key: string;
  label: string;
  value: number;
  /** Accessible name for the drill button, e.g. "타입 12개로 이동". */
  drillAria: string;
}

const stripStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const statStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  minWidth: 120,
  minHeight: 44, // WCAG AA target
  padding: "var(--sp-3) var(--sp-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  textAlign: "left",
  cursor: "pointer",
};

const statLabelStyle: CSSProperties = {
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const statValueStyle: CSSProperties = {
  color: "var(--ink)",
  fontSize: "var(--text-value-lg)",
  fontWeight: "var(--fw-strong)",
  fontVariantNumeric: "tabular-nums",
};

const stateWrapStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  justifyItems: "start",
  padding: "var(--sp-6)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const bannerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
  padding: "var(--sp-3) var(--sp-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--danger-bd)",
  background: "var(--danger-bg)",
};

/**
 * Drillable stat strip (§4-11: every stat drills, no dead KPI tile). Each stat
 * is a button; the host wires `onDrill` to a real jump (tab switch / graph
 * focus) — there are no inert numbers here.
 */
export function StatStrip({
  stats,
  onDrill,
  ariaLabel,
}: {
  stats: WorkspaceStat[];
  onDrill: (key: string) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} style={stripStyle}>
      {stats.map((stat) => (
        <button
          key={stat.key}
          type="button"
          aria-label={stat.drillAria}
          onClick={() => {
            onDrill(stat.key);
          }}
          style={statStyle}
        >
          <span style={statLabelStyle}>{stat.label}</span>
          <span style={statValueStyle}>{stat.value.toLocaleString("ko-KR")}</span>
        </button>
      ))}
    </div>
  );
}

/** Console-native loading state (no legacy Skeleton import — purity). */
export function WorkspaceLoading() {
  return (
    <div role="status" aria-busy="true" style={stateWrapStyle}>
      <StatusChip tone="neutral">{P.loading}</StatusChip>
    </div>
  );
}

/** Read-failure state with a retry jump. */
export function WorkspaceError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" style={stateWrapStyle}>
      <StatusChip tone="danger">{P.loadFailed}</StatusChip>
      <button type="button" onClick={onRetry} style={buttonStyle}>
        {P.retry}
      </button>
    </div>
  );
}

/** Non-blocking supplementary-read failure; successful workspace data stays visible. */
export function WorkspacePartialFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" style={bannerStyle}>
      <StatusChip tone="danger">{message}</StatusChip>
      <button type="button" onClick={onRetry} style={buttonStyle}>
        {P.retry}
      </button>
    </div>
  );
}

/** Successful read, empty registry — honest empty, not an error. */
export function WorkspaceEmpty() {
  return (
    <div style={stateWrapStyle}>
      <StatusChip tone="neutral">{X.labels.empty}</StatusChip>
    </div>
  );
}

/** Dismissible mutation-failure banner (create/stage rejection). */
export function FeedbackBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" style={bannerStyle}>
      <StatusChip tone="danger">{message}</StatusChip>
      <button type="button" onClick={onDismiss} style={buttonStyle} aria-label={P.dismiss}>
        {P.dismiss}
      </button>
    </div>
  );
}
