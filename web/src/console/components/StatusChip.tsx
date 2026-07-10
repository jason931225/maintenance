import type { ReactNode } from "react";

type StatusChipTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "purple";

export function StatusChip({
  children,
  tone = "neutral",
  role,
  ariaLabel,
}: {
  children: ReactNode;
  tone?: StatusChipTone;
  role?: "status" | "alert";
  ariaLabel?: string;
}) {
  const toneVars = {
    neutral: ["var(--muted)", "var(--border)", "var(--steel)"],
    ok: ["var(--ok-bg)", "var(--ok-bd)", "var(--ok-tx)"],
    warn: ["var(--warn-bg)", "var(--warn-bd)", "var(--warn-tx)"],
    danger: ["var(--danger-bg)", "var(--danger-bd)", "var(--danger-tx)"],
    info: ["var(--info-bg)", "var(--info-bd)", "var(--info-tx)"],
    accent: ["var(--accent-bg)", "var(--accent-bd)", "var(--accent-tx)"],
    purple: ["var(--purple-bg)", "var(--purple-bd)", "var(--purple-tx)"],
  }[tone];

  return (
    <span
      role={role}
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        width: "fit-content",
        minHeight: 22,
        padding: "0 var(--sp-2)",
        borderRadius: "var(--radius-chip)",
        border: `1px solid ${toneVars[1]}`,
        background: toneVars[0],
        color: toneVars[2],
        fontSize: "var(--text-xs)",
        fontWeight: "var(--fw-strong)",
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
