import { Monitor, QrCode } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { EnrollHandoffQr } from "../features/auth/EnrollHandoffQr";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import {
  finishPasskeyRegistration,
  startPasskeyRegistration,
} from "../auth/webauthn";

/**
 * Initial-settings passkey enrollment shown after a first OTP sign-in. While the
 * session carries requires_passkey_setup the shell routes here; enrolling a
 * passkey clears the flag so the next sign-in can use the passkey button.
 *
 * Exactly two reliable paths (the unreliable browser-native cross-device hybrid /
 * QR was removed — the phone's biometric completed but the result never relayed
 * back to the desktop, hanging the ceremony):
 *   1. This device — a platform authenticator (Touch ID / Windows Hello). Fast
 *      and reliable.
 *   2. Phone via QR — an app-level handoff: mint a single-use code, show a QR of
 *      its enroll URL, the user scans it on their phone and enrolls a platform
 *      passkey there. Works with NO Bluetooth.
 */
export function OnboardingPage() {
  const { api, logout, clearPasskeySetup } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function enrollThisDevice() {
    setError(undefined);
    setShowQr(false);
    setPending(true);
    try {
      const ceremony = await startPasskeyRegistration(api, {}, "platform");
      await finishPasskeyRegistration(api, ceremony);
      clearPasskeySetup();
      void navigate("/dispatch", { replace: true });
    } catch (cause) {
      const cancelled =
        cause instanceof DOMException &&
        (cause.name === "NotAllowedError" || cause.name === "AbortError");
      setError(
        cancelled ? ko.onboarding.enrollCancelled : ko.onboarding.enrollFailed,
      );
    } finally {
      setPending(false);
    }
  }

  const busy = pending;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted-panel px-4 py-12">
      <div className="grid w-full max-w-md gap-6">
        <Card className="grid gap-5 p-6">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold text-ink">
              {ko.onboarding.title}
            </h1>
            <p className="text-sm text-steel">{ko.onboarding.subtitle}</p>
          </div>

          <div className="grid gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void enrollThisDevice();
              }}
              className="flex items-start gap-3 rounded-lg border border-line bg-white p-4 text-left transition hover:border-steel hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Monitor
                aria-hidden="true"
                size={22}
                className="mt-0.5 shrink-0 text-steel"
              />
              <span className="grid gap-0.5">
                <span className="text-sm font-semibold text-ink">
                  {pending
                    ? ko.onboarding.enrolling
                    : ko.onboarding.methods.desktop.title}
                </span>
                <span className="text-sm text-steel">
                  {pending
                    ? ko.onboarding.enrollingHint
                    : ko.onboarding.methods.desktop.description}
                </span>
              </span>
            </button>

            <button
              type="button"
              disabled={busy}
              aria-expanded={showQr}
              onClick={() => {
                setError(undefined);
                setShowQr((open) => !open);
              }}
              className="flex items-start gap-3 rounded-lg border border-line bg-white p-4 text-left transition hover:border-steel hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              <QrCode
                aria-hidden="true"
                size={22}
                className="mt-0.5 shrink-0 text-steel"
              />
              <span className="grid gap-0.5">
                <span className="text-sm font-semibold text-ink">
                  {ko.onboarding.methods.phoneQr.title}
                </span>
                <span className="text-sm text-steel">
                  {ko.onboarding.methods.phoneQr.description}
                </span>
              </span>
            </button>

            {showQr ? (
              <div className="rounded-lg border border-line bg-muted-panel p-4">
                <EnrollHandoffQr requireStepUp={false} />
              </div>
            ) : null}
          </div>

          <Button
            type="button"
            variant="ghost"
            className="justify-self-start"
            disabled={busy}
            onClick={() => {
              void logout();
            }}
          >
            {ko.onboarding.signOut}
          </Button>

          {error ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
