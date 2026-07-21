/**
 * Tests for the single-flight 401-retry interceptor.
 *
 * Coverage:
 *   1. A 401 on a normal request triggers exactly ONE refresh, then a retry
 *      that succeeds — the caller receives the 200 response.
 *   2. Concurrent 401s share one refresh call (single-flight guarantee).
 *   3. Refresh failure clears the session (calls onUnauthenticated).
 *   4. Authenticated auth endpoints such as enroll-handoff refresh/retry on 401.
 *   5. Primary auth endpoints are NOT retried on 401 (no refresh loop).
 */

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createConsoleApiClient } from "./client";
import {
  createRefreshAuthority,
  createRefreshCoordinator,
  setRefreshCallbacks,
  singleFlightRefresh,
} from "./refresh";
import type { RefreshAuthority } from "./refresh";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// A minimal fake access token.
function fakeToken(id: string): string {
  const payload = btoa(JSON.stringify({ sub: id, roles: ["ADMIN"] }));
  return `header.${payload}.sig`;
}

const TOKEN_V1 = fakeToken("user-1");
const TOKEN_V2 = fakeToken("user-2");

/** Set up the module-level refresh callbacks before each test. */
function setupCallbacks({
  onRefresh,
  onUnauthenticated,
}: {
  onRefresh?: () => Promise<{ access_token: string }>;
  onUnauthenticated?: () => void;
}) {
  const authority = createRefreshAuthority(
    createRefreshCoordinator(),
    "test-session",
  );
  return setRefreshCallbacks(
    authority,
    onRefresh ?? (() => Promise.resolve({ access_token: TOKEN_V2 })),
    onUnauthenticated ?? (() => {}),
  );
}

// ── Test 1: 401 → single refresh → retry succeeds ────────────────────────────

describe("401 triggers refresh then successful retry", () => {
  it("returns the retried 200 response, calls refresh exactly once", async () => {
    const refreshCalled = vi.fn().mockResolvedValue({ access_token: TOKEN_V2 });
    const onUnauthenticated = vi.fn();
    const registration = setupCallbacks({
      onRefresh: refreshCalled,
      onUnauthenticated,
    });

    let callCount = 0;
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json(
          {
            access_token: TOKEN_V2,
            refresh_token: null,
            token_type: "Bearer",
            refresh_expires_at: "2099-01-01T00:00:00Z",
          },
          { status: 200 },
        ),
      ),
      http.get("*/api/v1/users", () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        return HttpResponse.json([]);
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1, registration.authority);
    const result = await client.GET("/api/v1/users", {
      params: { query: { include_inactive: false } },
    });

    // The retry succeeded — we should get a 200-range response with data.
    expect(result.response.status).toBe(200);
    // The original request was made once (401) and retried once (200) = 2 total.
    expect(callCount).toBe(2);
    // refreshCalled was invoked exactly once.
    expect(refreshCalled).toHaveBeenCalledTimes(1);
    // Session was NOT cleared since refresh succeeded.
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it("retains If-Match and AbortSignal when a mutating request crosses the 401 retry clone", async () => {
    let resolveRefresh!: (value: { access_token: string }) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const registration = setupCallbacks({
      onRefresh: () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
          markRefreshStarted();
        }),
    });
    let callCount = 0;
    const seenIfMatch: string[] = [];
    server.use(
      http.put("*/api/v1/ontology/object-types/work_order", ({ request }) => {
        callCount += 1;
        seenIfMatch.push(request.headers.get("if-match") ?? "");
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
    );
    const controller = new AbortController();
    const etag =
      '"ont-object-type-key:00000000000000000000000000000001:r7"';
    const request = createConsoleApiClient(
      TOKEN_V1,
      registration.authority,
    ).PUT("/api/v1/ontology/object-types/{key}", {
      params: {
        path: { key: "work_order" },
        header: { "If-Match": etag },
      },
      body: {
        stable_key: "work_order",
        title: "Work order",
        backing_kind: "instance",
        properties: [],
        links: [],
        actions: [],
        analytics: [],
      },
      signal: controller.signal,
    });
    await refreshStarted;
    controller.abort();
    resolveRefresh({ access_token: TOKEN_V2 });

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(callCount).toBe(1, "the aborted clone never reaches the network");
    expect(seenIfMatch).toEqual([etag]);
  });
});

// ── Test 2: Concurrent 401s share one refresh call (single-flight) ────────────

describe("concurrent 401s share one in-flight refresh", () => {
  it("calls the refresh endpoint exactly once for simultaneous 401 responses", async () => {
    let refreshCallCount = 0;

    // A refresh that resolves after a tick — giving time for concurrent calls
    // to pile up and hit the same in-flight Promise.
    const slowRefresh = vi.fn(async () => {
      refreshCallCount += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return { access_token: TOKEN_V2 };
    });

    const registration = setupCallbacks({ onRefresh: slowRefresh });

    let endpointCallCount = 0;
    server.use(
      http.get("*/api/v1/users", () => {
        endpointCallCount += 1;
        if (endpointCallCount <= 2) {
          // First two calls (the concurrent originals) return 401.
          return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        // Retries succeed.
        return HttpResponse.json([]);
      }),
      http.get("*/api/v1/branches", () => {
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
    );

    const clientA = createConsoleApiClient(TOKEN_V1, registration.authority);
    const clientB = createConsoleApiClient(TOKEN_V1, registration.authority);

    // Fire two concurrent requests that both get 401s.
    const [resultA, resultB] = await Promise.all([
      clientA.GET("/api/v1/users", {
        params: { query: { include_inactive: false } },
      }),
      clientB.GET("/api/v1/branches"),
    ]);

    // Both retries eventually succeeded (or at least got a non-undefined response).
    expect(resultA.response).toBeDefined();
    expect(resultB.response).toBeDefined();

    // The critical assertion: only ONE refresh call, not two.
    expect(refreshCallCount).toBe(1);
    expect(slowRefresh).toHaveBeenCalledTimes(1);
  });
});

// ── Test 3: Refresh failure clears the session ────────────────────────────────

describe("refresh failure clears session", () => {
  it("calls onUnauthenticated when the refresh endpoint returns 401", async () => {
    const onUnauthenticated = vi.fn();

    const registration = setupCallbacks({
      onRefresh: () => {
        // Simulate a refresh failure (refresh token expired / revoked).
        return Promise.reject(new Error("Refresh failed"));
      },
      onUnauthenticated,
    });

    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const client = createConsoleApiClient(TOKEN_V1, registration.authority);
    const result = await client.GET("/api/v1/users", {
      params: { query: { include_inactive: false } },
    });

    // The original 401 response is passed through when refresh fails.
    expect(result.response.status).toBe(401);
    // The session was cleared.
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });
});

// ── Test 4: Authenticated auth endpoints refresh/retry on 401 ────────────────

describe("authenticated auth endpoints use the 401-retry path", () => {
  it("refreshes and retries passkey enroll-handoff after a stale bearer 401", async () => {
    const refreshCalled = vi.fn().mockResolvedValue({ access_token: TOKEN_V2 });
    const registration = setupCallbacks({ onRefresh: refreshCalled });

    const handoffBody = {
      step_up: {
        ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        credential: { id: "step-up-credential" },
      },
    };
    let handoffCallCount = 0;
    const retryAuthorizationHeaders: string[] = [];
    const requestBodies: unknown[] = [];
    server.use(
      http.post(
        "*/api/v1/auth/passkey/enroll-handoff",
        async ({ request }) => {
          handoffCallCount += 1;
          requestBodies.push(await request.json());
          retryAuthorizationHeaders.push(
            request.headers.get("authorization") ?? "",
          );
          if (handoffCallCount === 1) {
            return HttpResponse.json(
              {
                error: { code: "unauthorized", message: "invalid bearer token" },
              },
              { status: 401 },
            );
          }
          return HttpResponse.json({
            otp: "QR-123456",
            enroll_url: "https://console.knllogistic.com/login#otp=QR-123456",
            expires_at: "2099-01-01T00:00:00Z",
            poll_token: "poll-token-redacted",
          });
        },
      ),
    );

    const client = createConsoleApiClient(TOKEN_V1, registration.authority);
    const result = await client.POST("/api/v1/auth/passkey/enroll-handoff", {
      body: handoffBody,
    });

    expect(result.response.status).toBe(200);
    expect(result.data?.enroll_url).toContain("/login#otp=");
    expect(handoffCallCount).toBe(2);
    expect(refreshCalled).toHaveBeenCalledTimes(1);
    expect(retryAuthorizationHeaders).toEqual([
      `Bearer ${TOKEN_V1}`,
      `Bearer ${TOKEN_V2}`,
    ]);
    expect(requestBodies).toEqual([handoffBody, handoffBody]);
  });
});

// ── Test 5: Primary auth endpoints are NOT retried on 401 ────────────────────

describe("primary auth endpoints skip the 401-retry path", () => {
  it("does not call refresh when the auth refresh endpoint itself returns 401", async () => {
    const refreshCalled = vi.fn().mockResolvedValue({ access_token: TOKEN_V2 });
    const registration = setupCallbacks({ onRefresh: refreshCalled });

    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const client = createConsoleApiClient(TOKEN_V1, registration.authority);
    const result = await client.POST("/api/v1/auth/token/refresh", {
      body: {},
    });

    // The 401 is returned as-is; no recursive refresh attempt.
    expect(result.response.status).toBe(401);
    // The interceptor must NOT have triggered refresh for an auth endpoint.
    expect(refreshCalled).not.toHaveBeenCalled();
  });
});


describe("refresh authority replacement regressions", () => {
  it("does not let a replacement authority join or receive the retired flight", async () => {
    const coordinator = createRefreshCoordinator();
    const authorityA = createRefreshAuthority(coordinator, "session-a");
    const authorityB = createRefreshAuthority(coordinator, "session-b");
    let resolveA!: (value: { access_token: string }) => void;
    const refreshA = vi.fn(
      () =>
        new Promise<{ access_token: string }>((resolve) => {
          resolveA = resolve;
        }),
    );
    const clearA = vi.fn();
    const refreshB = vi.fn().mockResolvedValue({ access_token: "token-b-fresh" });
    const clearB = vi.fn();

    const registrationA = setRefreshCallbacks(authorityA, refreshA, clearA);
    const resultA = singleFlightRefresh(authorityA);
    await vi.waitFor(() => {
      expect(refreshA).toHaveBeenCalledTimes(1);
    });

    registrationA.dispose();
    setRefreshCallbacks(authorityB, refreshB, clearB);
    const resultB = singleFlightRefresh(authorityB);
    resolveA({ access_token: "token-a-fresh" });

    await expect(resultA).rejects.toThrow(/retired/i);
    await expect(resultB).resolves.toBe("token-b-fresh");
    expect(refreshB).toHaveBeenCalledTimes(1);
    expect(clearA).not.toHaveBeenCalled();
    expect(clearB).not.toHaveBeenCalled();
  });

  it("does not invoke any failure handler for a retired authority", async () => {
    const coordinator = createRefreshCoordinator();
    const authorityA = createRefreshAuthority(coordinator, "session-a");
    const authorityB = createRefreshAuthority(coordinator, "session-b");
    let rejectA!: (reason: unknown) => void;
    const refreshA = vi.fn(
      () =>
        new Promise<{ access_token: string }>((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    const clearA = vi.fn();
    const clearB = vi.fn();

    const registrationA = setRefreshCallbacks(authorityA, refreshA, clearA);
    const resultA = singleFlightRefresh(authorityA);
    await vi.waitFor(() => {
      expect(refreshA).toHaveBeenCalledTimes(1);
    });

    registrationA.dispose();
    setRefreshCallbacks(
      authorityB,
      vi.fn().mockResolvedValue({ access_token: "token-b-fresh" }),
      clearB,
    );
    rejectA(new Error("retired A refresh failed"));

    await expect(resultA).rejects.toThrow("retired A refresh failed");
    expect(clearA).not.toHaveBeenCalled();
    expect(clearB).not.toHaveBeenCalled();
  });

  it("returns an explicit cleanup that invalidates the registration", async () => {
    const authority = createRefreshAuthority(
      createRefreshCoordinator(),
      "session-a",
    );
    const registration = setRefreshCallbacks(
      authority,
      vi.fn().mockResolvedValue({ access_token: "fresh" }),
      vi.fn(),
    );
    expect(registration.authority).toBe(authority);
    expect(registration.dispose).toEqual(expect.any(Function));
    registration.dispose();
    registration.dispose();
    await expect(singleFlightRefresh(authority)).rejects.toThrow(/registered/i);
  });

  it("never retries a replacement request with a retired authority bearer", async () => {
    const coordinator = createRefreshCoordinator();
    const authorityA = createRefreshAuthority(coordinator, "session-a");
    const authorityB = createRefreshAuthority(coordinator, "session-b");
    let resolveA!: (value: { access_token: string }) => void;
    let markRefreshAStarted!: () => void;
    const refreshAStarted = new Promise<void>((resolve) => {
      markRefreshAStarted = resolve;
    });
    const registrationA = setRefreshCallbacks(
      authorityA,
      vi.fn(
        () =>
          new Promise<{ access_token: string }>((resolve) => {
            resolveA = resolve;
            markRefreshAStarted();
          }),
      ),
      vi.fn(),
    );

    const retryHeaders: Record<string, string[]> = { a: [], b: [] };
    server.use(
      http.get("*/api/v1/users", ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        retryHeaders.a.push(authorization);
        return authorization === "Bearer token-a-fresh"
          ? HttpResponse.json([])
          : HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
      http.get("*/api/v1/branches", ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        retryHeaders.b.push(authorization);
        return authorization === "Bearer token-b-fresh"
          ? HttpResponse.json([])
          : HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
    );

    const requestA = createConsoleApiClient(
      "token-a-old",
      authorityA,
    ).GET("/api/v1/users", {
      params: { query: { include_inactive: false } },
    });
    await refreshAStarted;

    registrationA.dispose();
    const refreshB = vi.fn().mockResolvedValue({ access_token: "token-b-fresh" });
    setRefreshCallbacks(authorityB, refreshB, vi.fn());
    const requestB = createConsoleApiClient(
      "token-b-old",
      authorityB,
    ).GET("/api/v1/branches");
    resolveA({ access_token: "token-a-fresh" });

    const [responseA, responseB] = await Promise.all([requestA, requestB]);
    expect(responseA.response.status).toBe(401);
    expect(responseB.response.status).toBe(200);
    expect(refreshB).toHaveBeenCalledTimes(1);
    expect(retryHeaders.a).not.toContain("Bearer token-b-fresh");
    expect(retryHeaders.b).not.toContain("Bearer token-a-fresh");
  });

  it("keeps simultaneously mounted provider coordinators independent", async () => {
    const authorityA = createRefreshAuthority(
      createRefreshCoordinator(),
      "same-incarnation-label",
    );
    const authorityB = createRefreshAuthority(
      createRefreshCoordinator(),
      "same-incarnation-label",
    );
    const refreshA = vi.fn().mockResolvedValue({ access_token: "token-a" });
    const refreshB = vi.fn().mockResolvedValue({ access_token: "token-b" });
    setRefreshCallbacks(authorityA, refreshA, vi.fn());
    setRefreshCallbacks(authorityB, refreshB, vi.fn());

    await expect(singleFlightRefresh(authorityA)).resolves.toBe("token-a");
    await expect(singleFlightRefresh(authorityB)).resolves.toBe("token-b");
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).toHaveBeenCalledTimes(1);
  });
});

// Security regression coverage for M-001: runtime custody, not readable fields,
// decides whether a refresh authority is current.
describe("opaque refresh authority custody", () => {
  it("returns frozen opaque authorities without readable coordinator or registration identity", () => {
    const coordinator = createRefreshCoordinator();
    const registration = setRefreshCallbacks(
      coordinator as never,
      vi.fn().mockResolvedValue({ access_token: "opaque-token" }),
      vi.fn(),
    );

    expect(Object.isFrozen(coordinator)).toBe(true);
    expect(Object.isFrozen(registration.authority)).toBe(true);
    expect(Reflect.ownKeys(registration.authority)).toEqual([]);
    expect((registration.authority as unknown as Record<string, unknown>).coordinator).toBeUndefined();
    expect((registration.authority as unknown as Record<string, unknown>).incarnation).toBeUndefined();
    expect((registration.authority as unknown as Record<string, unknown>).registration).toBeUndefined();
  });

  it("rejects plain-object forgeries, copied fields, predictable labels, and unsafe mutation", async () => {
    const coordinator = createRefreshCoordinator();
    const seed = createRefreshAuthority(coordinator, "predictable-session-label");
    const registration = setRefreshCallbacks(
      seed,
      vi.fn().mockResolvedValue({ access_token: "real-token" }),
      vi.fn(),
    );
    const copied = Object.assign({}, registration.authority);
    const forged = {
      coordinator,
      incarnation: "predictable-session-label",
    } as unknown as RefreshAuthority;

    expect(Object.isFrozen(registration.authority)).toBe(true);
    expect(() => {
      (registration.authority as unknown as { incarnation?: string }).incarnation = "mutated";
    }).toThrow(TypeError);
    expect(() => singleFlightRefresh(copied)).toThrow(/authority/i);
    expect(() => singleFlightRefresh(forged)).toThrow(/authority/i);
    await expect(singleFlightRefresh(registration.authority)).resolves.toBe("real-token");
  });

  it("retires stale holders on re-registration and rejects disposed, cross-coordinator, and replayed holders", async () => {
    const coordinator = createRefreshCoordinator();
    const seed = createRefreshAuthority(coordinator, "legacy-seed");
    const first = setRefreshCallbacks(
      seed,
      vi.fn().mockResolvedValue({ access_token: "first-token" }),
      vi.fn(),
    );
    const second = setRefreshCallbacks(
      first.authority,
      vi.fn().mockResolvedValue({ access_token: "second-token" }),
      vi.fn(),
    );

    expect(second.authority).not.toBe(first.authority);
    await expect(singleFlightRefresh(first.authority)).rejects.toThrow(/retired|registered/i);
    await expect(singleFlightRefresh(second.authority)).resolves.toBe("second-token");
    expect(() =>
      setRefreshCallbacks(
        first.authority,
        vi.fn().mockResolvedValue({ access_token: "replayed-token" }),
        vi.fn(),
      ),
    ).toThrow(/retired|registration|authority/i);

    const isolated = setRefreshCallbacks(
      createRefreshCoordinator() as never,
      vi.fn().mockResolvedValue({ access_token: "isolated-token" }),
      vi.fn(),
    );
    expect(() =>
      setRefreshCallbacks(
        isolated.authority,
        vi.fn().mockResolvedValue({ access_token: "cross-token" }),
        vi.fn(),
      ),
    ).toThrow(/coordinator|registration|authority/i);

    second.dispose();
    second.dispose();
    await expect(singleFlightRefresh(second.authority)).rejects.toThrow(/registered|retired/i);
  });

  it("does not let a retired flight deliver a bearer, notify unauthenticated, or clear a newer flight", async () => {
    const coordinator = createRefreshCoordinator();
    let releaseRetired!: () => void;
    const retiredBarrier = new Promise<void>((resolve) => {
      releaseRetired = resolve;
    });
    const retiredUnauthenticated = vi.fn();
    const currentUnauthenticated = vi.fn();
    const retired = setRefreshCallbacks(
      coordinator as never,
      async () => {
        await retiredBarrier;
        return { access_token: "retired-token" };
      },
      retiredUnauthenticated,
    );
    const retiredFlight = singleFlightRefresh(retired.authority);
    retired.dispose();
    const current = setRefreshCallbacks(
      coordinator as never,
      vi.fn().mockResolvedValue({ access_token: "current-token" }),
      currentUnauthenticated,
    );
    const currentFlightA = singleFlightRefresh(current.authority);
    const currentFlightB = singleFlightRefresh(current.authority);

    expect(currentFlightA).toBe(currentFlightB);
    await expect(currentFlightA).resolves.toBe("current-token");
    releaseRetired();
    await expect(retiredFlight).rejects.toThrow(/retired/i);
    expect(retiredUnauthenticated).not.toHaveBeenCalled();
    expect(currentUnauthenticated).not.toHaveBeenCalled();
    await expect(singleFlightRefresh(current.authority)).resolves.toBe("current-token");
  });
});
