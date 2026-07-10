import { Monitor, QrCode } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { visibleNavItemsForRoles } from "../components/shell/nav";
import { EnrollHandoffQr } from "../features/auth/EnrollHandoffQr";
import { useAuth, type AuthSession } from "../context/auth";
import { ko } from "../i18n/ko";
import {
  acceptPrivacyConsent,
  approveDeviceLoginSession,
  finishPasskeyRegistration,
  getPrivacyConsentStatus,
  startPasskeyRegistration,
} from "../auth/webauthn";

const FALLBACK_PRIVACY_TERMS_VERSION = "kr-pipa-v1-2026-06-25";
const DESKTOP_APPROVE_SESSION_KEY = "mnt.desktop_approve";

function onboardingDestination(session: AuthSession | undefined): string {
  if (session?.isPlatform) return "/platform";
  return (
    visibleNavItemsForRoles(
      session?.roles,
      session?.group_roles,
      session?.feature_grants,
    ).find((item) => item.key !== "profile")?.href ?? "/pending"
  );
}

const privacyConsentSections = [
  {
    key: "purpose",
    title: ko.onboarding.privacy.purposeTitle,
    body: ko.onboarding.privacy.purpose,
  },
  {
    key: "items",
    title: ko.onboarding.privacy.itemsTitle,
    body: ko.onboarding.privacy.items,
  },
  {
    key: "retention",
    title: ko.onboarding.privacy.retentionTitle,
    body: ko.onboarding.privacy.retention,
  },
  {
    key: "refusal",
    title: ko.onboarding.privacy.refusalTitle,
    body: ko.onboarding.privacy.refusal,
  },
] as const;

function safeDeviceApproveToken(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return /^mnt_dla_[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed : undefined;
}

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
  const { api, logout, acceptTokens, clearPasskeySetup, session } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [desktopApproveToken] = useState(() =>
    safeDeviceApproveToken(searchParams.get("desktop_approve")) ??
    safeDeviceApproveToken(
      window.sessionStorage.getItem(DESKTOP_APPROVE_SESSION_KEY),
    ),
  );
  const [consentLoading, setConsentLoading] = useState(true);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [policyVersion, setPolicyVersion] = useState(
    FALLBACK_PRIVACY_TERMS_VERSION,
  );
  const [privacyChecked, setPrivacyChecked] = useState(false);
  const [termsChecked, setTermsChecked] = useState(false);
  const [consentPending, setConsentPending] = useState(false);
  const [consentError, setConsentError] = useState<string | undefined>(
    undefined,
  );
  const [pending, setPending] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const handoffRedirectTokenRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const loadConsentStatus = useCallback(async () => {
    setConsentLoading(true);
    setConsentError(undefined);
    try {
      const status = await getPrivacyConsentStatus(api);
      setPolicyVersion(status.policy_version);
      setConsentAccepted(status.accepted);
    } catch {
      setConsentError(ko.onboarding.privacy.loadFailed);
    } finally {
      setConsentLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadConsentStatus();
    });
  }, [loadConsentStatus]);

  async function acceptRequiredPrivacyTerms() {
    setConsentPending(true);
    setConsentError(undefined);
    try {
      const status = await acceptPrivacyConsent(api, {
        policy_version: policyVersion,
        privacy_collection: privacyChecked,
        terms_of_service: termsChecked,
      });
      setPolicyVersion(status.policy_version);
      setConsentAccepted(status.accepted);
    } catch {
      setConsentError(ko.onboarding.privacy.acceptFailed);
    } finally {
      setConsentPending(false);
    }
  }

  async function approveDesktopIfNeeded() {
    if (!desktopApproveToken) return;
    try {
      await approveDeviceLoginSession(api, desktopApproveToken);
    } catch {
      // Enrollment succeeded; a stale/expired desktop QR must not keep the user
      // trapped in initial setup. The desktop can start a fresh QR login.
    } finally {
      window.sessionStorage.removeItem(DESKTOP_APPROVE_SESSION_KEY);
    }
  }

  async function enrollThisDevice() {
    setError(undefined);
    setShowQr(false);
    setPending(true);
    try {
      const ceremony = await startPasskeyRegistration(api, {}, "platform");
      await finishPasskeyRegistration(api, ceremony);
      await approveDesktopIfNeeded();
      clearPasskeySetup();
      void navigate(onboardingDestination(session), { replace: true });
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

  const handlePhoneQrCompleted = useCallback(
    (accessToken?: string) => {
      if (!accessToken) {
        clearPasskeySetup();
        void navigate(onboardingDestination(session), { replace: true });
        return;
      }

      acceptTokens({
        access_token: accessToken,
        requires_passkey_setup: false,
      });
      handoffRedirectTokenRef.current = accessToken;
    },
    [acceptTokens, clearPasskeySetup, navigate, session],
  );

  useEffect(() => {
    const redirectToken = handoffRedirectTokenRef.current;
    if (!redirectToken || session?.access_token !== redirectToken) {
      return;
    }
    handoffRedirectTokenRef.current = undefined;
    clearPasskeySetup();
    void navigate(onboardingDestination(session), { replace: true });
  }, [clearPasskeySetup, navigate, session]);

  const busy = pending || consentLoading || consentPending;
  const canAcceptConsent = privacyChecked && termsChecked && !consentPending;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted-panel px-4 py-12">
      <div className="grid w-full max-w-md gap-6">
        <Card className="grid gap-5 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-xl font-semibold text-ink">
              {ko.onboarding.title}
            </h1>
            <div className="flex flex-wrap gap-2" aria-hidden="true">
              <span className="rounded-full border border-brand-teal/20 bg-brand-teal/5 px-2 py-1 text-xs font-semibold text-brand-teal">
                {ko.onboarding.privacy.title}
              </span>
              <span className="rounded-full border border-line bg-muted-panel px-2 py-1 text-xs font-semibold text-steel">
                {ko.onboarding.title}
              </span>
            </div>
          </div>

          {!consentAccepted ? (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-ink">
                  {ko.onboarding.privacy.title}
                </h2>
                <span className="rounded-full border border-line bg-muted-panel px-2 py-1 text-xs font-semibold text-steel">
                  {consentLoading
                    ? ko.onboarding.privacy.loading
                    : ko.onboarding.privacy.submit}
                </span>
              </div>

              <dl className="grid gap-3 rounded-lg border border-line bg-muted-panel p-4 text-sm">
                {privacyConsentSections.map((section) => (
                  <div key={section.key}>
                    <dt className="font-semibold text-ink">{section.title}</dt>
                    <dd className="mt-1 leading-6 text-steel">{section.body}</dd>
                  </div>
                ))}
              </dl>

              {consentLoading ? (
                <p
                  role="status"
                  className="justify-self-start rounded-full border border-line bg-muted-panel px-2 py-1 text-xs font-semibold text-steel"
                >
                  {ko.onboarding.privacy.loading}
                </p>
              ) : (
                <>
                  <label className="flex items-center gap-3 rounded-lg border border-line bg-white p-3 text-sm font-medium text-ink transition hover:border-steel hover:bg-muted-panel">
                    <input
                      type="checkbox"
                      checked={privacyChecked}
                      onChange={(event) => {
                        setPrivacyChecked(event.currentTarget.checked);
                      }}
                      className="mt-1 h-4 w-4 accent-signal"
                    />
                    <span>{ko.onboarding.privacy.privacyCheckbox}</span>
                  </label>
                  <label className="flex items-center gap-3 rounded-lg border border-line bg-white p-3 text-sm font-medium text-ink transition hover:border-steel hover:bg-muted-panel">
                    <input
                      type="checkbox"
                      checked={termsChecked}
                      onChange={(event) => {
                        setTermsChecked(event.currentTarget.checked);
                      }}
                      className="mt-1 h-4 w-4 accent-signal"
                    />
                    <span>{ko.onboarding.privacy.termsCheckbox}</span>
                  </label>
                  <Button
                    type="button"
                    disabled={!canAcceptConsent}
                    onClick={() => {
                      void acceptRequiredPrivacyTerms();
                    }}
                  >
                    {consentPending
                      ? ko.onboarding.privacy.submitting
                      : ko.onboarding.privacy.submit}
                  </Button>
                  {consentError ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="justify-self-start"
                      disabled={consentPending}
                      onClick={() => {
                        void loadConsentStatus();
                      }}
                    >
                      {ko.onboarding.privacy.retry}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : (
            <div className="grid gap-3">
              <button
                type="button"
                disabled={busy}
                aria-label={
                  pending
                    ? ko.onboarding.enrolling
                    : ko.onboarding.methods.desktop.title
                }
                onClick={() => {
                  void enrollThisDevice();
                }}
                className="flex min-h-14 items-center gap-3 rounded-lg border border-line bg-white p-4 text-left transition hover:border-steel hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Monitor
                  aria-hidden="true"
                  size={22}
                  className="shrink-0 text-steel"
                />
                <span className="text-sm font-semibold text-ink">
                  {pending
                    ? ko.onboarding.enrolling
                    : ko.onboarding.methods.desktop.title}
                </span>
              </button>

              <button
                type="button"
                disabled={busy}
                aria-expanded={showQr}
                aria-label={ko.onboarding.methods.phoneQr.title}
                onClick={() => {
                  setError(undefined);
                  setShowQr((open) => !open);
                }}
                className="flex min-h-14 items-center gap-3 rounded-lg border border-line bg-white p-4 text-left transition hover:border-steel hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                <QrCode
                  aria-hidden="true"
                  size={22}
                  className="shrink-0 text-steel"
                />
                <span className="text-sm font-semibold text-ink">
                  {ko.onboarding.methods.phoneQr.title}
                </span>
              </button>

              {showQr ? (
                <div className="rounded-lg border border-line bg-muted-panel p-4">
                  <EnrollHandoffQr
                    requireStepUp={false}
                    initialPasskeyCount={0}
                    onCompleted={handlePhoneQrCompleted}
                  />
                </div>
              ) : null}
            </div>
          )}

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

          {consentError ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {consentError}
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
