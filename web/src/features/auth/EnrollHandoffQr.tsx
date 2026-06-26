import { QRCodeCanvas } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { issueEnrollHandoff } from "../../auth/webauthn";

interface EnrollHandoffQrProps {
  /**
   * Require a step-up assertion before minting the handoff. True when the user is
   * already enrolled (adding a device from the security panel); false for the
   * mid-onboarding first enrollment, where there is no existing passkey to assert.
   */
  requireStepUp: boolean;
}

type HandoffState =
  | { status: "loading" }
  | { status: "ready"; url: string; otp: string; expiresAt: string }
  | { status: "error" };

/**
 * Cross-device passkey-enrollment QR. Mints a single-use, short-lived enrollment
 * handoff for the authenticated user and renders the returned enroll_url as a QR
 * the user scans on their phone. The phone opens the URL, redeems the handoff via
 * the first-sign-in flow, and enrolls a platform passkey there — no Bluetooth or
 * browser-native hybrid tunnel.
 *
 * The minted code is a bearer secret, so it is only rendered as a QR + a fallback
 * link to open on the phone; it is never persisted or logged client-side.
 */
export function EnrollHandoffQr({ requireStepUp }: EnrollHandoffQrProps) {
  const { api } = useAuth();
  const [state, setState] = useState<HandoffState>({ status: "loading" });

  const mint = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const handoff = await issueEnrollHandoff(api, requireStepUp);
      setState({
        status: "ready",
        url: handoff.enroll_url,
        otp: handoff.otp,
        expiresAt: handoff.expires_at,
      });
    } catch {
      setState({ status: "error" });
    }
  }, [api, requireStepUp]);

  useEffect(() => {
    // Defer the first mint a microtask past the effect body so the synchronous
    // `setState({ status: "loading" })` does not run inside the effect (the
    // codebase's mount-fetch convention; see SecurityPanel.load).
    void Promise.resolve().then(mint);
  }, [mint]);

  if (state.status === "loading") {
    return (
      <p role="status" className="text-sm font-medium text-steel">
        {ko.enrollHandoff.generating}
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="grid gap-3">
        <p role="alert" className="text-sm font-medium text-red-700">
          {ko.enrollHandoff.failed}
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="justify-self-start"
          onClick={() => {
            void mint();
          }}
        >
          {ko.enrollHandoff.regenerate}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid justify-items-center gap-3 text-center">
      <p className="text-sm font-semibold text-ink">
        {ko.enrollHandoff.instruction}
      </p>
      <p className="text-sm text-steel">{ko.enrollHandoff.description}</p>
      <div className="rounded-lg border border-line bg-white p-4">
        <QRCodeCanvas
          value={state.url}
          size={200}
          marginSize={2}
          level="M"
          title={ko.enrollHandoff.qrAlt}
        />
      </div>
      <a
        href={state.url}
        rel="noreferrer"
        className="break-all text-sm font-medium text-brand-teal underline underline-offset-2"
      >
        {ko.enrollHandoff.linkLabel}
      </a>
      <div className="grid gap-1 rounded-md border border-line bg-muted-panel px-4 py-3">
        <span className="text-xs font-semibold text-steel">
          {ko.enrollHandoff.otpLabel}
        </span>
        <code className="font-mono text-lg font-bold tracking-wider text-ink">
          {state.otp}
        </code>
        <span className="text-xs text-steel">{ko.enrollHandoff.otpHelp}</span>
      </div>
      <p className="text-xs text-steel">
        {ko.enrollHandoff.expiresHint}{" "}
        {formatTimestamp(state.expiresAt)}
      </p>
    </div>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
