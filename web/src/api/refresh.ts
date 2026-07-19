/**
 * Provider-local, incarnation-scoped refresh coordination.
 *
 * Coordinator and authority identity lives exclusively in module-private
 * WeakMaps. Runtime handles are frozen, property-free capabilities: callers
 * can carry them, but cannot inspect, copy, mutate, or reconstruct custody.
 */

/** The backend's `POST /api/v1/auth/token/refresh` result, minimally typed. */
export interface RefreshResult {
  access_token: string;
}

type RefreshFn = () => Promise<RefreshResult>;
type OnUnauthenticated = () => void;

declare const refreshCoordinatorBrand: unique symbol;
declare const refreshAuthorityBrand: unique symbol;

/** Provider-local owner of refresh bindings and in-flight work. */
export interface RefreshCoordinator {
  readonly [refreshCoordinatorBrand]: true;
}

/** Opaque, non-secret capability for one current refresh registration. */
export interface RefreshAuthority {
  readonly [refreshAuthorityBrand]: true;
}

export interface RefreshRegistration {
  readonly authority: RefreshAuthority;
  dispose: () => void;
}

interface RefreshCoordinatorState {
  readonly marker: true;
}

interface RefreshAuthorityState {
  readonly coordinator: RefreshCoordinatorState;
  rebindable: boolean;
  binding?: RefreshBinding;
}

interface RefreshBinding {
  active: boolean;
  readonly authority: RefreshAuthority;
  readonly authorityState: RefreshAuthorityState;
  readonly refresh: RefreshFn;
  readonly onUnauthenticated: OnUnauthenticated;
  inflight?: Promise<string>;
}

const coordinatorCustody = new WeakMap<object, RefreshCoordinatorState>();
const authorityCustody = new WeakMap<object, RefreshAuthorityState>();

export function createRefreshCoordinator(): RefreshCoordinator {
  const coordinator = Object.freeze({}) as RefreshCoordinator;
  coordinatorCustody.set(coordinator, { marker: true });
  return coordinator;
}

/**
 * Compatibility seed for callers that still allocate before registration.
 * The label is deliberately ignored: it is neither identity nor authority.
 */
export function createRefreshAuthority(
  coordinator: RefreshCoordinator,
  legacyIncarnation?: string,
): RefreshAuthority {
  void legacyIncarnation;
  const coordinatorState = coordinatorCustody.get(coordinator);
  if (!coordinatorState) {
    throw new Error("Refresh coordinator is not registered");
  }
  return mintAuthority(coordinatorState, true);
}

function mintAuthority(
  coordinator: RefreshCoordinatorState,
  rebindable: boolean,
): RefreshAuthority {
  const authority = Object.freeze({}) as RefreshAuthority;
  authorityCustody.set(authority, { coordinator, rebindable });
  return authority;
}

/** Register callbacks and return the only authority accepted by the binding. */
export function setRefreshCallbacks(
  owner: RefreshCoordinator | RefreshAuthority,
  refresh: RefreshFn,
  onUnauthenticated: OnUnauthenticated,
): RefreshRegistration;
/** Isolated compatibility overload; the returned handle is still mandatory. */
export function setRefreshCallbacks(
  refresh: RefreshFn,
  onUnauthenticated: OnUnauthenticated,
): RefreshRegistration;
export function setRefreshCallbacks(
  ownerOrRefresh: RefreshCoordinator | RefreshAuthority | RefreshFn,
  refreshOrUnauthenticated: RefreshFn | OnUnauthenticated,
  maybeOnUnauthenticated?: OnUnauthenticated,
): RefreshRegistration {
  if (typeof ownerOrRefresh === "function") {
    const coordinator = createRefreshCoordinator();
    return registerCoordinator(
      coordinator,
      ownerOrRefresh,
      () => {
        void refreshOrUnauthenticated();
      },
    );
  }

  const onUnauthenticated = maybeOnUnauthenticated;
  if (!onUnauthenticated) {
    throw new Error("Refresh registration requires an unauthenticated callback");
  }
  const coordinatorState = coordinatorCustody.get(ownerOrRefresh);
  if (coordinatorState) {
    return bindAuthority(
      mintAuthority(coordinatorState, false),
      refreshOrUnauthenticated as RefreshFn,
      onUnauthenticated,
    );
  }

  const seedState = authorityCustody.get(ownerOrRefresh);
  if (!seedState) {
    throw new Error("Refresh authority or coordinator is not registered");
  }
  if (!seedState.rebindable) {
    throw new Error("Refresh authority registration is coordinator-owned");
  }

  let authority: RefreshAuthority = ownerOrRefresh as RefreshAuthority;
  if (seedState.binding) {
    if (!seedState.binding.active) {
      throw new Error("Refresh authority is retired");
    }
    seedState.rebindable = false;
    seedState.binding.active = false;
    authority = mintAuthority(seedState.coordinator, true);
  }
  return bindAuthority(
    authority,
    refreshOrUnauthenticated as RefreshFn,
    onUnauthenticated,
  );
}

function registerCoordinator(
  coordinator: RefreshCoordinator,
  refresh: RefreshFn,
  onUnauthenticated: OnUnauthenticated,
): RefreshRegistration {
  const coordinatorState = coordinatorCustody.get(coordinator);
  if (!coordinatorState) {
    throw new Error("Refresh coordinator is not registered");
  }
  return bindAuthority(
    mintAuthority(coordinatorState, false),
    refresh,
    onUnauthenticated,
  );
}

function bindAuthority(
  authority: RefreshAuthority,
  refresh: RefreshFn,
  onUnauthenticated: OnUnauthenticated,
): RefreshRegistration {
  const authorityState = authorityCustody.get(authority);
  if (!authorityState) {
    throw new Error("Refresh authority is not registered");
  }
  const binding: RefreshBinding = {
    active: true,
    authority,
    authorityState,
    refresh,
    onUnauthenticated,
  };
  authorityState.binding = binding;

  return Object.freeze({
    authority,
    dispose: () => {
      if (!binding.active) return;
      binding.active = false;
    },
  });
}

function isCurrentBinding(binding: RefreshBinding): boolean {
  return binding.active && binding.authorityState.binding === binding;
}

/**
 * Refresh at most once for concurrent callers carrying the same exact authority.
 * Retired work is rejected before it can supply a retry bearer or clear a newer
 * session. Failures notify only the still-current originating registration.
 */
export function singleFlightRefresh(
  authority: RefreshAuthority | undefined,
): Promise<string> {
  if (!authority) {
    return Promise.reject(new Error("Refresh authority is required"));
  }
  const authorityState = authorityCustody.get(authority);
  if (!authorityState) {
    throw new Error("Refresh authority is not registered");
  }
  const binding = authorityState.binding;
  if (!binding || !isCurrentBinding(binding)) {
    return Promise.reject(new Error("Refresh authority is retired or not registered"));
  }
  if (binding.inflight) return binding.inflight;

  const flight = Promise.resolve()
    .then(binding.refresh)
    .then(
      (result) => {
        if (!isCurrentBinding(binding)) {
          throw new Error("Refresh authority was retired");
        }
        return result.access_token;
      },
      (error: unknown) => {
        if (isCurrentBinding(binding)) binding.onUnauthenticated();
        throw error;
      },
    )
    .finally(() => {
      if (binding.inflight === flight) binding.inflight = undefined;
    });
  binding.inflight = flight;
  return flight;
}

const AUTH_REFRESH_BYPASS_PATHS = new Set([
  // Refresh/login/logout/OTP/signup are primary auth ceremonies. A 401 on these
  // means the ceremony failed or the refresh cookie is invalid; retrying them via
  // the refresh interceptor would loop or mask the real auth error.
  "/api/v1/auth/token/refresh",
  "/api/v1/auth/logout",
  "/api/v1/auth/otp/redeem",
  "/api/v1/auth/signup",
  "/api/v1/auth/passkey/login/start",
  "/api/v1/auth/passkey/login/finish",
  "/api/v1/auth/device-login/start",
  "/api/v1/auth/device-login/poll",
  "/api/v1/auth/device-login/approve",
]);

/**
 * Whether a URL should bypass the 401 refresh/retry interceptor.
 *
 * Keep this list narrow: authenticated auth endpoints such as
 * `/api/v1/auth/passkey/enroll-handoff`, passkey registration, privacy consent,
 * passkey list/delete, and device-login approve-session still need refresh/retry
 * because the access token is memory-only and can expire while the refresh cookie
 * remains valid.
 */
export function shouldSkipAuthRefresh(url: string): boolean {
  try {
    const pathname = pathnameFromUrl(url);
    return (
      AUTH_REFRESH_BYPASS_PATHS.has(pathname) ||
      pathname.startsWith("/api/platform/auth/")
    );
  } catch {
    return false;
  }
}

/** Whether a URL is under an auth namespace (not necessarily retry-excluded). */
export function isAuthPath(url: string): boolean {
  try {
    const pathname = pathnameFromUrl(url);
    return (
      pathname.startsWith("/api/v1/auth/") ||
      pathname.startsWith("/api/platform/auth/")
    );
  } catch {
    return false;
  }
}

function pathnameFromUrl(url: string): string {
  return new URL(url, "http://localhost").pathname;
}
