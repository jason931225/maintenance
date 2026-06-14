import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../api/client";
import type { TokenPairResponse } from "../api/types";

type LoginStartResponse =
  components["schemas"]["PasskeyLoginStartResponse"];
type LoginFinishResponse = components["schemas"]["TokenPairResponse"];
type RegisterStartResponse =
  components["schemas"]["PasskeyRegisterStartResponse"];
type RegisterFinishResponse =
  components["schemas"]["PasskeyRegisterFinishResponse"];
type OtpRedeemResponse = components["schemas"]["OtpRedeemResponse"];

export interface WebAuthnApi {
  POST: ConsoleApiClient["POST"];
}

export interface LoginCeremony {
  ceremonyId: string;
  publicKey: PublicKeyCredentialRequestOptions;
}

export interface RegisterCeremony {
  ceremonyId: string;
  publicKey: PublicKeyCredentialCreationOptions;
}

/**
 * Starts a usernameless (discoverable) passkey login. The backend takes no
 * request body and returns a challenge with an empty `allowCredentials`, so the
 * browser shows its native passkey picker and the user is resolved from the
 * asserted credential at finish.
 */
export async function startPasskeyLogin(
  api: WebAuthnApi,
): Promise<LoginCeremony> {
  const result = await api.POST("/api/v1/auth/passkey/login/start", {});
  const data = requireData<LoginStartResponse>(result.data);
  return {
    ceremonyId: data.ceremony_id,
    publicKey: toRequestOptions(data.challenge),
  };
}

/**
 * First sign-in for a pre-provisioned user: redeems a single-use one-time code
 * for a session token pair. `requires_passkey_setup` is true when the user has
 * no passkey yet and must enroll one in initial settings.
 */
export class OtpRedeemError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined) {
    super(`OTP redeem failed with status ${String(status)}`);
    this.name = "OtpRedeemError";
    this.status = status;
  }
}

export async function redeemOtp(
  api: WebAuthnApi,
  otp: string,
): Promise<OtpRedeemResponse> {
  const result = await api.POST("/api/v1/auth/otp/redeem", {
    body: { otp: otp.trim() },
  });
  if (result.data === undefined) {
    throw new OtpRedeemError(result.response.status);
  }
  return result.data;
}

export async function finishPasskeyLogin(
  api: WebAuthnApi,
  ceremony: LoginCeremony,
): Promise<TokenPairResponse> {
  const credential = await getCredential(ceremony.publicKey);
  const result = await api.POST("/api/v1/auth/passkey/login/finish", {
    body: {
      ceremony_id: ceremony.ceremonyId,
      credential: publicKeyCredentialToJson(credential),
    },
  });
  return requireData<LoginFinishResponse>(result.data);
}

type AdminIssueOtpRequest = components["schemas"]["AdminIssueOtpRequest"];
type AdminIssueOtpResponse = components["schemas"]["AdminIssueOtpResponse"];

/**
 * Admin-only: issue a single-use sign-in code for a pre-provisioned user so they
 * can complete their first sign-in. Authz-gated to ADMIN / SUPER_ADMIN server-side.
 */
export async function issueAdminOtp(
  api: WebAuthnApi,
  body: AdminIssueOtpRequest,
): Promise<AdminIssueOtpResponse> {
  const result = await api.POST("/api/v1/auth/admin/otp/issue", { body });
  return requireData<AdminIssueOtpResponse>(result.data);
}

export async function startPasskeyRegistration(
  api: WebAuthnApi,
  body: components["schemas"]["PasskeyRegisterStartRequest"],
  attachment?: AuthenticatorAttachment,
): Promise<RegisterCeremony> {
  const result = await api.POST("/api/v1/auth/passkey/register/start", {
    body,
  });
  const data = requireData<RegisterStartResponse>(result.data);
  return {
    ceremonyId: data.ceremony_id,
    publicKey: toCreationOptions(data.challenge, attachment),
  };
}

export async function finishPasskeyRegistration(
  api: WebAuthnApi,
  ceremony: RegisterCeremony,
): Promise<RegisterFinishResponse> {
  const credential = await createCredential(ceremony.publicKey);
  const result = await api.POST("/api/v1/auth/passkey/register/finish", {
    body: {
      ceremony_id: ceremony.ceremonyId,
      credential: publicKeyCredentialToJson(credential),
    },
  });
  return requireData<RegisterFinishResponse>(result.data);
}

/**
 * Rotate the session in the web cookie transport. The refresh token rides in the
 * HttpOnly `mnt_refresh` cookie (sent automatically by the browser), so the body
 * is empty and the response carries only a fresh access token — the rotated
 * refresh token is set back as a cookie and never reaches JS.
 */
export async function refreshToken(
  api: WebAuthnApi,
): Promise<TokenPairResponse> {
  const result = await api.POST("/api/v1/auth/token/refresh", {
    body: {},
  });
  return requireData<TokenPairResponse>(result.data);
}

/**
 * Log out in the web cookie transport: the backend reads the refresh token from
 * the `mnt_refresh` cookie, revokes the family, and clears the cookie. No token
 * is sent in the body.
 */
export async function logout(api: WebAuthnApi) {
  await api.POST("/api/v1/auth/logout", {
    body: {},
  });
}

function requireData<T>(data: T | undefined): T {
  if (data === undefined) {
    throw new Error("API response did not include data");
  }
  return data;
}

function toRequestOptions(
  challenge: Record<string, unknown>,
): PublicKeyCredentialRequestOptions {
  const options = { ...challenge };
  if (typeof options.challenge === "string") {
    options.challenge = base64urlToArrayBuffer(options.challenge);
  }
  if (Array.isArray(options.allowCredentials)) {
    options.allowCredentials = options.allowCredentials.map((credential) =>
      credentialDescriptorToNative(credential),
    );
  }
  return options as unknown as PublicKeyCredentialRequestOptions;
}

function toCreationOptions(
  challenge: Record<string, unknown>,
  attachment?: AuthenticatorAttachment,
): PublicKeyCredentialCreationOptions {
  const options = { ...challenge };
  if (typeof options.challenge === "string") {
    options.challenge = base64urlToArrayBuffer(options.challenge);
  }
  if (isRecord(options.user)) {
    options.user = {
      ...options.user,
      id:
        typeof options.user.id === "string"
          ? base64urlToArrayBuffer(options.user.id)
          : options.user.id,
    };
  }
  if (Array.isArray(options.excludeCredentials)) {
    options.excludeCredentials = options.excludeCredentials.map((credential) =>
      credentialDescriptorToNative(credential),
    );
  }
  if (attachment) {
    // Steer which authenticator the user chose without weakening the server's
    // resident-key requirement — passkeys MUST stay discoverable for usernameless
    // login. "platform" = this device (Touch ID / Windows Hello); "cross-platform"
    // = a phone or security key, which makes the browser show its native QR /
    // hybrid (cross-device) flow.
    const existing = isRecord(options.authenticatorSelection)
      ? options.authenticatorSelection
      : {};
    options.authenticatorSelection = {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
      ...existing,
      authenticatorAttachment: attachment,
    };
  }
  return options as unknown as PublicKeyCredentialCreationOptions;
}

async function getCredential(
  publicKey: PublicKeyCredentialRequestOptions,
): Promise<PublicKeyCredential> {
  assertWebAuthnSupport();
  const credential = await navigator.credentials.get({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("WebAuthn credential was not returned");
  }
  return credential;
}

async function createCredential(
  publicKey: PublicKeyCredentialCreationOptions,
): Promise<PublicKeyCredential> {
  assertWebAuthnSupport();
  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("WebAuthn credential was not returned");
  }
  return credential;
}

function assertWebAuthnSupport() {
  if (
    typeof navigator.credentials.get !== "function" ||
    typeof navigator.credentials.create !== "function" ||
    typeof PublicKeyCredential === "undefined"
  ) {
    throw new Error("WebAuthn is unavailable");
  }
}

function credentialDescriptorToNative(
  credential: unknown,
): PublicKeyCredentialDescriptor {
  if (!isRecord(credential)) {
    throw new Error("Invalid credential descriptor");
  }
  return {
    ...credential,
    id:
      typeof credential.id === "string"
        ? base64urlToArrayBuffer(credential.id)
        : credential.id,
  } as PublicKeyCredentialDescriptor;
}

function publicKeyCredentialToJson(credential: PublicKeyCredential) {
  const response = credential.response;
  if (response instanceof AuthenticatorAssertionResponse) {
    return {
      id: credential.id,
      rawId: arrayBufferToBase64url(credential.rawId),
      response: {
        authenticatorData: arrayBufferToBase64url(response.authenticatorData),
        clientDataJSON: arrayBufferToBase64url(response.clientDataJSON),
        signature: arrayBufferToBase64url(response.signature),
        userHandle: response.userHandle
          ? arrayBufferToBase64url(response.userHandle)
          : null,
      },
      type: credential.type,
    };
  }
  if (response instanceof AuthenticatorAttestationResponse) {
    return {
      id: credential.id,
      rawId: arrayBufferToBase64url(credential.rawId),
      response: {
        attestationObject: arrayBufferToBase64url(response.attestationObject),
        clientDataJSON: arrayBufferToBase64url(response.clientDataJSON),
      },
      type: credential.type,
    };
  }
  throw new Error("Unsupported WebAuthn response");
}

function base64urlToArrayBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer;
}

function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
