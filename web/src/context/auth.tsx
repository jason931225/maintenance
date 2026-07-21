import React, {
  useCallback,
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
  createRefreshCoordinator,
  setRefreshCallbacks,
  singleFlightRefresh,
} from "../api/refresh";
import type { RefreshAuthority, RefreshRegistration } from "../api/refresh";
import type { CedarPolicyProjectionClaim } from "../auth/policyProjection";
import { normalizeCedarPolicyProjectionClaim } from "../auth/policyProjection";
import {
  finishPasskeyLogin,
  logout as logoutWebAuthn,
  refreshToken as refreshTokenFn,
  startPasskeyLogin,
} from "../auth/webauthn";

export interface AuthSession {
  /** Short-lived bearer token, held in memory only (never persisted). */
  access_token: string;
  /**
   * Client-only, non-secret identity for one established session incarnation.
   *
   * AuthProvider allocates this on boot/login/token acceptance and explicit
   * tenant-context entry, and preserves it only for a proven refresh/update of
   * that same session. It partitions retained client state; it is never sent to
   * the backend and is not authorization evidence.
   */
  client_session_incarnation?: string;
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
  /**
   * JWT `policy_projection` claim: non-authoritative Cedar/PBAC projection for
   * display/debug UX only. It must never authorize RoleManage-tier access or
   * replace backend reauthorization.
   */
  policy_projection?: CedarPolicyProjectionClaim;
  /** JWT `branches` claim; the first entry scopes admin actions like issuing OTPs. */
  branches?: string[];
  /**
   * JWT `platform` claim. True for the vendor platform-admin tier (multi-tenant
   * console) rather than a tenant session. Drives client-side routing between the
   * tenant app and the `/platform` console; the backend re-verifies on every call
   * (a tenant token is rejected on `/api/platform/*`, and a platform token is
   * rejected on tenant `/api/*` routes).
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

declare const tokenAcceptanceLeaseBrand: unique symbol;

/** Opaque, provider-owned permission to commit one external token result. */
export interface TokenAcceptanceLease {
  readonly [tokenAcceptanceLeaseBrand]: true;
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
  /** AuthProvider-owned client incarnation for this effective tenant context. */
  client_session_incarnation?: string;
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
  /** Mint a one-use acceptance lease before starting external asynchronous work. */
  beginTokenAcceptance?: () => TokenAcceptanceLease | undefined;
  /** Commit only with the current provider-issued one-use lease. */
  acceptTokens: (
    tokens: AcceptableTokens | undefined,
    lease?: TokenAcceptanceLease,
  ) => unknown;
  /** Clear the requires_passkey_setup flag after enrollment succeeds. */
  clearPasskeySetup: () => void;
  api: ConsoleApiClient;
  /** Opaque authority for the active effective session, if refresh-capable. */
  refreshAuthority?: RefreshAuthority;
  /**
   * Opaque authority for the source/operator session. During tenant context this
   * intentionally differs from `refreshAuthority`; source-only platform/group
   * calls must carry this port.
   */
  sourceRefreshAuthority?: RefreshAuthority;
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
  }) => unknown;
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
  policy_projection?: CedarPolicyProjectionClaim;
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
      policy_projection?: unknown;
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
      policy_projection: normalizeCedarPolicyProjectionClaim(
        claims.policy_projection,
      ),
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
  clientSessionIncarnation?: string,
): AuthSession {
  return {
    access_token: accessToken,
    client_session_incarnation: clientSessionIncarnation,
    requires_passkey_setup: requiresPasskeySetup,
    ...decodeAccessClaims(accessToken),
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | undefined>(undefined);
  const [viewAs, setViewAs] = useState<ViewAsState | undefined>(undefined);
  const [restoring, setRestoring] = useState(true);
  const [transitionGeneration, setTransitionGeneration] = useState(0);
  const [refreshCoordinator] = useState(createRefreshCoordinator);
  const [refreshPorts, setRefreshPorts] = useState<{
    effective?: RefreshAuthority;
    source?: RefreshAuthority;
  }>({});

  const sessionRef = useRef<AuthSession | undefined>(undefined);
  const viewAsRef = useRef<ViewAsState | undefined>(undefined);
  const mountedRef = useRef(false);
  const transitionGenerationRef = useRef(0);
  const tokenAcceptanceEpochRef = useRef(0);
  const tokenAcceptanceCustodyRef = useRef(
    new WeakMap<object, number>(),
  );
  const refreshBindingsRef = useRef<{
    source?: { incarnation: string; registration: RefreshRegistration };
    effective?: { incarnation: string; registration: RefreshRegistration };
  }>({});
  const nextSessionIncarnationRef = useRef(0);
  const replaceAuthorityRef = useRef<(
    nextSession: AuthSession | undefined,
    nextViewAs: ViewAsState | undefined,
  ) => number>(() => 0);

  const bootApi = useMemo(() => createConsoleApiClient(undefined), []);

  const allocateSessionIncarnation = useCallback((): string => {
    nextSessionIncarnationRef.current += 1;
    return `client-session-${String(nextSessionIncarnationRef.current)}`;
  }, []);

  const invalidateTokenAcceptanceLeases = useCallback(() => {
    tokenAcceptanceEpochRef.current += 1;
    tokenAcceptanceCustodyRef.current = new WeakMap<object, number>();
  }, []);

  const disposeEffectiveRefreshBinding = useCallback(() => {
    refreshBindingsRef.current.effective?.registration.dispose();
    refreshBindingsRef.current.effective = undefined;
  }, []);

  const disposeAllRefreshBindings = useCallback(() => {
    disposeEffectiveRefreshBinding();
    refreshBindingsRef.current.source?.registration.dispose();
    refreshBindingsRef.current.source = undefined;
  }, [disposeEffectiveRefreshBinding]);

  const advanceTransition = useCallback((): number => {
    invalidateTokenAcceptanceLeases();
    transitionGenerationRef.current += 1;
    const next = transitionGenerationRef.current;
    setTransitionGeneration(next);
    return next;
  }, [invalidateTokenAcceptanceLeases]);

  const createSourceRefreshBinding = useCallback(
    (sourceIncarnation: string) => {
      const registration = setRefreshCallbacks(
        refreshCoordinator,
        async () => {
          const tokens = await refreshTokenFn(bootApi);
          const currentBinding = refreshBindingsRef.current.source;
          const currentSource = sessionRef.current;
          if (
            !mountedRef.current ||
            currentBinding?.registration !== registration ||
            currentSource?.client_session_incarnation !== sourceIncarnation
          ) {
            throw new Error("Refresh completed for a retired source authority");
          }
          const refreshedSource: AuthSession = {
            ...currentSource,
            access_token: tokens.access_token,
            requires_passkey_setup: tokens.requires_passkey_setup,
            ...decodeAccessClaims(tokens.access_token),
          };
          const currentView = viewAsRef.current;
          sessionRef.current = refreshedSource;
          setSession(refreshedSource);
          if (currentView) {
            const refreshedView: ViewAsState = {
              ...currentView,
              platformSession: refreshedSource,
            };
            viewAsRef.current = refreshedView;
            setViewAs(refreshedView);
          }
          return { access_token: tokens.access_token };
        },
        () => {
          if (refreshBindingsRef.current.source?.registration === registration) {
            replaceAuthorityRef.current(undefined, undefined);
          }
        },
      );
      return { incarnation: sourceIncarnation, registration };
    },
    [bootApi, refreshCoordinator],
  );

  const createEffectiveRefreshBinding = useCallback(
    (effectiveIncarnation: string) => {
      const registration = setRefreshCallbacks(
        refreshCoordinator,
        () => Promise.reject(new Error("Effective tenant context cannot refresh")),
        () => {
          if (
            refreshBindingsRef.current.effective?.registration === registration
          ) {
            replaceAuthorityRef.current(sessionRef.current, undefined);
          }
        },
      );
      return { incarnation: effectiveIncarnation, registration };
    },
    [refreshCoordinator],
  );

  const synchronizeRefreshBindings = useCallback(
    (
      nextSession: AuthSession | undefined,
      nextViewAs: ViewAsState | undefined,
    ) => {
      const sourceIncarnation = nextSession?.client_session_incarnation?.trim();
      if (!sourceIncarnation) {
        disposeAllRefreshBindings();
        setRefreshPorts({});
        return;
      }

      const bindings = refreshBindingsRef.current;
      if (bindings.source?.incarnation !== sourceIncarnation) {
        disposeAllRefreshBindings();
        bindings.source = createSourceRefreshBinding(sourceIncarnation);
      }
      const sourceBinding = bindings.source;

      const effectiveIncarnation =
        nextViewAs?.client_session_incarnation?.trim();
      if (!effectiveIncarnation) {
        disposeEffectiveRefreshBinding();
        setRefreshPorts({
          effective: sourceBinding.registration.authority,
          source: sourceBinding.registration.authority,
        });
        return;
      }

      if (bindings.effective?.incarnation !== effectiveIncarnation) {
        disposeEffectiveRefreshBinding();
        bindings.effective = createEffectiveRefreshBinding(effectiveIncarnation);
      }
      setRefreshPorts({
        effective: bindings.effective.registration.authority,
        source: sourceBinding.registration.authority,
      });
    },
    [
      createEffectiveRefreshBinding,
      createSourceRefreshBinding,
      disposeAllRefreshBindings,
      disposeEffectiveRefreshBinding,
    ],
  );

  const replaceAuthority = useCallback(
    (
      nextSession: AuthSession | undefined,
      nextViewAs: ViewAsState | undefined,
    ): number => {
      const generation = advanceTransition();
      sessionRef.current = nextSession;
      viewAsRef.current = nextViewAs;
      synchronizeRefreshBindings(nextSession, nextViewAs);
      setSession(nextSession);
      setViewAs(nextViewAs);
      return generation;
    },
    [advanceTransition, synchronizeRefreshBindings],
  );
  useEffect(() => {
    replaceAuthorityRef.current = replaceAuthority;
  }, [replaceAuthority]);

  const activeSession = useMemo<AuthSession | undefined>(
    () =>
      viewAs
        ? sessionFromAccessToken(
            viewAs.token,
            undefined,
            viewAs.client_session_incarnation,
          )
        : session,
    [viewAs, session],
  );
  const refreshAuthority = refreshPorts.effective;
  const sourceRefreshAuthority = refreshPorts.source;

  const api = useMemo(
    () =>
      createConsoleApiClient(activeSession?.access_token, refreshAuthority),
    [activeSession?.access_token, refreshAuthority],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateTokenAcceptanceLeases();
      disposeAllRefreshBindings();
    };
  }, [disposeAllRefreshBindings, invalidateTokenAcceptanceLeases]);

  const bootRefreshPromiseRef = useRef<ReturnType<typeof refreshTokenFn> | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    const originGeneration = transitionGenerationRef.current;

    async function bootRefresh() {
      try {
        bootRefreshPromiseRef.current ??= refreshTokenFn(bootApi);
        const tokens = await bootRefreshPromiseRef.current;
        if (
          !cancelled &&
          mountedRef.current &&
          transitionGenerationRef.current === originGeneration &&
          sessionRef.current === undefined &&
          viewAsRef.current === undefined
        ) {
          replaceAuthority(
            sessionFromAccessToken(
              tokens.access_token,
              tokens.requires_passkey_setup,
              allocateSessionIncarnation(),
            ),
            undefined,
          );
        }
      } catch {
        // No cookie or an expired/revoked cookie leaves current authority intact.
      } finally {
        if (!cancelled) setRestoring(false);
      }
    }

    void bootRefresh();
    return () => {
      cancelled = true;
    };
  }, [allocateSessionIncarnation, bootApi, replaceAuthority]);

  function beginTokenAcceptance(): TokenAcceptanceLease | undefined {
    if (
      !mountedRef.current ||
      transitionGenerationRef.current !== transitionGeneration
    ) {
      return undefined;
    }
    invalidateTokenAcceptanceLeases();
    const lease = Object.freeze({}) as TokenAcceptanceLease;
    tokenAcceptanceCustodyRef.current.set(
      lease,
      tokenAcceptanceEpochRef.current,
    );
    return lease;
  }

  function providerIsMounted(): boolean {
    return mountedRef.current;
  }

  async function login() {
    if (
      !mountedRef.current ||
      transitionGenerationRef.current !== transitionGeneration
    ) {
      return;
    }
    const originGeneration = advanceTransition();
    disposeAllRefreshBindings();
    setRefreshPorts({});
    const ceremony = await startPasskeyLogin(api);
    const tokens = await finishPasskeyLogin(api, ceremony);
    if (
      !providerIsMounted() ||
      transitionGenerationRef.current !== originGeneration
    ) {
      return;
    }
    replaceAuthority(
      sessionFromAccessToken(
        tokens.access_token,
        tokens.requires_passkey_setup,
        allocateSessionIncarnation(),
      ),
      undefined,
    );
  }

  async function logout() {
    invalidateTokenAcceptanceLeases();
    if (
      !mountedRef.current ||
      transitionGenerationRef.current !== transitionGeneration
    ) {
      return;
    }
    const currentViewAs = viewAsRef.current;
    const operatorSession = currentViewAs?.platformSession ?? sessionRef.current;
    replaceAuthority(undefined, undefined);
    if (!operatorSession) return;
    const operatorApi = createConsoleApiClient(operatorSession.access_token);
    await logoutWebAuthn(operatorApi).catch(() => {});
  }

  async function refresh() {
    invalidateTokenAcceptanceLeases();
    if (
      !mountedRef.current ||
      transitionGenerationRef.current !== transitionGeneration ||
      !refreshAuthority
    ) {
      return;
    }
    await singleFlightRefresh(refreshAuthority);
  }

  function acceptTokens(
    tokens: AcceptableTokens | undefined,
    lease?: TokenAcceptanceLease,
  ): boolean {
    if (
      !mountedRef.current ||
      transitionGenerationRef.current !== transitionGeneration ||
      !lease ||
      (typeof lease !== "object" && typeof lease !== "function")
    ) {
      return false;
    }
    const leaseEpoch = tokenAcceptanceCustodyRef.current.get(lease);
    if (leaseEpoch !== tokenAcceptanceEpochRef.current) return false;

    tokenAcceptanceCustodyRef.current.delete(lease);
    invalidateTokenAcceptanceLeases();
    if (!tokens) {
      replaceAuthority(undefined, undefined);
      setRestoring(false);
      return true;
    }
    replaceAuthority(
      sessionFromAccessToken(
        tokens.access_token,
        tokens.requires_passkey_setup,
        allocateSessionIncarnation(),
      ),
      undefined,
    );
    setRestoring(false);
    return true;
  }

  function clearPasskeySetup() {
    if (
      !mountedRef.current ||
      transitionGenerationRef.current !== transitionGeneration
    ) {
      return;
    }
    const renderedIncarnation = session?.client_session_incarnation;
    const current = sessionRef.current;
    if (!current || current.client_session_incarnation !== renderedIncarnation) {
      return;
    }
    const next = { ...current, requires_passkey_setup: false };
    sessionRef.current = next;
    setSession(next);
  }

  function enterViewAs(params: {
    token: string;
    mode?: TenantContextMode;
    source?: TenantContextSource;
    actingOrgId: string;
    actingOrgName: string;
    actingRole: string;
  }): boolean {
    if (
      !mountedRef.current ||
      transitionGenerationRef.current !== transitionGeneration ||
      viewAsRef.current !== viewAs
    ) {
      return false;
    }
    const sourceSession = viewAs?.platformSession ?? session;
    if (!sourceSession || sessionRef.current !== sourceSession) return false;

    const nextViewAs: ViewAsState = {
      token: params.token,
      client_session_incarnation: allocateSessionIncarnation(),
      mode: params.mode ?? "VIEW_ONLY",
      source: params.source ?? "PLATFORM",
      actingOrgId: params.actingOrgId,
      actingOrgName: params.actingOrgName,
      actingRole: params.actingRole,
      platformSession: sourceSession,
    };
    replaceAuthority(sourceSession, nextViewAs);
    return true;
  }

  function exitViewAs(): string | undefined {
    const renderedViewAs = viewAs;
    if (
      !mountedRef.current ||
      !renderedViewAs ||
      transitionGenerationRef.current !== transitionGeneration ||
      viewAsRef.current !== renderedViewAs ||
      sessionRef.current !== renderedViewAs.platformSession
    ) {
      return undefined;
    }

    const sourceSession = renderedViewAs.platformSession;
    replaceAuthority(sourceSession, undefined);
    return sourceSession.access_token;
  }

  return (
    <AuthContext.Provider
      value={{
        session: activeSession,
        restoring,
        login,
        logout,
        refresh,
        beginTokenAcceptance,
        acceptTokens,
        clearPasskeySetup,
        api,
        refreshAuthority,
        sourceRefreshAuthority,
        viewAs,
        enterViewAs,
        exitViewAs,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
