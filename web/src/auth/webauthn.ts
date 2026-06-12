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

export async function startPasskeyLogin(
  api: WebAuthnApi,
  userId: string,
): Promise<LoginCeremony> {
  const result = await api.POST("/api/v1/auth/passkey/login/start", {
    body: { user_id: userId },
  });
  const data = requireData<LoginStartResponse>(result.data);
  return {
    ceremonyId: data.ceremony_id,
    publicKey: toRequestOptions(data.challenge),
  };
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

export async function startPasskeyRegistration(
  api: WebAuthnApi,
  body: components["schemas"]["PasskeyRegisterStartRequest"],
): Promise<RegisterCeremony> {
  const result = await api.POST("/api/v1/auth/passkey/register/start", {
    body,
  });
  const data = requireData<RegisterStartResponse>(result.data);
  return {
    ceremonyId: data.ceremony_id,
    publicKey: toCreationOptions(data.challenge),
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

export async function refreshToken(
  api: WebAuthnApi,
  refresh_token: string,
): Promise<TokenPairResponse> {
  const result = await api.POST("/api/v1/auth/token/refresh", {
    body: { refresh_token },
  });
  return requireData<TokenPairResponse>(result.data);
}

export async function logout(api: WebAuthnApi, refresh_token: string) {
  await api.POST("/api/v1/auth/logout", {
    body: { refresh_token },
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
