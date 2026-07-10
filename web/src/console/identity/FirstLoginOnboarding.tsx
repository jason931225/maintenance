import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGateProvider, PolicyGated, type PolicyGate } from "../policy";
import "../tokens.css";
import { ConsentObjectCard } from "./ConsentObjectCard";
import { FIRST_LOGIN_POLICY_GATE } from "./FirstLoginPolicy";
import { PasskeyEnrollmentPanel } from "./PasskeyEnrollmentPanel";
import {
  FIRST_LOGIN_ACTIONS,
  REQUIRED_PRIVACY_TERMS_VERSION,
  useFirstLoginFlow,
} from "./useFirstLoginFlow";

const T = ko.identity.onboarding;

const rootStyle: CSSProperties = {
  minHeight: "100dvh",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  display: "grid",
  placeItems: "center",
  padding: "var(--sp-6)",
};

const frameStyle: CSSProperties = {
  width: "min(720px, 100%)",
  display: "grid",
  gap: "var(--sp-5)",
};

const headerStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-6)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const h1Style: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-h1)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const secondaryButtonStyle: CSSProperties = {
  justifySelf: "start",
  minHeight: 34,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-5)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

function stepTone(active: boolean, complete: boolean) {
  if (complete) return "ok" as const;
  if (active) return "accent" as const;
  return "neutral" as const;
}

export function FirstLoginOnboarding({
  policyGate = FIRST_LOGIN_POLICY_GATE,
}: {
  policyGate?: PolicyGate;
}) {
  const flow = useFirstLoginFlow();
  const consentComplete = flow.consentAccepted;
  const passkeyActive = consentComplete;
  const complete = flow.platformStatus === "complete" || flow.phone.status === "approved";

  return (
    <PolicyGateProvider gate={policyGate}>
      <main className="console" data-console-root data-console-theme="light" style={rootStyle}>
        <div style={frameStyle}>
          <header style={headerStyle}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-3)" }}>
              <h1 style={h1Style}>{T.title}</h1>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
                <StatusChip tone={stepTone(!consentComplete, consentComplete)}>{T.step.consent}</StatusChip>
                <StatusChip tone={stepTone(passkeyActive, complete)}>{T.step.passkey}</StatusChip>
                <StatusChip tone={stepTone(false, complete)}>{T.step.complete}</StatusChip>
                <StatusChip tone="info">{REQUIRED_PRIVACY_TERMS_VERSION}</StatusChip>
              </div>
            </div>
          </header>

          {flow.consentAccepted ? (
            <PasskeyEnrollmentPanel
              platformStatus={flow.platformStatus}
              phone={flow.phone}
              busy={flow.platformStatus === "pending" || flow.phone.status === "generating"}
              onPlatformEnroll={() => {
                void flow.enrollPlatform();
              }}
              onPhoneEnroll={() => {
                void flow.startPhoneEnrollment();
              }}
            />
          ) : (
            <ConsentObjectCard
              consent={flow.consentObject}
              phase={flow.consentPhase}
              privacyChecked={flow.privacyChecked}
              termsChecked={flow.termsChecked}
              canSubmit={flow.canAcceptConsent}
              onPrivacyChange={flow.setPrivacyChecked}
              onTermsChange={flow.setTermsChecked}
              onSubmit={() => {
                void flow.acceptConsent();
              }}
              onRetry={() => {
                void flow.loadConsentStatus();
              }}
            />
          )}

          <PolicyGated action={FIRST_LOGIN_ACTIONS.signOut} resource={{ kind: "session", id: "self" }}>
            <button
              type="button"
              onClick={() => {
                void flow.signOut();
              }}
              style={secondaryButtonStyle}
            >
              {T.passkey.signOut}
            </button>
          </PolicyGated>
        </div>
      </main>
    </PolicyGateProvider>
  );
}
