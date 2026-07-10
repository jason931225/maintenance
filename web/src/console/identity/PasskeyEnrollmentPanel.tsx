import { QRCodeCanvas } from "qrcode.react";
import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import {
  FIRST_LOGIN_ACTIONS,
  REQUIRED_PRIVACY_TERMS_VERSION,
  type PhoneEnrollmentState,
  type PlatformEnrollmentStatus,
} from "./useFirstLoginFlow";

const T = ko.identity.onboarding.passkey;
const H = ko.identity.enrollHandoff;

const panelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const methodButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
  minHeight: 44,
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
  textAlign: "left",
};

const qrShellStyle: CSSProperties = {
  display: "grid",
  justifyItems: "center",
  gap: "var(--sp-3)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
};

function platformChip(status: PlatformEnrollmentStatus) {
  if (status === "pending") return <StatusChip tone="accent" role="status">{T.platform.pending}</StatusChip>;
  if (status === "cancelled") return <StatusChip tone="warn" role="alert">{T.platform.cancelled}</StatusChip>;
  if (status === "failed") return <StatusChip tone="danger" role="alert">{T.platform.failed}</StatusChip>;
  if (status === "complete") return <StatusChip tone="ok" role="status">{T.complete}</StatusChip>;
  return <StatusChip tone="neutral">{T.step}</StatusChip>;
}

function phoneChip(phone: PhoneEnrollmentState) {
  if (phone.status === "generating") return <StatusChip tone="accent" role="status">{H.generating}</StatusChip>;
  if (phone.status === "ready" || phone.status === "waiting") return <StatusChip tone="info" role="status">{H.waiting}</StatusChip>;
  if (phone.status === "expired") return <StatusChip tone="warn" role="alert">{H.expired}</StatusChip>;
  if (phone.status === "error") return <StatusChip tone="danger" role="alert">{H.failed}</StatusChip>;
  if (phone.status === "approved") return <StatusChip tone="ok" role="status">{H.completed}</StatusChip>;
  return <StatusChip tone="neutral">{T.step}</StatusChip>;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export function PasskeyEnrollmentPanel({
  platformStatus,
  phone,
  busy,
  onPlatformEnroll,
  onPhoneEnroll,
}: {
  platformStatus: PlatformEnrollmentStatus;
  phone: PhoneEnrollmentState;
  busy: boolean;
  onPlatformEnroll: () => void;
  onPhoneEnroll: () => void;
}) {
  const methods = [
    {
      key: "platform",
      action: FIRST_LOGIN_ACTIONS.enrollPlatform,
      title: T.platform.title,
      button: T.platform.action,
      onClick: onPlatformEnroll,
      chip: platformChip(platformStatus),
      disabled: busy || platformStatus === "pending",
    },
    {
      key: "phone",
      action: FIRST_LOGIN_ACTIONS.enrollPhone,
      title: T.phone.title,
      button: phone.status === "expired" || phone.status === "error" ? H.regenerate : T.phone.open,
      onClick: onPhoneEnroll,
      chip: phoneChip(phone),
      disabled: busy || phone.status === "generating",
    },
  ] as const;

  return (
    <section aria-labelledby="first-login-passkey-title" style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-3)" }}>
        <h2 id="first-login-passkey-title" style={titleStyle}>{T.title}</h2>
        <StatusChip tone="info">{REQUIRED_PRIVACY_TERMS_VERSION}</StatusChip>
      </div>

      <div style={{ display: "grid", gap: "var(--sp-3)" }}>
        {methods.map((method) => (
          <PolicyGated key={method.key} action={method.action} resource={{ kind: "passkey", id: method.key }}>
            <button
              type="button"
              disabled={method.disabled}
              aria-label={method.button}
              onClick={method.onClick}
              style={{
                ...methodButtonStyle,
                opacity: method.disabled ? 0.54 : 1,
                cursor: method.disabled ? "not-allowed" : "pointer",
              }}
            >
              <span>{method.title}</span>
              {method.chip}
            </button>
          </PolicyGated>
        ))}
      </div>

      {phone.status === "ready" || phone.status === "waiting" ? (
        <div style={qrShellStyle}>
          <StatusChip tone="info" role="status">{H.instruction}</StatusChip>
          <div style={{ padding: "var(--sp-4)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface)" }}>
            <QRCodeCanvas
              value={phone.handoff.url}
              size={196}
              marginSize={2}
              level="M"
              title={H.qrAlt}
            />
          </div>
          <PolicyGated action={FIRST_LOGIN_ACTIONS.enrollPhoneLink} resource={{ kind: "passkey", id: "phone" }}>
            <a
              href={phone.handoff.url}
              rel="noreferrer"
              style={{
                maxWidth: "100%",
                overflowWrap: "anywhere",
                color: "var(--teal)",
                fontSize: "var(--text-sm)",
                fontWeight: "var(--fw-medium)",
              }}
            >
              {H.linkLabel}
            </a>
          </PolicyGated>
          <div style={{ display: "grid", justifyItems: "center", gap: "var(--sp-1)", padding: "var(--sp-3)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface)" }}>
            <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--fw-strong)", color: "var(--faint)" }}>{H.otpLabel}</span>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-value-lg)", fontWeight: "var(--fw-strong)", color: "var(--ink)" }}>{phone.handoff.otp}</code>
            <StatusChip tone="warn">{H.otpHelp}</StatusChip>
          </div>
          <StatusChip tone="neutral">{H.expiresHint(formatTimestamp(phone.handoff.expiresAt))}</StatusChip>
        </div>
      ) : null}
    </section>
  );
}
