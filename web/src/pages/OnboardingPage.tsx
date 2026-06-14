import { Monitor, QrCode, Smartphone } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
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
 * The user picks where the passkey lives: this desktop (platform authenticator),
 * a phone (cross-platform), or desktop linked to a phone via the browser's QR /
 * hybrid flow (also cross-platform). All three create a discoverable passkey.
 */
export function OnboardingPage() {
  const { api, logout, clearPasskeySetup } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState<AuthenticatorAttachment | "qr" | null>(
    null,
  );
  const [error, setError] = useState<string | undefined>(undefined);

  async function enroll(
    key: AuthenticatorAttachment | "qr",
    attachment: AuthenticatorAttachment,
  ) {
    setError(undefined);
    setPending(key);
    try {
      const ceremony = await startPasskeyRegistration(api, {}, attachment);
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
      setPending(null);
    }
  }

  const busy = pending !== null;
  const methods: {
    key: AuthenticatorAttachment | "qr";
    attachment: AuthenticatorAttachment;
    icon: typeof Monitor;
    title: string;
    description: string;
  }[] = [
    {
      key: "platform",
      attachment: "platform",
      icon: Monitor,
      title: ko.onboarding.methods.desktop.title,
      description: ko.onboarding.methods.desktop.description,
    },
    {
      key: "cross-platform",
      attachment: "cross-platform",
      icon: Smartphone,
      title: ko.onboarding.methods.mobile.title,
      description: ko.onboarding.methods.mobile.description,
    },
    {
      key: "qr",
      attachment: "cross-platform",
      icon: QrCode,
      title: ko.onboarding.methods.qr.title,
      description: ko.onboarding.methods.qr.description,
    },
  ];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="grid w-full max-w-md gap-6">
        <Card className="grid gap-5 p-6">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold text-slate-950">
              {ko.onboarding.title}
            </h1>
            <p className="text-sm text-slate-600">{ko.onboarding.subtitle}</p>
          </div>

          <div className="grid gap-3">
            {methods.map((method) => {
              const Icon = method.icon;
              const active = pending === method.key;
              return (
                <button
                  key={method.key}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void enroll(method.key, method.attachment);
                  }}
                  className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 text-left transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Icon
                    aria-hidden="true"
                    size={22}
                    className="mt-0.5 shrink-0 text-slate-700"
                  />
                  <span className="grid gap-0.5">
                    <span className="text-sm font-semibold text-slate-950">
                      {active ? ko.onboarding.enrolling : method.title}
                    </span>
                    <span className="text-sm text-slate-600">
                      {active
                        ? ko.onboarding.enrollingHint
                        : method.description}
                    </span>
                  </span>
                </button>
              );
            })}
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
