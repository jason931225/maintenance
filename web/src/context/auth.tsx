import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { createConsoleApiClient } from "../api/client";
import type { ConsoleApiClient } from "../api/client";
import {
  finishPasskeyLogin,
  logout as logoutWebAuthn,
  refreshToken as refreshTokenFn,
  startPasskeyLogin,
} from "../auth/webauthn";

export interface AuthSession {
  /** Short-lived bearer token, held in memory only (never persisted). */
  access_token: string;
  user_id?: string;
  /**
   * JWT `roles` claim, e.g. `["ADMIN"]` / `["SUPER_ADMIN"]`. Canonical role
   * codes match the backend `Role` enum and drive client-side nav gating; the
   * backend re-verifies authorization on every call.
   */
  roles?: string[];
  /** JWT `branches` claim; the first entry scopes admin actions like issuing OTPs. */
  branches?: string[];
  /**
   * True when the user signed in via OTP and has no passkey yet. While set, the
   * shell forces the initial-settings passkey enrollment step.
   */
  requires_passkey_setup?: boolean;
}

/**
 * Token pair accepted from an external flow (OTP redeem). In the web cookie
 * transport the refresh token is NOT in the body — it is set as an HttpOnly
 * cookie by the backend — so only the access token is carried here.
 */
export interface AcceptableTokens {
  access_token: string;
  requires_passkey_setup?: boolean;
}

export interface AuthContextValue {
  session: AuthSession | undefined;
  /**
   * True while the boot-time silent refresh is in flight. UX note: a hard page
   * reload now performs an async silent refresh before the app knows whether it
   * is authenticated, so route guards must wait for this to settle.
   */
  restoring: boolean;
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

/**
 * The active branch id — the first entry of the JWT `branches` claim — or
 * `undefined` when the session carries no branch. Single source of truth for
 * branch scoping: callers render an empty/disabled state when this is absent
 * rather than fabricating a placeholder id.
 */
export function useActiveBranchId(): string | undefined {
  return useAuth().session?.branches?.[0];
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

/** Build a session from a fresh access token plus its decoded UI-gating claims. */
function sessionFromAccessToken(
  accessToken: string,
  requiresPasskeySetup?: boolean,
): AuthSession {
  return {
    access_token: accessToken,
    requires_passkey_setup: requiresPasskeySetup,
    ...decodeAccessClaims(accessToken),
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // The access token lives ONLY in memory; the refresh token never reaches JS
  // (it is an HttpOnly cookie). On boot there is therefore nothing to hydrate
  // synchronously — we recover the session via a silent cookie refresh instead.
  const [session, setSession] = useState<AuthSession | undefined>(undefined);
  const [restoring, setRestoring] = useState(true);

  // A bootstrap api client (no bearer) just for the boot refresh; the per-session
  // client below carries the access token once we have one.
  const bootApi = useMemo(() => createConsoleApiClient(undefined), []);

  const api = useMemo(
    () => createConsoleApiClient(session?.access_token),
    [session?.access_token],
  );

  // Boot-time silent refresh: POST /refresh with the HttpOnly cookie. Success ->
  // authenticated with a fresh access token; any failure (e.g. 401, no cookie)
  // -> unauthenticated. Runs exactly once. The cancellation flag lives on a ref
  // object so an unmount mid-flight skips the state updates.
  const booted = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    cancelled.current = false;
    async function bootRefresh() {
      try {
        const tokens = await refreshTokenFn(bootApi);
        if (!cancelled.current) {
          setSession(sessionFromAccessToken(tokens.access_token));
        }
      } catch {
        if (!cancelled.current) setSession(undefined);
      } finally {
        if (!cancelled.current) setRestoring(false);
      }
    }
    void bootRefresh();
    return () => {
      cancelled.current = true;
    };
  }, [bootApi]);

  async function login() {
    const ceremony = await startPasskeyLogin(api);
    const tokens = await finishPasskeyLogin(api, ceremony);
    setSession(sessionFromAccessToken(tokens.access_token));
  }

  async function logout() {
    if (session) {
      await logoutWebAuthn(api).catch(() => {});
    }
    setSession(undefined);
  }

  async function refresh() {
    if (!session) return;
    const tokens = await refreshTokenFn(api);
    setSession((current) =>
      current
        ? {
            ...current,
            access_token: tokens.access_token,
            ...decodeAccessClaims(tokens.access_token),
          }
        : current,
    );
  }

  function acceptTokens(tokens: AcceptableTokens | undefined) {
    if (!tokens) {
      setSession(undefined);
      return;
    }
    setSession(
      sessionFromAccessToken(tokens.access_token, tokens.requires_passkey_setup),
    );
  }

  function clearPasskeySetup() {
    setSession((current) =>
      current ? { ...current, requires_passkey_setup: false } : current,
    );
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        restoring,
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
