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
import { setRefreshCallbacks } from "./refresh";

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
  setRefreshCallbacks(
    onRefresh ??
      (() => Promise.resolve({ access_token: TOKEN_V2 })),
    onUnauthenticated ?? (() => {}),
  );
}

// ── Test 1: 401 → single refresh → retry succeeds ────────────────────────────

describe("401 triggers refresh then successful retry", () => {
  it("returns the retried 200 response, calls refresh exactly once", async () => {
    const refreshCalled = vi.fn().mockResolvedValue({ access_token: TOKEN_V2 });
    const onUnauthenticated = vi.fn();
    setupCallbacks({ onRefresh: refreshCalled, onUnauthenticated });

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

    const client = createConsoleApiClient(TOKEN_V1);
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

    setRefreshCallbacks(slowRefresh, () => {});

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

    const clientA = createConsoleApiClient(TOKEN_V1);
    const clientB = createConsoleApiClient(TOKEN_V1);

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

    setRefreshCallbacks(() => {
      // Simulate a refresh failure (refresh token expired / revoked).
      return Promise.reject(new Error("Refresh failed"));
    }, onUnauthenticated);

    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const client = createConsoleApiClient(TOKEN_V1);
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
    setupCallbacks({ onRefresh: refreshCalled });

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

    const client = createConsoleApiClient(TOKEN_V1);
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
    setupCallbacks({ onRefresh: refreshCalled });

    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    const result = await client.POST("/api/v1/auth/token/refresh", {
      body: {},
    });

    // The 401 is returned as-is; no recursive refresh attempt.
    expect(result.response.status).toBe(401);
    // The interceptor must NOT have triggered refresh for an auth endpoint.
    expect(refreshCalled).not.toHaveBeenCalled();
  });
});
