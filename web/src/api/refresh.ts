/**
 * Single-flight token refresh for the 401-retry interceptor.
 *
 * Why a module-level singleton?
 * - `openapi-fetch` middleware and `platformFetch` callers run concurrently.
 *   Without deduplication, two simultaneous 401s would each call the refresh
 *   endpoint, which triggers the backend's refresh-token reuse-detection and
 *   revokes the whole family.
 * - A module-level Promise ref survives across the multiple `createConsoleApiClient`
 *   instances that AuthProvider creates (one per token), so concurrent 401s from
 *   different calls still share one in-flight refresh.
 *
 * Usage:
 *   1. AuthProvider calls `setRefreshCallbacks` on mount to wire in its own
 *      `refresh()` (which calls the backend and updates session state) and an
 *      `onUnauthenticated` handler that clears the session.
 *   2. The `client.ts` onResponse middleware and `platformFetch` wrapper both
 *      call `singleFlightRefresh()` on a 401; it dedupes concurrent callers
 *      into one in-flight Promise and returns the new access token on success,
 *      or throws (which the callers turn into a session clear + redirect).
 */

/** The backend's `POST /api/v1/auth/token/refresh` result, minimally typed. */
export interface RefreshResult {
  access_token: string;
}

type RefreshFn = () => Promise<RefreshResult>;
type OnUnauthenticated = () => void;

let _refresh: RefreshFn | null = null;
let _onUnauthenticated: OnUnauthenticated | null = null;

/** Called by AuthProvider on mount to wire in the live auth callbacks. */
export function setRefreshCallbacks(
  refresh: RefreshFn,
  onUnauthenticated: OnUnauthenticated,
): void {
  _refresh = refresh;
  _onUnauthenticated = onUnauthenticated;
}

/** The single in-flight refresh Promise, or null when no refresh is running. */
let _inflightRefresh: Promise<RefreshResult> | null = null;

/**
 * Call the refresh endpoint at most once across concurrent 401 responses.
 * Returns a fresh access token on success.
 * On failure: calls onUnauthenticated() and re-throws so callers abort.
 */
export async function singleFlightRefresh(): Promise<string> {
  if (!_refresh) {
    // No auth callbacks registered yet (e.g. during boot before AuthProvider
    // mounts). Treat as an unrecoverable auth failure.
    _onUnauthenticated?.();
    throw new Error("No refresh callback registered");
  }

  if (!_inflightRefresh) {
    _inflightRefresh = _refresh().finally(() => {
      _inflightRefresh = null;
    });
  }

  try {
    const result = await _inflightRefresh;
    return result.access_token;
  } catch (err) {
    _onUnauthenticated?.();
    throw err;
  }
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
