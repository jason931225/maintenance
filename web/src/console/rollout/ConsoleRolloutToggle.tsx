import { useMemo, useState, type CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import "../tokens.css";
import { CONSOLE_ROLLOUT_ACTIONS } from "./actions";

const T = ko.console.rollout;

export interface ConsoleRolloutStatus {
  orgEnabled: boolean;
  killSwitchActive?: boolean;
  rolloutPercent?: number;
  telemetryHealthy?: boolean;
}

export interface ConsoleRolloutToggleProps {
  enabled?: boolean;
  defaultEnabled?: boolean;
  disabled?: boolean;
  status: ConsoleRolloutStatus;
  onToggle?: (enabled: boolean) => void | Promise<void>;
}

type RolloutChip = {
  key: string;
  tone: NonNullable<Parameters<typeof StatusChip>[0]["tone"]>;
  label: string;
  role?: "status" | "alert";
};

const shellStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
  padding: "var(--sp-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const toggleStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  minHeight: 30,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-pill)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const trackStyle: CSSProperties = {
  position: "relative",
  width: 34,
  height: 18,
  borderRadius: "var(--radius-pill)",
  border: "1px solid var(--border)",
  background: "var(--muted)",
  transition: "background 120ms ease, border-color 120ms ease",
};

function knobStyle(enabled: boolean): CSSProperties {
  return {
    position: "absolute",
    top: 2,
    left: enabled ? 18 : 2,
    width: 12,
    height: 12,
    borderRadius: "var(--radius-pill)",
    background: enabled ? "var(--signal)" : "var(--steel)",
    transition: "left 120ms ease, background 120ms ease",
  };
}

function resolveEffectiveConsole(enabled: boolean, status: ConsoleRolloutStatus): boolean {
  return enabled && status.orgEnabled && status.killSwitchActive !== true;
}

function rolloutChips(enabled: boolean, status: ConsoleRolloutStatus): RolloutChip[] {
  const effectiveConsole = resolveEffectiveConsole(enabled, status);
  const chips: Array<RolloutChip | undefined> = [
    {
      key: "surface",
      tone: effectiveConsole ? ("ok" as const) : ("neutral" as const),
      label: effectiveConsole ? T.status.console : T.status.legacy,
      role: "status" as const,
    },
    {
      key: "org",
      tone: status.orgEnabled ? ("info" as const) : ("warn" as const),
      label: status.orgEnabled ? T.status.orgOn : T.status.orgOff,
    },
    status.killSwitchActive
      ? {
          key: "kill-switch",
          tone: "danger" as const,
          label: T.status.killSwitch,
          role: "alert" as const,
        }
      : undefined,
    typeof status.rolloutPercent === "number"
      ? {
          key: "ramp",
          tone: "accent" as const,
          label: T.status.ramp(status.rolloutPercent),
        }
      : undefined,
    status.telemetryHealthy === undefined
      ? undefined
      : {
          key: "telemetry",
          tone: status.telemetryHealthy ? ("ok" as const) : ("warn" as const),
          label: status.telemetryHealthy ? T.status.telemetryOk : T.status.telemetryWatch,
        },
  ];
  return chips.filter((chip): chip is RolloutChip => chip !== undefined);
}

export function ConsoleRolloutToggle({
  enabled,
  defaultEnabled = false,
  disabled = false,
  status,
  onToggle,
}: ConsoleRolloutToggleProps) {
  const [internalOptedIn, setInternalOptedIn] = useState(defaultEnabled);
  const optedIn = enabled ?? internalOptedIn;
  const isControlled = enabled !== undefined;

  const effectiveConsole = resolveEffectiveConsole(optedIn, status);
  const chips = useMemo(() => rolloutChips(optedIn, status), [optedIn, status]);

  function handleToggle() {
    if (disabled) return;
    const previous = optedIn;
    const next = !optedIn;
    if (!isControlled) setInternalOptedIn(next);
    void Promise.resolve(onToggle?.(next)).catch(() => {
      if (!isControlled) {
        setInternalOptedIn((current) => (current === next ? previous : current));
      }
    });
  }

  return (
    <div className="console" data-console-rollout style={shellStyle}>
      <PolicyGated action={CONSOLE_ROLLOUT_ACTIONS.toggleOptIn} resource={{ kind: "console_rollout", id: "self" }}>
        <button
          type="button"
          role="switch"
          aria-checked={effectiveConsole}
          aria-label={T.toggle}
          disabled={disabled}
          onClick={handleToggle}
          style={{
            ...toggleStyle,
            borderColor: effectiveConsole ? "var(--signal)" : "var(--border)",
            cursor: disabled ? "wait" : "pointer",
            opacity: disabled ? 0.72 : 1,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              ...trackStyle,
              borderColor: effectiveConsole ? "var(--signal)" : "var(--border)",
              background: effectiveConsole ? "var(--accent-bg)" : "var(--muted)",
            }}
          >
            <span style={knobStyle(effectiveConsole)} />
          </span>
          <span>{T.toggle}</span>
        </button>
      </PolicyGated>
      {chips.map((chip) => (
        <StatusChip key={chip.key} tone={chip.tone} role={chip.role}>
          {chip.label}
        </StatusChip>
      ))}
    </div>
  );
}
