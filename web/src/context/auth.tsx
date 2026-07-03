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
import { setRefreshCallbacks } from "../api/refresh";
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
   * JWT `name` claim — the signed-in user's display name. Present on tenant and
   * platform login/refresh tokens (absent on legacy and read-only view-as
   * tokens). Display only: render this (falling back to `email`, then a generic
   * label) instead of the raw `user_id` UUID. Never used for authorization.
   */
  display_name?: string;
  /** JWT `email` claim, when present. Display-only fallback for the identity label. */
  email?: string;
  /**
   * JWT `org` claim. Client-side routing/context hint only; the backend still
   * enforces tenant scope from the signed bearer token on every request.
   */
  org_id?: string;
  /**
   * JWT `roles` claim, e.g. `["ADMIN"]` / `["SUPER_ADMIN"]`. Canonical role
   * codes match the backend `Role` enum and drive client-side nav gating; the
   * backend re-verifies authorization on every call.
   */
  roles?: string[];
  /**
   * JWT `group_roles` claim, e.g. `["GROUP_ADMIN"]`. Client-side hint only:
   * group-admin APIs re-resolve live grants before every cross-tenant action.
   */
  group_roles?: string[];
  /**
   * JWT `feature_grants` claim: runtime-effective custom-role feature keys used
   * only as client-side UI hints. The backend re-resolves live policy on every
   * request, so this never grants access by itself.
   */
  feature_grants?: string[];
  /** JWT `branches` claim; the first entry scopes admin actions like issuing OTPs. */
  branches?: string[];
  /**
   * JWT `platform` claim. True for the vendor platform-admin tier (multi-tenant
   * console) rather than a tenant session. Drives client-side routing between the
   * tenant app and the `/platform` console; the backend re-verifies on every call
   * (a tenant token is rejected on /platform/*, and vice-versa).
   */
  isPlatform?: boolean;
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

/**
 * An active tenant context session. While set, the app behaves as the selected
 * tenant/role (the active `session` is the tenant-context token), and the banner
 * is shown on every page. `platformSession` keeps the source session (platform
 * operator or group admin) restored on exit.
 */
export type TenantContextMode = "VIEW_ONLY" | "MANAGE";
export type TenantContextSource = "PLATFORM" | "GROUP_ADMIN";

export interface ViewAsState {
  /** The short-lived tenant-context access token. */
  token: string;
  /** VIEW_ONLY blocks mutations server-side; MANAGE is an audited writable tenant-admin context. */
  mode?: TenantContextMode;
  /** Which console/session started this tenant context; controls exit audit/navigation. */
  source?: TenantContextSource;
  /** Acting tenant id + display name, for the banner and exit audit. */
  actingOrgId: string;
  actingOrgName: string;
  /** Acting tenant role code (e.g. `ADMIN`). */
  actingRole: string;
  /** The source session, restored verbatim on exit (legacy field name). */
  platformSession: AuthSession;
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
  /**
   * The active read-only impersonation session, or `undefined` when not viewing
   * as a tenant. Drives the persistent banner and exit affordance.
   */
  viewAs: ViewAsState | undefined;
  /**
   * Enter a read-only or writable tenant context: switch the app to the selected
   * tenant/role using the supplied token, saving the current source session so
   * it can be restored on exit.
   */
  enterViewAs: (params: {
    token: string;
    mode?: TenantContextMode;
    source?: TenantContextSource;
    actingOrgId: string;
    actingOrgName: string;
    actingRole: string;
  }) => void;
  /**
   * Exit the active tenant context and restore the source session. Returns the
   * source access token so the caller can audit the exit; `undefined` when no
   * session was active.
   */
  exitViewAs: () => string | undefined;
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
  display_name?: string;
  email?: string;
  org_id?: string;
  roles?: string[];
  group_roles?: string[];
  feature_grants?: string[];
  branches?: string[];
  isPlatform?: boolean;
} {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    // The `name` claim can be a non-ASCII (e.g. Korean) display name, so decode
    // the base64 payload as UTF-8 rather than passing the raw `atob` binary
    // string to JSON.parse (which would mangle multi-byte characters).
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const claims = JSON.parse(json) as {
      sub?: string;
      name?: unknown;
      email?: unknown;
      org?: unknown;
      roles?: unknown;
      group_roles?: unknown;
      feature_grants?: unknown;
      branches?: unknown;
      platform?: unknown;
    };
    return {
      user_id: typeof claims.sub === "string" ? claims.sub : undefined,
      display_name:
        typeof claims.name === "string" && claims.name.trim()
          ? claims.name
          : undefined,
      email:
        typeof claims.email === "string" && claims.email.trim()
          ? claims.email
          : undefined,
      org_id:
        typeof claims.org === "string" && claims.org.trim()
          ? claims.org
          : undefined,
      roles: Array.isArray(claims.roles)
        ? claims.roles.filter((r): r is string => typeof r === "string")
        : undefined,
      group_roles: Array.isArray(claims.group_roles)
        ? claims.group_roles.filter((r): r is string => typeof r === "string")
        : undefined,
      feature_grants: Array.isArray(claims.feature_grants)
        ? claims.feature_grants.filter((feature): feature is string =>
            typeof feature === "string",
          )
        : undefined,
      branches: Array.isArray(claims.branches)
        ? claims.branches.filter((b): b is string => typeof b === "string")
        : undefined,
      isPlatform: claims.platform === true,
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
  // Active read-only impersonation, if any. While set, the app runs as the
  // impersonated tenant/role (see `activeSession` below) and the banner shows.
  const [viewAs, setViewAs] = useState<ViewAsState | undefined>(undefined);

  // The session the app actually runs under: the impersonation session when
  // viewing as a tenant, otherwise the operator/user's own session. Building it
  // from the view_as token (via `sessionFromAccessToken`) gives `isPlatform =
  // false` and the acting role, so routing drops into the tenant AppShell.
  const activeSession = useMemo<AuthSession | undefined>(
    () => (viewAs ? sessionFromAccessToken(viewAs.token) : session),
    [viewAs, session],
  );

  // A bootstrap api client (no bearer) just for the boot refresh; the per-session
  // client below carries the access token once we have one.
  const bootApi = useMemo(() => createConsoleApiClient(undefined), []);

  const api = useMemo(
    () => createConsoleApiClient(activeSession?.access_token),
    [activeSession?.access_token],
  );

  // Wire the single-flight refresh interceptor (client.ts / platform.ts) to this
  // provider's refresh logic. Runs on every api/session change so the interceptor
  // always holds a closure over the current token-bearing api instance.
  //
  // While impersonating (`viewAs` set) the refresh path is deliberately disabled:
  // the cookie refresh would mint a fresh PLATFORM token (the operator's), which
  // must never silently replace the read-only view_as token. A 401 on an expired
  // impersonation token instead drops the session and exits view-as, returning the
  // operator to the platform console — the safe, explicit outcome.
  useEffect(() => {
    if (viewAs) {
      setRefreshCallbacks(
        () => Promise.reject(new Error("view-as session cannot refresh")),
        () => {
          setViewAs(undefined);
        },
      );
      return;
    }
    setRefreshCallbacks(
      async () => {
        const tokens = await refreshTokenFn(api);
        setSession((current) =>
          current
            ? {
                ...current,
                access_token: tokens.access_token,
                requires_passkey_setup:
                  tokens.requires_passkey_setup,
                ...decodeAccessClaims(tokens.access_token),
              }
            : current,
        );
        return { access_token: tokens.access_token };
      },
      () => {
        setSession(undefined);
      },
    );
  }, [api, viewAs]);

  // Boot-time silent refresh: POST /refresh with the HttpOnly cookie. Success ->
  // authenticated with a fresh access token; any failure (e.g. 401, no cookie)
  // -> unauthenticated.
  //
  // Two StrictMode (dev-only) hazards, both handled below:
  // 1. `cancelled` is a LOCAL variable captured per effect invocation (NOT a
  //    ref): a shared ref (or a `booted`-style "run once" guard) would let the
  //    FIRST invocation's mount -> cleanup -> mount double-invoke poison a
  //    flag the SECOND (surviving) invocation never resets, permanently
  //    skipping its own `setRestoring(false)` and leaving every sign-in flow
  //    (passkey/OTP/dev-auth) unable to navigate away from /login.
  // 2. `bootRefreshPromiseRef` dedupes the ACTUAL NETWORK CALL across both
  //    invocations (the ref, unlike `cancelled`, is shared — refs persist
  //    across StrictMode's double-invoke). Without this, both invocations
  //    would POST the SAME single-use refresh token concurrently, and the
  //    backend's reuse-detection would treat the second arrival as a replay
  //    and revoke the whole refresh family (see refresh-tokens tests).
  const bootRefreshPromiseRef = useRef<ReturnType<typeof refreshTokenFn> | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    async function bootRefresh() {
      try {
        bootRefreshPromiseRef.current ??= refreshTokenFn(bootApi);
        const tokens = await bootRefreshPromiseRef.current;
        // Guard against a race with an explicit sign-in (passkey/OTP/dev-auth)
        // completing WHILE this boot-time refresh is still in flight: never
        // clobber a session someone else already established.
        if (!cancelled) {
          setSession(
            (current) =>
              current ??
              sessionFromAccessToken(
                tokens.access_token,
                tokens.requires_passkey_setup,
              ),
          );
        }
      } catch {
        // No cookie / expired / etc. — leave `session` exactly as it is: still
        // `undefined` in the normal case, but NOT clobbered if an explicit
        // sign-in already set it while this refresh was in flight.
        // (intentionally no setSession call here)
      } finally {
        if (!cancelled) setRestoring(false);
      }
    }
    void bootRefresh();
    return () => {
      cancelled = true;
    };
  }, [bootApi]);

  async function login() {
    const ceremony = await startPasskeyLogin(api);
    const tokens = await finishPasskeyLogin(api, ceremony);
    setSession(
      sessionFromAccessToken(
        tokens.access_token,
        tokens.requires_passkey_setup,
      ),
    );
  }

  async function logout() {
    // If impersonating, drop the view-as session first so logout acts on the
    // operator's real session, not the read-only impersonation token.
    setViewAs(undefined);
    if (session) {
      const operatorApi = viewAs
        ? createConsoleApiClient(viewAs.platformSession.access_token)
        : api;
      await logoutWebAuthn(operatorApi).catch(() => {});
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
            requires_passkey_setup: tokens.requires_passkey_setup,
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
      sessionFromAccessToken(
        tokens.access_token,
        tokens.requires_passkey_setup,
      ),
    );
  }

  function clearPasskeySetup() {
    setSession((current) =>
      current ? { ...current, requires_passkey_setup: false } : current,
    );
  }

  function enterViewAs(params: {
    token: string;
    mode?: TenantContextMode;
    source?: TenantContextSource;
    actingOrgId: string;
    actingOrgName: string;
    actingRole: string;
  }) {
    // Capture the current source session so exit restores it verbatim. Guard
    // against entering with no session — context switching always starts from an
    // authenticated console.
    if (!session) return;
    setViewAs({
      token: params.token,
      mode: params.mode ?? "VIEW_ONLY",
      source: params.source ?? "PLATFORM",
      actingOrgId: params.actingOrgId,
      actingOrgName: params.actingOrgName,
      actingRole: params.actingRole,
      platformSession: session,
    });
  }

  function exitViewAs(): string | undefined {
    if (!viewAs) return undefined;
    // Restore the source session and drop the context token.
    setSession(viewAs.platformSession);
    setViewAs(undefined);
    return viewAs.platformSession.access_token;
  }

  return (
    <AuthContext.Provider
      value={{
        session: activeSession,
        restoring,
        login,
        logout,
        refresh,
        acceptTokens,
        clearPasskeySetup,
        api,
        viewAs,
        enterViewAs,
        exitViewAs,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
