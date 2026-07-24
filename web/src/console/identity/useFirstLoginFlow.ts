import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  acceptPrivacyConsent,
  approveDeviceLoginSession,
  finishPasskeyRegistration,
  getPrivacyConsentStatus,
  issueEnrollHandoff,
  pollDeviceLogin,
  startPasskeyRegistration,
} from "../../auth/webauthn";
import { useAuth, type TokenAcceptanceLease } from "../../context/auth";
import { ko } from "../../i18n/ko";

export const REQUIRED_PRIVACY_TERMS_VERSION = "kr-pipa-v1-2026-06-25";
const DESKTOP_APPROVE_SESSION_KEY = "mnt.desktop_approve";
const COMPLETION_POLL_MS = 2_500;

export const FIRST_LOGIN_ACTIONS = {
  consentAccept: "identity.consent.accept",
  consentRetry: "identity.consent.retry",
  enrollPlatform: "identity.passkey.enroll.platform",
  enrollPhone: "identity.passkey.enroll.phone",
  enrollPhoneLink: "identity.passkey.enroll.phone.link",
  signOut: "identity.session.sign_out",
} as const;

export type ConsentPhase =
  | "loading"
  | "required"
  | "accepted"
  | "submitting"
  | "error_load"
  | "error_accept";

export interface ConsentAcknowledgement {
  key: "privacy_collection" | "terms_of_service";
  required: true;
  accepted: boolean;
  label: string;
}

export interface ConsentObjectViewModel {
  kind: "consent";
  policy_version: string;
  jurisdiction: "KR";
  legal_basis: "PIPA";
  subject_user_id?: string;
  org_id?: string;
  status: "required" | "accepted" | "error";
  required_acknowledgements: ConsentAcknowledgement[];
  optional_acknowledgements: [];
  accepted_at?: string | null;
  audit_event_id?: string;
  object_links: Array<{ kind: "user" | "org" | "jurisdiction" | "audit_event"; id: string }>;
  lifecycle: { phase: "active" | "superseded"; version: string };
}

export type PlatformEnrollmentStatus =
  | "idle"
  | "pending"
  | "cancelled"
  | "failed"
  | "complete";

export interface PhoneHandoff {
  url: string;
  otp: string;
  expiresAt: string;
  pollToken: string;
}

export type PhoneEnrollmentState =
  | { status: "closed" }
  | { status: "generating" }
  | { status: "ready" | "waiting"; handoff: PhoneHandoff }
  | { status: "expired" }
  | { status: "error" }
  | { status: "approved" };

function safeDeviceApproveToken(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return /^mnt_dla_[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed : undefined;
}

export function useFirstLoginFlow() {
  const {
    api,
    logout,
    beginTokenAcceptance,
    acceptTokens,
    clearPasskeySetup,
    session,
  } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const desktopApproveTokenRef = useRef<string | undefined>(
    safeDeviceApproveToken(searchParams.get("desktop_approve")) ??
      safeDeviceApproveToken(
        window.sessionStorage.getItem(DESKTOP_APPROVE_SESSION_KEY),
      ),
  );
  const phoneAcceptanceLeaseRef = useRef<TokenAcceptanceLease | undefined>(
    undefined,
  );

  const [consentPhase, setConsentPhase] = useState<ConsentPhase>("loading");
  const [policyVersion, setPolicyVersion] = useState(
    REQUIRED_PRIVACY_TERMS_VERSION,
  );
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [privacyChecked, setPrivacyChecked] = useState(false);
  const [termsChecked, setTermsChecked] = useState(false);
  const [platformStatus, setPlatformStatus] =
    useState<PlatformEnrollmentStatus>("idle");
  const [phone, setPhone] = useState<PhoneEnrollmentState>({ status: "closed" });

  const loadConsentStatus = useCallback(async () => {
    setConsentPhase("loading");
    try {
      const status = await getPrivacyConsentStatus(api);
      const version = status.policy_version || REQUIRED_PRIVACY_TERMS_VERSION;
      setPolicyVersion(version);
      setAcceptedAt(status.accepted_at ?? null);
      setConsentPhase(
        status.accepted && version === REQUIRED_PRIVACY_TERMS_VERSION
          ? "accepted"
          : "required",
      );
    } catch {
      setConsentPhase("error_load");
    }
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(loadConsentStatus);
  }, [loadConsentStatus]);

  const consentAccepted = consentPhase === "accepted";
  const consentBusy = consentPhase === "loading" || consentPhase === "submitting";
  const canAcceptConsent = privacyChecked && termsChecked && !consentBusy;

  const consentObject = useMemo<ConsentObjectViewModel>(() => {
    const status: ConsentObjectViewModel["status"] =
      consentPhase === "accepted"
        ? "accepted"
        : consentPhase === "error_accept" || consentPhase === "error_load"
          ? "error"
          : "required";
    const links: ConsentObjectViewModel["object_links"] = [
      { kind: "jurisdiction", id: "KR-PIPA" },
    ];
    if (session?.user_id) links.push({ kind: "user", id: session.user_id });
    if (session?.org_id) links.push({ kind: "org", id: session.org_id });
    return {
      kind: "consent",
      policy_version: policyVersion,
      jurisdiction: "KR",
      legal_basis: "PIPA",
      subject_user_id: session?.user_id,
      org_id: session?.org_id,
      status,
      required_acknowledgements: [
        {
          key: "privacy_collection",
          required: true,
          accepted: privacyChecked || consentPhase === "accepted",
          label: ko.identity.onboarding.consent.privacyCheckbox,
        },
        {
          key: "terms_of_service",
          required: true,
          accepted: termsChecked || consentPhase === "accepted",
          label: ko.identity.onboarding.consent.termsCheckbox,
        },
      ],
      optional_acknowledgements: [],
      accepted_at: acceptedAt,
      object_links: links,
      lifecycle: {
        phase: policyVersion === REQUIRED_PRIVACY_TERMS_VERSION ? "active" : "superseded",
        version: policyVersion,
      },
    };
  }, [acceptedAt, consentPhase, policyVersion, privacyChecked, session, termsChecked]);

  const acceptConsent = useCallback(async () => {
    if (!canAcceptConsent) return;
    setConsentPhase("submitting");
    try {
      const status = await acceptPrivacyConsent(api, {
        policy_version: REQUIRED_PRIVACY_TERMS_VERSION,
        privacy_collection: true,
        terms_of_service: true,
      });
      setPolicyVersion(status.policy_version || REQUIRED_PRIVACY_TERMS_VERSION);
      setAcceptedAt(status.accepted_at ?? null);
      setConsentPhase(status.accepted ? "accepted" : "required");
    } catch {
      setConsentPhase("error_accept");
    }
  }, [api, canAcceptConsent]);

  const approveDesktopIfNeeded = useCallback(async () => {
    const token = desktopApproveTokenRef.current;
    if (!token) return;
    try {
      await approveDeviceLoginSession(api, token);
    } catch {
      // Enrollment succeeded; stale desktop QR approval must not trap setup.
    } finally {
      window.sessionStorage.removeItem(DESKTOP_APPROVE_SESSION_KEY);
      desktopApproveTokenRef.current = undefined;
    }
  }, [api]);

  const completeSetup = useCallback(
    async (accessToken?: string): Promise<boolean> => {
      if (accessToken) {
        const lease = phoneAcceptanceLeaseRef.current;
        if (
          !lease ||
          acceptTokens(
            { access_token: accessToken, requires_passkey_setup: false },
            lease,
          ) === false
        ) {
          return false;
        }
        phoneAcceptanceLeaseRef.current = undefined;
      }
      clearPasskeySetup();
      await approveDesktopIfNeeded();
      void navigate("/overview", { replace: true });
      return true;
    },
    [acceptTokens, approveDesktopIfNeeded, clearPasskeySetup, navigate],
  );

  const enrollPlatform = useCallback(async () => {
    if (!consentAccepted || platformStatus === "pending") return;
    setPhone({ status: "closed" });
    setPlatformStatus("pending");
    try {
      const ceremony = await startPasskeyRegistration(api, {}, "platform");
      await finishPasskeyRegistration(api, ceremony);
      setPlatformStatus("complete");
      await completeSetup();
    } catch (cause) {
      const cancelled =
        cause instanceof DOMException &&
        (cause.name === "NotAllowedError" || cause.name === "AbortError");
      setPlatformStatus(cancelled ? "cancelled" : "failed");
    }
  }, [api, completeSetup, consentAccepted, platformStatus]);

  const startPhoneEnrollment = useCallback(async () => {
    if (!consentAccepted) return;
    const lease = beginTokenAcceptance?.();
    if (!lease) {
      setPhone({ status: "error" });
      return;
    }
    phoneAcceptanceLeaseRef.current = lease;
    setPlatformStatus("idle");
    setPhone({ status: "generating" });
    try {
      const handoff = await issueEnrollHandoff(api, false);
      setPhone({
        status: "waiting",
        handoff: {
          url: handoff.enroll_url,
          otp: handoff.otp,
          expiresAt: handoff.expires_at,
          pollToken: handoff.poll_token,
        },
      });
    } catch {
      if (phoneAcceptanceLeaseRef.current === lease) {
        phoneAcceptanceLeaseRef.current = undefined;
      }
      setPhone({ status: "error" });
    }
  }, [api, beginTokenAcceptance, consentAccepted]);

  useEffect(() => {
    if (phone.status !== "waiting") return undefined;
    let cancelled = false;
    const { pollToken } = phone.handoff;

    async function pollCompletion() {
      const result = await pollDeviceLogin(api, pollToken).catch(() => undefined);
      if (cancelled || !result) return;
      if (result.status === "expired") {
        phoneAcceptanceLeaseRef.current = undefined;
        setPhone({ status: "expired" });
        return;
      }
      if (result.status !== "approved" || !result.access_token) return;
      if (await completeSetup(result.access_token)) {
        setPhone({ status: "approved" });
      } else {
        setPhone({ status: "error" });
      }
    }

    void pollCompletion();
    const timer = window.setInterval(() => {
      void pollCompletion();
    }, COMPLETION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, completeSetup, phone]);

  return {
    consentObject,
    consentPhase,
    consentAccepted,
    consentBusy,
    canAcceptConsent,
    privacyChecked,
    termsChecked,
    platformStatus,
    phone,
    setPrivacyChecked,
    setTermsChecked,
    acceptConsent,
    loadConsentStatus,
    enrollPlatform,
    startPhoneEnrollment,
    signOut: logout,
  };
}
