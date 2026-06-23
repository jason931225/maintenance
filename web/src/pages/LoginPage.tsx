import { KeyRound, Mail, Ticket } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import {
  OtpRedeemError,
  SignupError,
  redeemOtp,
  signupOpen,
} from "../auth/webauthn";

/** Same-origin relative paths only; reject protocol-relative (//evil) and absolute URLs. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dispatch";
}

/**
 * Sanitize an `?otp=` query param (a scanned cross-device enrollment handoff or an
 * admin-issued sign-in code). Returns the code only when it matches the exact
 * server OTP shape — 8 characters over the copy-paste-safe alphabet
 * `A-Za-z0-9!@#$%^&*-_` — so a malformed or injected value is ignored rather than
 * prefilled. Anything else yields undefined.
 */
function safeOtpParam(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9!@#$%^&*\-_]{8}$/.test(trimmed) ? trimmed : undefined;
}

export function LoginPage() {
  const { session, restoring, login, acceptTokens, api } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // A scanned cross-device enrollment QR (or an admin-issued code link) lands here
  // as `?otp=<code>`: derive the initial OTP + open panel from the param ONCE at
  // first render (a lazy initializer, not an effect, so there is no cascading
  // render and the user's later edits are never overwritten). We do NOT auto-submit
  // — redeeming a one-time code is a credential action, so the user taps the
  // confirm button explicitly. A logged-in user is redirected away by the effect.
  const scannedOtp = safeOtpParam(searchParams.get("otp"));

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [otpOpen, setOtpOpen] = useState(() => scannedOtp !== undefined);
  const [otp, setOtp] = useState(() => scannedOtp ?? "");
  const [otpPending, setOtpPending] = useState(false);
  const [signupOpenForm, setSignupOpenForm] = useState(false);
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPending, setSignupPending] = useState(false);

  useEffect(() => {
    // Wait for the boot silent refresh to settle so a logged-in user who hard-
    // reloads /login is redirected to their destination rather than shown the
    // sign-in card mid-restore.
    if (restoring) return;
    if (!session) return;
    // A first OTP sign-in still needs a passkey: route into forced enrollment.
    // /login lives outside ProtectedRoute, so the onboarding guard never fires
    // here — drive the redirect explicitly.
    if (session.requires_passkey_setup) {
      void navigate("/onboarding", { replace: true });
      return;
    }
    void navigate(safeNext(searchParams.get("next")), { replace: true });
  }, [restoring, session, navigate, searchParams]);

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
      // Cookie transport: the refresh token is set as an HttpOnly cookie by the
      // backend and is absent from the body, so only the access token is carried
      // into the session here.
      acceptTokens({
        access_token: result.access_token,
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

  async function handleSignup() {
    setError(undefined);
    setNotice(undefined);
    const email = signupEmail.trim();
    if (!email) {
      setError(ko.auth.signupRequired);
      return;
    }
    setSignupPending(true);
    try {
      await signupOpen(api, email);
      // The backend emailed a one-time code (logged by the stub sender in
      // dev/e2e). Surface the OTP panel so the new user enters it and is driven
      // into passkey enrollment via the existing redeem flow.
      setSignupOpenForm(false);
      setOtpOpen(true);
      setNotice(ko.auth.signupSent);
    } catch (cause) {
      const status = cause instanceof SignupError ? cause.status : undefined;
      if (status === 429) {
        setError(ko.auth.signupRateLimited);
      } else if (status === 400) {
        setError(ko.auth.signupInvalid);
      } else {
        setError(ko.auth.signupFailed);
      }
    } finally {
      setSignupPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted-panel px-4 py-12">
      <div className="grid w-full max-w-sm gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-ink">{ko.app.title}</h1>
        </div>
        <Card className="grid gap-5">
          <div className="grid gap-1">
            <h2 className="text-lg font-semibold text-ink">
              {ko.auth.title}
            </h2>
            <p className="text-sm text-steel">{ko.auth.subtitle}</p>
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
            <div className="grid gap-2 border-t border-line pt-4">
              <label
                className="text-sm font-medium text-steel"
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

          {signupOpenForm ? (
            <div className="grid gap-2 border-t border-line pt-4">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="signup-email"
              >
                {ko.auth.signupLabel}
              </label>
              <Input
                id="signup-email"
                value={signupEmail}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder={ko.auth.signupPlaceholder}
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setSignupEmail(event.currentTarget.value);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={signupPending}
                onClick={() => {
                  void handleSignup();
                }}
              >
                <Mail aria-hidden="true" size={18} />
                {signupPending ? ko.auth.signupSubmitting : ko.auth.signupSubmit}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="justify-self-start"
              onClick={() => {
                setError(undefined);
                setNotice(undefined);
                setSignupOpenForm(true);
              }}
            >
              {ko.auth.signupReveal}
            </Button>
          )}

          {notice ? (
            <p role="status" className="text-sm font-medium text-steel">
              {notice}
            </p>
          ) : null}

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
