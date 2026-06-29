import { QRCodeCanvas } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { issueEnrollHandoff, pollDeviceLogin } from "../../auth/webauthn";

interface EnrollHandoffQrProps {
  /**
   * Require a step-up assertion before minting the handoff. True when the user is
   * already enrolled (adding a device from the security panel); false for the
   * mid-onboarding first enrollment, where there is no existing passkey to assert.
   */
  requireStepUp: boolean;
  /** Deprecated compatibility prop: the desktop now observes the paired
   * device-login handoff, not a credential-count poll.
   */
  initialPasskeyCount?: number;
  /** Called once the desktop receives its approved token from the phone handoff. */
  onCompleted?: (accessToken?: string) => void;
}

type HandoffState =
  | { status: "loading" }
  | {
      status: "ready";
      url: string;
      otp: string;
      expiresAt: string;
      pollToken: string;
    }
  | { status: "expired" }
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
const COMPLETION_POLL_MS = 2_500;

export function EnrollHandoffQr({
  requireStepUp,
  onCompleted,
}: EnrollHandoffQrProps) {
  const { api } = useAuth();
  const [state, setState] = useState<HandoffState>({ status: "loading" });
  const [completed, setCompleted] = useState(false);
  const completedRef = useRef(false);

  const mint = useCallback(async () => {
    setState({ status: "loading" });
    setCompleted(false);
    completedRef.current = false;
    try {
      const handoff = await issueEnrollHandoff(api, requireStepUp);
      setState({
        status: "ready",
        url: handoff.enroll_url,
        otp: handoff.otp,
        expiresAt: handoff.expires_at,
        pollToken: handoff.poll_token,
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

  useEffect(() => {
    if (state.status !== "ready" || completed) return;
    let cancelled = false;
    const pollToken = state.pollToken;

    async function pollCompletion() {
      const result = await pollDeviceLogin(api, pollToken).catch(() => undefined);
      if (cancelled || !result) return;
      if (result.status === "expired") {
        setState({ status: "expired" });
        return;
      }
      if (result.status !== "approved" || !result.access_token) return;
      if (completedRef.current) return;

      completedRef.current = true;
      setCompleted(true);
      onCompleted?.(result.access_token);
    }

    void pollCompletion();
    const timer = window.setInterval(() => {
      void pollCompletion();
    }, COMPLETION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, completed, onCompleted, state]);

  if (state.status === "loading") {
    return (
      <p role="status" className="text-sm font-medium text-steel">
        {ko.enrollHandoff.generating}
      </p>
    );
  }

  if (state.status === "error" || state.status === "expired") {
    return (
      <div className="grid gap-3">
        <p role="alert" className="text-sm font-medium text-red-700">
          {state.status === "expired"
            ? ko.enrollHandoff.expired
            : ko.enrollHandoff.failed}
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
      <p
        role="status"
        aria-live="polite"
        className={
          completed
            ? "text-sm font-medium text-brand-teal"
            : "text-sm text-steel"
        }
      >
        {completed ? ko.enrollHandoff.completed : ko.enrollHandoff.waiting}
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
