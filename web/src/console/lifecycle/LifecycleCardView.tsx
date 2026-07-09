// Carbon-copy lifecycle card — presentational core (charter §3 P0.5, `lcOpen`).
//
// ONE card for every lifecycle-bearing object (§4-18: config, not per-screen
// forks). It renders purely from the real BE-LC payload + a `LifecycleChain`
// config: the 5-step stepper, the legal next transitions (each PolicyGated and
// firing the real mutation), the read-only version history, the retention /
// legal-hold panel, and the dispose gate that mirrors the server's fail-closed
// rule. In `asOf` mode it is a read-only lens with every CTA disabled.
//
// This component holds no data-fetching: the container (LifecycleCard) supplies
// the record and the mutation callbacks, so the fidelity harness and unit tests
// drive it deterministically with fixtures — same split as ComposerDemo.
//
// Honest BE-LC gaps (named, not faked — no decorative ribbons per charter §3):
//   • non-destructive rollback — the seeded FSM has no backward edge and the API
//     exposes none, so history is read-only (no rollback CTA).
//   • effective-dating on a transition — the transition contract is {toState,
//     reason} only; no effective-date field is rendered.
//   • maker-checker / SoD approval line + referential-integrity archive
//     checklist + linked-object provenance chips — no backend surface yet.
// All four are BE-LC follow-ups; this slice ships only what the server enforces.

import { type CSSProperties, useState } from "react";

import { TONE, type Tone } from "../composer/objectKinds";
import { PolicyGated } from "../policy";
import { ko } from "../../i18n/ko";
import {
  type LifecycleChain,
  type RenderedStep,
  allowedTransitions,
  computeStepper,
  DISPOSED_STATE,
  disposeBlock,
} from "./chain";
import type { Lifecycle } from "./types";

const t = ko.console.lifecycle;

export interface LifecycleCardViewProps {
  chain: LifecycleChain;
  record: Lifecycle;
  /** Object code / title shown in the header. */
  title?: string;
  /** `asOf` = read-only lens; every CTA disabled (AGENTS entry 36 `lcAsOf`). */
  mode?: "live" | "asOf";
  /** ISO date shown in the as-of banner chip. */
  asOfDate?: string;
  /** ISO `YYYY-MM-DD` used for the dispose retention gate; defaults to today. */
  today?: string;
  /** In-flight mutation — disables CTAs to prevent double-submit. */
  busy?: boolean;
  onTransition?: (toState: string, reason: string) => void;
  onSetHold?: (legalHold: boolean, retentionUntil?: string) => void;
}

const STATE_TONE: Record<string, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "info",
  active: "ok",
  revised: "accent",
  archived: "warn",
  disposed: "danger",
};

const STEP_TONE: Record<RenderedStep["status"], Tone> = {
  done: "ok",
  current: "accent",
  pending: "neutral",
};

const STATE_LABELS = t.state as Record<string, string>;
const STAGE_LABELS = t.stage as Record<string, string>;

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function chipStyle(tone: Tone): CSSProperties {
  const c = TONE(tone);
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--sp-1)",
    padding: "var(--sp-1) var(--sp-3)",
    borderRadius: "var(--radius-chip)",
    border: `1px solid ${c.bd}`,
    background: c.bg,
    color: c.tx,
    fontSize: "var(--text-micro)",
    fontWeight: "var(--fw-medium)",
    whiteSpace: "nowrap",
  };
}

export function LifecycleCardView({
  chain,
  record,
  title,
  mode = "live",
  asOfDate,
  today = new Date().toISOString().slice(0, 10),
  busy = false,
  onTransition,
  onSetHold,
}: LifecycleCardViewProps) {
  const readOnly = mode === "asOf";
  const steps = computeStepper(chain, record.currentState);
  const nexts = allowedTransitions(chain, record.currentState);
  const block = disposeBlock(record, today);

  const [reason, setReason] = useState("");
  const [legalHold, setLegalHold] = useState(record.legalHold);
  const [retentionUntil, setRetentionUntil] = useState(record.retentionUntil ?? "");

  const canSubmit = reason.trim().length > 0 && !busy && !readOnly;

  return (
    <section
      className="console"
      data-lifecycle-card
      data-lifecycle-state={record.currentState}
      data-lifecycle-mode={mode}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-5)",
        maxWidth: 640,
        padding: "var(--sp-6)",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
        {title ? (
          <span style={{ fontSize: "var(--text-card-title)", fontWeight: "var(--fw-strong)" }}>
            {title}
          </span>
        ) : null}
        <span data-fidelity="lifecycle-current" style={chipStyle(STATE_TONE[record.currentState] ?? "neutral")}>
          {stateLabel(record.currentState)}
        </span>
        {readOnly ? (
          <span data-fidelity="lifecycle-asof" style={chipStyle("info")}>
            {t.asOf.chip.replace("{date}", asOfDate ?? today)}
          </span>
        ) : null}
      </header>

      {/* Stepper — 5 stages, current derived from real state. */}
      <ol
        data-fidelity="lifecycle-stepper"
        aria-label={t.stepperLabel}
        style={{ display: "flex", gap: "var(--sp-2)", listStyle: "none", margin: 0, padding: 0, flexWrap: "wrap" }}
      >
        {steps.map((s) => (
          <li key={s.key} data-step={s.key} data-step-status={s.status} style={chipStyle(STEP_TONE[s.status])}>
            {STAGE_LABELS[s.labelKey] ?? s.labelKey}
          </li>
        ))}
      </ol>

      {/* Transitions — PolicyGated; each fires the real transition mutation. */}
      {nexts.length > 0 ? (
        <PolicyGated action="lifecycle.transition" resource={record.objectType}>
          <div data-fidelity="lifecycle-transitions" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
              <span style={{ fontSize: "var(--text-micro)", color: "var(--steel)", letterSpacing: "var(--tracking-label)" }}>
                {t.reasonLabel}
              </span>
              <input
                type="text"
                value={reason}
                disabled={readOnly || busy}
                placeholder={t.reasonPlaceholder}
                onChange={(e) => {
                  setReason(e.target.value);
                }}
                style={{
                  padding: "var(--sp-2) var(--sp-3)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--canvas)",
                  color: "var(--ink)",
                  fontSize: "var(--text-body)",
                }}
              />
            </label>
            <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", alignItems: "center" }}>
              {nexts.map((to) => {
                const disposeGated = to === DISPOSED_STATE && block !== null;
                return (
                  <span key={to} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
                    <button
                      type="button"
                      data-transition-to={to}
                      disabled={!canSubmit || disposeGated}
                      aria-disabled={!canSubmit || disposeGated}
                      onClick={() => {
                        if (!canSubmit || disposeGated) return;
                        onTransition?.(to, reason.trim());
                        setReason("");
                      }}
                      style={{
                        padding: "var(--sp-2) var(--sp-4)",
                        borderRadius: "var(--radius)",
                        border: "1px solid var(--border)",
                        background: !canSubmit || disposeGated ? "var(--muted)" : "var(--signal)",
                        color: !canSubmit || disposeGated ? "var(--steel)" : "#141a21",
                        fontSize: "var(--text-body)",
                        fontWeight: "var(--fw-medium)",
                        cursor: !canSubmit || disposeGated ? "not-allowed" : "pointer",
                      }}
                    >
                      {stateLabel(to)}
                    </button>
                    {disposeGated ? (
                      <span data-fidelity="lifecycle-dispose-block" data-block={block} style={chipStyle("danger")}>
                        {t.disposeBlocked[block]}
                      </span>
                    ) : null}
                  </span>
                );
              })}
            </div>
          </div>
        </PolicyGated>
      ) : null}

      {/* Retention / legal-hold — PolicyGated; drives the real hold mutation and
          the server's dispose gate. */}
      <PolicyGated action="lifecycle.hold" resource={record.objectType}>
        <div
          data-fidelity="lifecycle-hold"
          style={{ display: "flex", gap: "var(--sp-4)", alignItems: "flex-end", flexWrap: "wrap" }}
        >
          <label style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-body)" }}>
            <input
              type="checkbox"
              checked={legalHold}
              disabled={readOnly || busy}
              onChange={(e) => {
                setLegalHold(e.target.checked);
              }}
            />
            {t.hold.legalHold}
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
            <span style={{ fontSize: "var(--text-micro)", color: "var(--steel)", letterSpacing: "var(--tracking-label)" }}>
              {t.hold.retentionUntil}
            </span>
            <input
              type="date"
              value={retentionUntil}
              disabled={readOnly || busy}
              onChange={(e) => {
                setRetentionUntil(e.target.value);
              }}
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--canvas)",
                color: "var(--ink)",
                fontSize: "var(--text-body)",
              }}
            />
          </label>
          <button
            type="button"
            data-hold-apply
            disabled={readOnly || busy}
            onClick={() => {
              if (readOnly || busy) return;
              onSetHold?.(legalHold, retentionUntil || undefined);
            }}
            style={{
              padding: "var(--sp-2) var(--sp-4)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--ink)",
              fontSize: "var(--text-body)",
              cursor: readOnly || busy ? "not-allowed" : "pointer",
            }}
          >
            {t.hold.apply}
          </button>
        </div>
      </PolicyGated>

      {/* Version history — read-only from the real transition log (newest first). */}
      <div data-fidelity="lifecycle-history" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <span style={{ fontSize: "var(--text-micro)", color: "var(--steel)", letterSpacing: "var(--tracking-label)" }}>
          {t.history.label}
        </span>
        {record.transitions.length === 0 ? (
          <span style={{ color: "var(--faint)", fontSize: "var(--text-sm)" }}>{t.history.empty}</span>
        ) : (
          <ol style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", listStyle: "none", margin: 0, padding: 0 }}>
            {record.transitions.map((tr, i) => (
              <li
                key={`${tr.occurredAt}-${String(i)}`}
                data-history-row
                style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", fontSize: "var(--text-sm)" }}
              >
                <span style={chipStyle(STATE_TONE[tr.fromState] ?? "neutral")}>{stateLabel(tr.fromState)}</span>
                <span aria-hidden style={{ color: "var(--faint)" }}>→</span>
                <span style={chipStyle(STATE_TONE[tr.toState] ?? "neutral")}>{stateLabel(tr.toState)}</span>
                <span style={{ color: "var(--steel)" }}>{tr.reason}</span>
                <time dateTime={tr.occurredAt} style={{ marginLeft: "auto", color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
                  {tr.occurredAt.slice(0, 10)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
