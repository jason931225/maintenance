import { KeyRound, Ticket } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { OtpRedeemError, redeemOtp } from "../auth/webauthn";

/** Same-origin relative paths only; reject protocol-relative (//evil) and absolute URLs. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dispatch";
}

export function LoginPage() {
  const { session, login, acceptTokens, api } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [otpOpen, setOtpOpen] = useState(false);
  const [otp, setOtp] = useState("");
  const [otpPending, setOtpPending] = useState(false);

  useEffect(() => {
    if (session && !session.requires_passkey_setup) {
      void navigate(safeNext(searchParams.get("next")), { replace: true });
    }
  }, [session, navigate, searchParams]);

  async function handlePasskeyLogin() {
    setError(undefined);
    setPending(true);
    try {
      await login();
    } catch (cause) {
      // A user cancelling the native picker rejects with an AbortError/NotAllowedError.
      const aborted =
        cause instanceof DOMException &&
        (cause.name === "NotAllowedError" || cause.name === "AbortError");
      setError(aborted ? ko.auth.loginCancelled : ko.auth.loginFailed);
    } finally {
      setPending(false);
    }
  }

  async function handleOtpRedeem() {
    setError(undefined);
    if (!otp.trim()) {
      setError(ko.auth.otpRequired);
      return;
    }
    setOtpPending(true);
    try {
      const result = await redeemOtp(api, otp);
      acceptTokens({
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        requires_passkey_setup: result.requires_passkey_setup,
      });
      // Navigation is driven by the session effect (or the onboarding guard when
      // requires_passkey_setup is set), so nothing else to do here.
    } catch (cause) {
      const status = cause instanceof OtpRedeemError ? cause.status : undefined;
      setError(status === 429 ? ko.auth.otpRateLimited : ko.auth.otpInvalid);
    } finally {
      setOtpPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="grid w-full max-w-sm gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-slate-950">{ko.app.title}</h1>
        </div>
        <Card className="grid gap-5">
          <div className="grid gap-1">
            <h2 className="text-lg font-semibold text-slate-950">
              {ko.auth.title}
            </h2>
            <p className="text-sm text-slate-600">{ko.auth.subtitle}</p>
          </div>

          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              void handlePasskeyLogin();
            }}
          >
            <KeyRound aria-hidden="true" size={18} />
            {pending ? ko.auth.loggingIn : ko.auth.login}
          </Button>

          {otpOpen ? (
            <div className="grid gap-2 border-t border-slate-200 pt-4">
              <label
                className="text-sm font-medium text-slate-700"
                htmlFor="otp-code"
              >
                {ko.auth.otpLabel}
              </label>
              <Input
                id="otp-code"
                value={otp}
                inputMode="text"
                autoComplete="one-time-code"
                placeholder={ko.auth.otpPlaceholder}
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setOtp(event.currentTarget.value);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={otpPending}
                onClick={() => {
                  void handleOtpRedeem();
                }}
              >
                <Ticket aria-hidden="true" size={18} />
                {otpPending ? ko.auth.otpSubmitting : ko.auth.otpSubmit}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="justify-self-start"
              onClick={() => {
                setError(undefined);
                setOtpOpen(true);
              }}
            >
              {ko.auth.otpReveal}
            </Button>
          )}

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
