import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import {
  FIRST_LOGIN_ACTIONS,
  type ConsentObjectViewModel,
  type ConsentPhase,
} from "./useFirstLoginFlow";

const T = ko.identity.onboarding.consent;

const legalSections = [
  { key: "purpose", title: T.purposeTitle, body: T.purpose },
  { key: "items", title: T.itemsTitle, body: T.items },
  { key: "retention", title: T.retentionTitle, body: T.retention },
  { key: "refusal", title: T.refusalTitle, body: T.refusal },
] as const;

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const legalGridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  margin: 0,
};

const buttonStyle: CSSProperties = {
  justifySelf: "start",
  minHeight: 34,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--signal)",
  background: "var(--signal)",
  color: "var(--ink)",
  padding: "0 var(--sp-5)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
};

const labelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-3)",
  padding: "var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
};

function consentStatusLabel(phase: ConsentPhase): { label: string; tone: Parameters<typeof StatusChip>[0]["tone"] } {
  if (phase === "accepted") return { label: T.status.accepted, tone: "ok" };
  if (phase === "loading") return { label: T.loading, tone: "info" };
  if (phase === "submitting") return { label: T.submitting, tone: "accent" };
  if (phase === "error_load") return { label: T.loadFailed, tone: "danger" };
  if (phase === "error_accept") return { label: T.acceptFailed, tone: "danger" };
  return { label: T.status.required, tone: "warn" };
}

export function ConsentObjectCard({
  consent,
  phase,
  privacyChecked,
  termsChecked,
  canSubmit,
  onPrivacyChange,
  onTermsChange,
  onSubmit,
  onRetry,
}: {
  consent: ConsentObjectViewModel;
  phase: ConsentPhase;
  privacyChecked: boolean;
  termsChecked: boolean;
  canSubmit: boolean;
  onPrivacyChange: (checked: boolean) => void;
  onTermsChange: (checked: boolean) => void;
  onSubmit: () => void;
  onRetry: () => void;
}) {
  const status = consentStatusLabel(phase);
  const locked = phase === "loading" || phase === "submitting";
  const showControls = phase !== "accepted" && phase !== "loading";
  const resource = { kind: consent.kind, id: consent.policy_version };

  return (
    <section aria-labelledby="first-login-consent-title" style={cardStyle}>
      <div style={rowStyle}>
        <h2 id="first-login-consent-title" style={titleStyle}>
          {T.title}
        </h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
          <StatusChip tone={status.tone} role={phase.startsWith("error") ? "alert" : "status"}>
            {status.label}
          </StatusChip>
          <StatusChip tone="info">{T.version(consent.policy_version)}</StatusChip>
          <StatusChip tone="accent">{consent.legal_basis}</StatusChip>
        </div>
      </div>

      <dl style={legalGridStyle}>
        {legalSections.map((section) => (
          <div key={section.key} style={{ display: "grid", gap: "var(--sp-1)" }}>
            <dt
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: "var(--fw-strong)",
                color: "var(--faint)",
              }}
            >
              {section.title}
            </dt>
            <dd
              style={{
                margin: 0,
                fontSize: "var(--text-sm)",
                fontWeight: "var(--fw-body)",
                lineHeight: "var(--lh-base)",
                color: "var(--ink)",
              }}
            >
              {section.body}
            </dd>
          </div>
        ))}
      </dl>

      {showControls ? (
        <PolicyGated action={FIRST_LOGIN_ACTIONS.consentAccept} resource={resource}>
          <div style={{ display: "grid", gap: "var(--sp-3)" }}>
            <label style={labelStyle}>
              <input
                type="checkbox"
                checked={privacyChecked}
                disabled={locked}
                onChange={(event) => {
                  onPrivacyChange(event.currentTarget.checked);
                }}
                style={{ accentColor: "var(--signal)" }}
              />
              <span>{consent.required_acknowledgements[0]?.label}</span>
            </label>
            <label style={labelStyle}>
              <input
                type="checkbox"
                checked={termsChecked}
                disabled={locked}
                onChange={(event) => {
                  onTermsChange(event.currentTarget.checked);
                }}
                style={{ accentColor: "var(--signal)" }}
              />
              <span>{consent.required_acknowledgements[1]?.label}</span>
            </label>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={onSubmit}
              style={{
                ...buttonStyle,
                opacity: canSubmit ? 1 : 0.48,
                cursor: canSubmit ? "pointer" : "not-allowed",
              }}
            >
              {phase === "submitting" ? T.submitting : T.submit}
            </button>
          </div>
        </PolicyGated>
      ) : null}

      {phase === "error_load" || phase === "error_accept" ? (
        <PolicyGated action={FIRST_LOGIN_ACTIONS.consentRetry} resource={resource}>
          <button type="button" onClick={onRetry} style={secondaryButtonStyle}>
            {T.retry}
          </button>
        </PolicyGated>
      ) : null}
    </section>
  );
}
