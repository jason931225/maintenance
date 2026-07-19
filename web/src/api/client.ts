import { createMaintenanceApiClient } from "@maintenance/api-client-ts";

import { getDeviceId } from "./device";
import { isAuthPath, shouldSkipAuthRefresh, singleFlightRefresh } from "./refresh";
import type { RefreshAuthority } from "./refresh";

const retryableRequestClones = new WeakMap<Request, Request>();

const READ_CACHE_FRESH_MS = 30_000;
const READ_CACHE_STALE_MS = 5 * 60_000;
const READ_CACHE_MAX_ENTRIES = 200;

interface CachedRead {
  body: ArrayBuffer;
  headers: [string, string][];
  status: number;
  statusText: string;
  storedAt: number;
}

interface PendingRead {
  generation: number;
  promise: Promise<CachedRead | undefined>;
  resolve: (entry: CachedRead | undefined) => void;
}

interface RequestReadCacheKey {
  generation: number;
  key: string;
}

function createPendingRead(generation: number): PendingRead {
  let resolve!: (entry: CachedRead | undefined) => void;
  const promise = new Promise<CachedRead | undefined>((nextResolve) => {
    resolve = nextResolve;
  });
  return { generation, promise, resolve };
}

function isMutatingRequest(request: Request): boolean {
  return ["DELETE", "PATCH", "POST", "PUT"].includes(
    request.method.toUpperCase(),
  );
}

function bypassesReadCache(request: Request): boolean {
  const cacheControl = request.headers.get("Cache-Control")?.toLowerCase() ?? "";
  return cacheControl.includes("no-cache") || cacheControl.includes("no-store");
}

function isCacheableRead(request: Request): boolean {
  if (request.method !== "GET") return false;
  if (isAuthPath(request.url)) return false;
  if (bypassesReadCache(request)) return false;

  const url = new URL(request.url);
  if (url.pathname.endsWith(".csv")) return false;
  if (url.pathname.includes("/download")) return false;
  if (url.pathname.includes("/exports/")) return false;

  const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
  if (accept.includes("text/csv")) return false;
  if (accept.includes("application/octet-stream")) return false;

  return true;
}

function readCacheKey(request: Request): string {
  return `${request.method} ${request.url}`;
}

function responseFromCached(entry: CachedRead): Response {
  const headers = new Headers(entry.headers);
  headers.set("X-Maintenance-Cache", "hit");
  return new Response(entry.body.slice(0), {
    headers,
    status: entry.status,
    statusText: entry.statusText,
  });
}

async function cachedReadFromResponse(
  response: Response,
): Promise<CachedRead | undefined> {
  if (!response.ok) return undefined;
  if (response.status === 204 || response.status === 205) return undefined;

  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  if (cacheControl.includes("no-store") || cacheControl.includes("no-cache")) {
    return undefined;
  }

  const contentDisposition =
    response.headers.get("Content-Disposition")?.toLowerCase() ?? "";
  if (contentDisposition.includes("attachment")) return undefined;

  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (contentType.includes("text/csv")) return undefined;
  if (contentType.includes("application/octet-stream")) return undefined;

  return {
    body: await response.clone().arrayBuffer(),
    headers: Array.from(response.headers.entries()),
    status: response.status,
    statusText: response.statusText,
    storedAt: Date.now(),
  };
}

async function responseAfter401Refresh(
  request: Request,
  response: Response,
  refreshAuthority: RefreshAuthority | undefined,
): Promise<Response> {
  if (response.status !== 401 || shouldSkipAuthRefresh(request.url)) {
    return response;
  }

  let newToken: string;
  try {
    newToken = await singleFlightRefresh(refreshAuthority);
  } catch {
    // singleFlightRefresh already called onUnauthenticated(); just abort.
    return response;
  }

  const retryHeaders = new Headers(request.headers);
  retryHeaders.set("Authorization", `Bearer ${newToken}`);
  return fetch(new Request(request, { headers: retryHeaders }));
}

async function fetchWith401Refresh(
  request: Request,
  refreshAuthority: RefreshAuthority | undefined,
): Promise<Response> {
  const response = await fetch(request);
  return responseAfter401Refresh(request, response, refreshAuthority);
}

export function createConsoleApiClient(
  bearerToken?: string,
  refreshAuthority?: RefreshAuthority,
) {
  const readCache = new Map<string, CachedRead>();
  const pendingReads = new Map<string, PendingRead>();
  const requestKeys = new WeakMap<Request, RequestReadCacheKey>();
  let readCacheGeneration = 0;

  function resolvePendingRead(requestKey: RequestReadCacheKey) {
    const pending = pendingReads.get(requestKey.key);
    if (pending?.generation !== requestKey.generation) return;
    pending.resolve(undefined);
    pendingReads.delete(requestKey.key);
  }

  function cleanupReadRequest(request: Request) {
    const requestKey = requestKeys.get(request);
    if (!requestKey) return;
    resolvePendingRead(requestKey);
    requestKeys.delete(request);
  }

  function sweepReadCache(now = Date.now()) {
    for (const [key, entry] of readCache) {
      if (now - entry.storedAt > READ_CACHE_STALE_MS) {
        readCache.delete(key);
      }
    }
    while (readCache.size > READ_CACHE_MAX_ENTRIES) {
      const oldestKey = readCache.keys().next().value;
      if (oldestKey === undefined) break;
      readCache.delete(oldestKey);
    }
  }

  function storeReadCacheEntry(key: string, entry: CachedRead) {
    readCache.delete(key);
    readCache.set(key, entry);
    sweepReadCache(entry.storedAt);
  }

  function invalidateReadCache() {
    // This cache is intentionally client-instance local. Cross-tab/user writes may
    // remain visible until the bounded stale window expires or the owning view
    // refetches; immediate consistency flows should perform explicit reloads.
    readCacheGeneration += 1;
    readCache.clear();
    for (const pending of pendingReads.values()) {
      pending.resolve(undefined);
    }
    pendingReads.clear();
  }

  function startBackgroundRefresh(
    request: Request,
    key: string,
    generation: number,
  ) {
    if (pendingReads.get(key)?.generation === generation) return;
    const pending = createPendingRead(generation);
    pendingReads.set(key, pending);
    void fetchWith401Refresh(new Request(request), refreshAuthority)
      .then(cachedReadFromResponse)
      .then((entry) => {
        if (generation === readCacheGeneration) {
          if (entry) {
            storeReadCacheEntry(key, entry);
          } else {
            readCache.delete(key);
          }
        }
        pending.resolve(generation === readCacheGeneration ? entry : undefined);
      })
      .catch(() => {
        pending.resolve(undefined);
      })
      .finally(() => {
        if (pendingReads.get(key) === pending) {
          pendingReads.delete(key);
        }
      });
  }

  async function responseFromReadCache(request: Request) {
    if (request.method === "GET" && bypassesReadCache(request)) {
      readCache.delete(readCacheKey(request));
      return undefined;
    }
    if (!isCacheableRead(request)) return undefined;
    sweepReadCache();
    const key = readCacheKey(request);
    const requestKey = { generation: readCacheGeneration, key };
    requestKeys.set(request, requestKey);
    const cached = readCache.get(key);
    const age = cached ? Date.now() - cached.storedAt : Number.POSITIVE_INFINITY;
    if (cached && age <= READ_CACHE_FRESH_MS) {
      return responseFromCached(cached);
    }
    if (cached && age <= READ_CACHE_STALE_MS) {
      startBackgroundRefresh(request, key, requestKey.generation);
      return responseFromCached(cached);
    }
    if (cached) readCache.delete(key);

    const pending = pendingReads.get(key);
    if (pending?.generation === requestKey.generation) {
      const entry = await pending.promise;
      return entry ? responseFromCached(entry) : undefined;
    }

    pendingReads.set(key, createPendingRead(requestKey.generation));
    return undefined;
  }

  async function rememberReadResponse(request: Request, response: Response) {
    const requestKey = requestKeys.get(request);
    if (!requestKey || !isCacheableRead(request)) return;
    const pending = pendingReads.get(requestKey.key);
    try {
      const entry = await cachedReadFromResponse(response);
      if (requestKey.generation === readCacheGeneration) {
        if (entry) {
          storeReadCacheEntry(requestKey.key, entry);
        } else {
          readCache.delete(requestKey.key);
        }
      }
      if (pending?.generation === requestKey.generation) {
        pending.resolve(
          requestKey.generation === readCacheGeneration ? entry : undefined,
        );
        pendingReads.delete(requestKey.key);
      }
    } catch (error) {
      if (pending?.generation === requestKey.generation) {
        pending.resolve(undefined);
        pendingReads.delete(requestKey.key);
      }
      readCache.delete(requestKey.key);
      throw error;
    } finally {
      requestKeys.delete(request);
    }
  }

  const client = createMaintenanceApiClient({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? window.location.origin,
    bearerToken,
  });

  client.use({
    async onRequest({ request }) {
      // Opt this (web) client into the cookie transport for the refresh token:
      // the backend then sets `mnt_refresh` as an HttpOnly cookie and omits the
      // refresh token from response bodies. Mobile clients never send this header
      // and keep the body-based refresh token.
      request.headers.set("X-Auth-Transport", "cookie");

      // Attach a stable X-Device-Id so the backend can apply its optional
      // per-device auth rate limit. Best-effort: omitted when unavailable.
      const deviceId = getDeviceId();
      if (deviceId) {
        request.headers.set("X-Device-Id", deviceId);
      }

      // Send and accept the HttpOnly refresh cookie (`mnt_refresh`). The browser
      // attaches it only to /api/v1/auth requests (the cookie's Path scope), so
      // ordinary API calls still carry just the Authorization bearer header.
      // openapi-fetch builds the Request before middleware runs, and a Request's
      // `credentials` is immutable, so we return a credentials-augmented clone
      // that inherits the headers set above.
      const nextRequest = new Request(request, { credentials: "include" });
      retryableRequestClones.set(nextRequest, nextRequest.clone());
      if (isMutatingRequest(nextRequest)) {
        invalidateReadCache();
      }
      const cachedResponse = await responseFromReadCache(nextRequest);
      if (cachedResponse) {
        retryableRequestClones.delete(nextRequest);
        return cachedResponse;
      }
      return nextRequest;
    },

    async onResponse({ response, request }) {
      // On a 401 from refresh-eligible endpoints: perform a single-flight token
      // refresh and retry the original request once with the new bearer token.
      // Primary auth endpoints are excluded to avoid refresh loops on login,
      // OTP redeem, token refresh, and logout. Authenticated auth endpoints such
      // as passkey enroll-handoff still refresh/retry when the bearer is stale.
      try {
        const retrySource = retryableRequestClones.get(request) ?? request;
        const nextResponse = await responseAfter401Refresh(retrySource, response, refreshAuthority);
        await rememberReadResponse(request, nextResponse);
        if (isMutatingRequest(request) && nextResponse.ok) {
          invalidateReadCache();
        }
        return nextResponse;
      } finally {
        retryableRequestClones.delete(request);
      }
    },

    onError({ request }) {
      cleanupReadRequest(request);
      retryableRequestClones.delete(request);
    },
  });

  return client;
}

export type ConsoleApiClient = ReturnType<typeof createConsoleApiClient>;
