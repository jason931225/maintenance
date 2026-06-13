import { KeyRound } from "lucide-react";
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
 */
export function OnboardingPage() {
  const { api, logout, clearPasskeySetup } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleEnroll() {
    setError(undefined);
    setPending(true);
    try {
      const ceremony = await startPasskeyRegistration(api, {});
      await finishPasskeyRegistration(api, ceremony);
      clearPasskeySetup();
      void navigate("/dispatch", { replace: true });
    } catch {
      setError(ko.onboarding.enrollFailed);
    } finally {
      setPending(false);
    }
  }

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

          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              void handleEnroll();
            }}
          >
            <KeyRound aria-hidden="true" size={18} />
            {pending ? ko.onboarding.enrolling : ko.onboarding.enroll}
          </Button>

          <Button
            type="button"
            variant="ghost"
            className="justify-self-start"
            disabled={pending}
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
