import { KeyRound, Mail, QrCode, Smartphone, Ticket } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import {
  OtpRedeemError,
  SignupError,
  approveDeviceLoginWithPasskey,
  pollDeviceLogin,
  redeemOtp,
  signupOpen,
  startDeviceLogin,
} from "../auth/webauthn";

/** Same-origin relative paths only; reject protocol-relative (//evil) and absolute URLs. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/work-hub";
}

/**
 * Sanitize a fragment-carried OTP handoff (`/login#otp=<code>`). Fragments are
 * client-side only, unlike query strings that often land in server/proxy logs.
 */
const DESKTOP_APPROVE_SESSION_KEY = "mnt.desktop_approve";

function safeDeviceApproveToken(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return /^mnt_dla_[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed : undefined;
}

function safeOtpValue(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9!@#$%^&*\-_]{8}$/.test(trimmed) ? trimmed : undefined;
}

function safeLoginFragment(hash: string): {
  otp?: string;
  desktopApprove?: string;
} {
  if (!hash.startsWith("#")) return {};
  const params = new URLSearchParams(hash.slice(1));
  return {
    otp: safeOtpValue(params.get("otp")),
    desktopApprove: safeDeviceApproveToken(params.get("desktop_approve")),
  };
}

export function LoginPage() {
  const { session, restoring, login, acceptTokens, api } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // A scanned cross-device enrollment QR lands here as `/login#otp=<code>`:
  // derive the initial OTP + open panel from the fragment ONCE at first render
  // (a lazy initializer, not an effect, so the user's later edits are never
  // overwritten). We do NOT auto-submit — redeeming a one-time code is a
  // credential action, so the user taps the confirm button explicitly.
  const [scannedFragment] = useState(() => safeLoginFragment(location.hash));
  const scannedOtp = scannedFragment.otp;
  const desktopApproveToken = scannedFragment.desktopApprove;

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [otpOpen, setOtpOpen] = useState(() => scannedOtp !== undefined);
  const [otp, setOtp] = useState(() => scannedOtp ?? "");
  const [otpPending, setOtpPending] = useState(false);
  const [signupOpenForm, setSignupOpenForm] = useState(false);
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPending, setSignupPending] = useState(false);
  const [desktopQr, setDesktopQr] = useState<
    | { status: "idle" }
    | { status: "starting" }
    | { status: "ready"; pollToken: string; approveUrl: string }
    | { status: "expired" }
  >({ status: "idle" });
  const [phoneApprovePending, setPhoneApprovePending] = useState(false);
  const [phoneApproveDone, setPhoneApproveDone] = useState(false);

  useEffect(() => {
    if ((!scannedOtp && !desktopApproveToken) || !location.hash) return;
    const cleanPath = `${location.pathname}${location.search}`;
    window.history.replaceState(window.history.state, "", cleanPath);
    void navigate(cleanPath, { replace: true });
  }, [
    desktopApproveToken,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    scannedOtp,
  ]);

  useEffect(() => {
    // Wait for the boot silent refresh to settle so a logged-in user who hard-
    // reloads /login is redirected to their destination rather than shown the
    // sign-in card mid-restore.
    if (restoring) return;
    if (!session) return;
    // A phone approval URL must stay on /login long enough to approve the
    // waiting desktop. It deliberately does not mint/accept a phone token.
    if (desktopApproveToken && !scannedOtp) return;
    // A first OTP sign-in still needs a passkey: route into forced enrollment.
    // /login lives outside ProtectedRoute, so the onboarding guard never fires
    // here — drive the redirect explicitly.
    if (session.requires_passkey_setup) {
      void navigate("/onboarding", { replace: true });
      return;
    }
    void navigate(safeNext(searchParams.get("next")), { replace: true });
  }, [desktopApproveToken, restoring, scannedOtp, session, navigate, searchParams]);

  useEffect(() => {
    if (desktopQr.status !== "ready") return undefined;
    let cancelled = false;
    const pollToken = desktopQr.pollToken;

    async function poll() {
      const result = await pollDeviceLogin(api, pollToken).catch(() => undefined);
      if (cancelled || !result) return;
      if (result.status === "expired") {
        setDesktopQr({ status: "expired" });
        return;
      }
      if (result.status !== "approved" || !result.access_token) return;
      acceptTokens({
        access_token: result.access_token,
        requires_passkey_setup: result.requires_passkey_setup ?? false,
      });
      setNotice(ko.auth.phoneLoginApproved);
      void navigate(safeNext(searchParams.get("next")), { replace: true });
    }

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [acceptTokens, api, desktopQr, navigate, searchParams]);

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

  async function handleStartDesktopQrLogin() {
    setError(undefined);
    setNotice(undefined);
    setDesktopQr({ status: "starting" });
    try {
      const handoff = await startDeviceLogin(api);
      setDesktopQr({
        status: "ready",
        pollToken: handoff.poll_token,
        approveUrl: handoff.approve_url,
      });
    } catch {
      setDesktopQr({ status: "idle" });
      setError(ko.auth.phoneLoginFailed);
    }
  }

  async function handleApproveDesktopLogin() {
    if (!desktopApproveToken) return;
    setError(undefined);
    setPhoneApprovePending(true);
    try {
      await approveDeviceLoginWithPasskey(api, desktopApproveToken);
      setPhoneApproveDone(true);
      setNotice(ko.auth.phoneApproveDone);
    } catch (cause) {
      const aborted =
        cause instanceof DOMException &&
        (cause.name === "NotAllowedError" || cause.name === "AbortError");
      setError(aborted ? ko.auth.loginCancelled : ko.auth.phoneApproveFailed);
    } finally {
      setPhoneApprovePending(false);
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
      if (desktopApproveToken && result.requires_passkey_setup) {
        window.sessionStorage.setItem(
          DESKTOP_APPROVE_SESSION_KEY,
          desktopApproveToken,
        );
      }
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

          {desktopApproveToken && !scannedOtp ? (
            <div className="grid gap-3 rounded-lg border border-brand-teal/30 bg-brand-teal/5 p-4">
              <div className="flex items-start gap-3">
                <Smartphone
                  aria-hidden="true"
                  size={20}
                  className="mt-0.5 shrink-0 text-brand-teal"
                />
                <div className="grid gap-1">
                  <h3 className="text-sm font-semibold text-ink">
                    {ko.auth.phoneApproveTitle}
                  </h3>
                  <p className="text-sm text-steel">
                    {ko.auth.phoneApproveDescription}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={phoneApprovePending || phoneApproveDone}
                onClick={() => {
                  void handleApproveDesktopLogin();
                }}
              >
                <KeyRound aria-hidden="true" size={18} />
                {phoneApprovePending
                  ? ko.auth.phoneApproving
                  : phoneApproveDone
                    ? ko.auth.phoneApproveDone
                    : ko.auth.phoneApproveAction}
              </Button>
            </div>
          ) : null}

          {!desktopApproveToken ? (
            <div className="grid gap-3 border-t border-line pt-4">
              <Button
                type="button"
                variant="secondary"
                disabled={desktopQr.status === "starting"}
                onClick={() => {
                  void handleStartDesktopQrLogin();
                }}
              >
                <QrCode aria-hidden="true" size={18} />
                {desktopQr.status === "starting"
                  ? ko.auth.phoneLoginGenerating
                  : ko.auth.phoneLogin}
              </Button>
              {desktopQr.status === "ready" ? (
                <div className="grid justify-items-center gap-3 rounded-lg border border-line bg-muted-panel p-4 text-center">
                  <p className="text-sm font-medium text-steel">
                    {ko.auth.phoneLoginInstruction}
                  </p>
                  <div className="rounded-lg border border-line bg-white p-3">
                    <QRCodeCanvas
                      value={desktopQr.approveUrl}
                      size={176}
                      marginSize={2}
                      level="M"
                      title={ko.auth.phoneLogin}
                    />
                  </div>
                  <a
                    href={desktopQr.approveUrl}
                    className="break-all text-sm font-medium text-brand-teal underline underline-offset-2"
                  >
                    {ko.auth.phoneLoginLink}
                  </a>
                  <p role="status" className="text-sm text-steel">
                    {ko.auth.phoneLoginWaiting}
                  </p>
                </div>
              ) : null}
              {desktopQr.status === "expired" ? (
                <p role="alert" className="text-sm font-medium text-red-700">
                  {ko.auth.phoneLoginExpired}
                </p>
              ) : null}
            </div>
          ) : null}

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
