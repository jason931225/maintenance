import React, { createContext, useContext, useMemo, useState } from "react";

import { createConsoleApiClient } from "../api/client";
import type { ConsoleApiClient } from "../api/client";
import {
  finishPasskeyLogin,
  logout as logoutWebAuthn,
  refreshToken as refreshTokenFn,
  startPasskeyLogin,
} from "../auth/webauthn";

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  role?: "technician" | "admin" | "executive" | "super-admin";
  user_id?: string;
  /** JWT `roles` claim, e.g. ADMIN / SUPER_ADMIN, used for admin-only affordances. */
  roles?: string[];
  /** JWT `branches` claim; the first entry scopes admin actions like issuing OTPs. */
  branches?: string[];
  /**
   * True when the user signed in via OTP and has no passkey yet. While set, the
   * shell forces the initial-settings passkey enrollment step.
   */
  requires_passkey_setup?: boolean;
}

/** Token pair plus the optional first-sign-in passkey-setup flag from OTP redeem. */
export interface AcceptableTokens {
  access_token: string;
  refresh_token: string;
  requires_passkey_setup?: boolean;
}

export interface AuthContextValue {
  session: AuthSession | undefined;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Accept a token pair obtained externally (e.g. via OTP redeem). */
  acceptTokens: (tokens: AcceptableTokens | undefined) => void;
  /** Clear the requires_passkey_setup flag after enrollment succeeds. */
  clearPasskeySetup: () => void;
  api: ConsoleApiClient;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

const STORAGE_KEY = "maintenance_console_session";

function loadSessionFromStorage(): AuthSession | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : undefined;
  } catch {
    return undefined;
  }
}

function saveSessionToStorage(s: AuthSession) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function clearSessionFromStorage() {
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Decode the unverified JWT payload to surface the `sub` / `roles` / `branches`
 * claims for client-side UI gating only (the backend re-verifies on every call).
 * Returns an empty object when the token is malformed.
 */
function decodeAccessClaims(accessToken: string): {
  user_id?: string;
  roles?: string[];
  branches?: string[];
} {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const claims = JSON.parse(atob(padded)) as {
      sub?: string;
      roles?: unknown;
      branches?: unknown;
    };
    return {
      user_id: typeof claims.sub === "string" ? claims.sub : undefined,
      roles: Array.isArray(claims.roles)
        ? claims.roles.filter((r): r is string => typeof r === "string")
        : undefined,
      branches: Array.isArray(claims.branches)
        ? claims.branches.filter((b): b is string => typeof b === "string")
        : undefined,
    };
  } catch {
    return {};
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Session hydrates synchronously from sessionStorage, so there is no async
  // loading phase to guard against.
  const [session, setSession] = useState<AuthSession | undefined>(
    () => loadSessionFromStorage(),
  );

  const api = useMemo(
    () => createConsoleApiClient(session?.access_token),
    [session?.access_token],
  );

  async function login() {
    const ceremony = await startPasskeyLogin(api);
    const tokens = await finishPasskeyLogin(api, ceremony);
    const next: AuthSession = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...decodeAccessClaims(tokens.access_token),
    };
    setSession(next);
    saveSessionToStorage(next);
  }

  async function logout() {
    if (session) {
      await logoutWebAuthn(api, session.refresh_token).catch(() => {});
    }
    setSession(undefined);
    clearSessionFromStorage();
  }

  async function refresh() {
    if (!session) return;
    const tokens = await refreshTokenFn(api, session.refresh_token);
    const next: AuthSession = {
      ...session,
      ...tokens,
      ...decodeAccessClaims(tokens.access_token),
    };
    setSession(next);
    saveSessionToStorage(next);
  }

  function acceptTokens(tokens: AcceptableTokens | undefined) {
    if (!tokens) {
      setSession(undefined);
      clearSessionFromStorage();
      return;
    }
    const next: AuthSession = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      requires_passkey_setup: tokens.requires_passkey_setup,
      ...decodeAccessClaims(tokens.access_token),
    };
    setSession(next);
    saveSessionToStorage(next);
  }

  function clearPasskeySetup() {
    setSession((current) => {
      if (!current) return current;
      const next: AuthSession = { ...current, requires_passkey_setup: false };
      saveSessionToStorage(next);
      return next;
    });
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        login,
        logout,
        refresh,
        acceptTokens,
        clearPasskeySetup,
        api,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
