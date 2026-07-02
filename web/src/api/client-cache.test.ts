import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "./client";
import { setRefreshCallbacks } from "./refresh";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

function fakeToken(id: string): string {
  const payload = btoa(JSON.stringify({ sub: id, roles: ["ADMIN"] }));
  return `header.${payload}.sig`;
}

function usersPayload(displayName: string) {
  return {
    items: [{ id: "u1", display_name: displayName, roles: ["ADMIN"] }],
    total: 1,
    limit: 200,
    offset: 0,
  };
}

const USERS_REQUEST = {
  params: { query: { include_inactive: false, limit: 200, offset: 0 } },
} as const;

const TOKEN_V1 = fakeToken("user-1");
const TOKEN_V2 = fakeToken("user-2");

async function flushBackgroundRefresh(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("console API read cache", () => {
  it("deduplicates concurrent GETs and reuses a fresh cached response for high-traffic CRUD lists", async () => {
    let calls = 0;
    server.use(
      http.get("*/api/v1/users", async () => {
        calls += 1;
        await delay(20);
        return HttpResponse.json({
          items: [{ id: "u1", display_name: "관리자", roles: ["ADMIN"] }],
          total: 1,
          limit: 200,
          offset: 0,
        });
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    const [first, second] = await Promise.all([
      client.GET("/api/v1/users", USERS_REQUEST),
      client.GET("/api/v1/users", USERS_REQUEST),
    ]);

    expect(first.data?.items).toHaveLength(1);
    expect(second.data?.items).toHaveLength(1);
    expect(calls).toBe(1);

    const cached = await client.GET("/api/v1/users", USERS_REQUEST);

    expect(cached.data?.items).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("evicts a stale cached CRUD list when background refresh returns no-store", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    let calls = 0;
    let resolveNoStoreRefresh!: () => void;
    const noStoreRefresh = new Promise<void>((resolve) => {
      resolveNoStoreRefresh = resolve;
    });

    server.use(
      http.get("*/api/v1/users", () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(usersPayload("cached roster"));
        }
        if (calls === 2) {
          resolveNoStoreRefresh();
          return HttpResponse.json(usersPayload("sensitive no-store roster"), {
            headers: { "Cache-Control": "no-store" },
          });
        }
        return HttpResponse.json(usersPayload("network roster after eviction"));
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    const first = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(first.data?.items[0]?.display_name).toBe("cached roster");

    vi.mocked(Date.now).mockReturnValue(31_000);
    const stale = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(stale.data?.items[0]?.display_name).toBe("cached roster");

    await noStoreRefresh;
    await flushBackgroundRefresh();
    expect(calls).toBe(2);

    vi.mocked(Date.now).mockReturnValue(31_100);
    const afterEviction = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(afterEviction.data?.items[0]?.display_name).toBe(
      "network roster after eviction",
    );
    expect(calls).toBe(3);
  });

  it("routes stale background 401 refresh through the single-flight path before updating protected cache", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const refreshCalled = vi.fn(() => Promise.resolve({ access_token: TOKEN_V2 }));
    const onUnauthenticated = vi.fn();
    setRefreshCallbacks(refreshCalled, onUnauthenticated);
    let calls = 0;
    let resolveRetriedRefresh!: () => void;
    const retriedRefresh = new Promise<void>((resolve) => {
      resolveRetriedRefresh = resolve;
    });

    server.use(
      http.get("*/api/v1/users", ({ request }) => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(usersPayload("cached protected roster"));
        }
        if (request.headers.get("Authorization") === `Bearer ${TOKEN_V2}`) {
          resolveRetriedRefresh();
          return HttpResponse.json(usersPayload("refreshed protected roster"));
        }
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    const first = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(first.data?.items[0]?.display_name).toBe("cached protected roster");

    vi.mocked(Date.now).mockReturnValue(31_000);
    const stale = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(stale.data?.items[0]?.display_name).toBe("cached protected roster");

    await flushBackgroundRefresh();
    expect(refreshCalled).toHaveBeenCalledTimes(1);
    await retriedRefresh;
    await flushBackgroundRefresh();
    expect(onUnauthenticated).not.toHaveBeenCalled();

    vi.mocked(Date.now).mockReturnValue(31_100);
    const refreshed = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(refreshed.data?.items[0]?.display_name).toBe(
      "refreshed protected roster",
    );
    expect(calls).toBe(3);
  });

  it("does not reuse a fresh cached CRUD list after a same-client mutation", async () => {
    let userListCalls = 0;
    let deactivateCalls = 0;
    server.use(
      http.get("*/api/v1/users", () => {
        userListCalls += 1;
        return HttpResponse.json(
          usersPayload(
            userListCalls === 1
              ? "cached roster"
              : "fresh roster after mutation",
          ),
        );
      }),
      http.post("*/api/v1/users/:id/deactivate", () => {
        deactivateCalls += 1;
        return HttpResponse.json({
          id: "u1",
          display_name: "cached roster",
          roles: ["ADMIN"],
          is_active: false,
        });
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    const first = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(first.data?.items[0]?.display_name).toBe("cached roster");

    const cached = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(cached.data?.items[0]?.display_name).toBe("cached roster");
    expect(userListCalls).toBe(1);

    await client.POST("/api/v1/users/{id}/deactivate", {
      params: { path: { id: "u1" } },
    });
    expect(deactivateCalls).toBe(1);

    const reloaded = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(reloaded.data?.items[0]?.display_name).toBe(
      "fresh roster after mutation",
    );
    expect(userListCalls).toBe(2);
  });

  it("does not let an in-flight pre-mutation read repopulate the cache", async () => {
    let userListCalls = 0;
    let deactivateCalls = 0;
    let firstReadStarted!: () => void;
    let resolveFirstRead!: () => void;
    const firstReadStartedPromise = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    const firstReadGate = new Promise<void>((resolve) => {
      resolveFirstRead = resolve;
    });

    server.use(
      http.get("*/api/v1/users", async () => {
        userListCalls += 1;
        if (userListCalls === 1) {
          firstReadStarted();
          await firstReadGate;
          return HttpResponse.json(usersPayload("stale roster before mutation"));
        }
        return HttpResponse.json(usersPayload("fresh roster after mutation"));
      }),
      http.post("*/api/v1/users/:id/deactivate", () => {
        deactivateCalls += 1;
        return HttpResponse.json({
          id: "u1",
          display_name: "stale roster before mutation",
          roles: ["ADMIN"],
          is_active: false,
        });
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    const firstRead = client.GET("/api/v1/users", USERS_REQUEST);
    await firstReadStartedPromise;

    await client.POST("/api/v1/users/{id}/deactivate", {
      params: { path: { id: "u1" } },
    });
    expect(deactivateCalls).toBe(1);

    resolveFirstRead();
    const staleOriginalRead = await firstRead;
    expect(staleOriginalRead.data?.items[0]?.display_name).toBe(
      "stale roster before mutation",
    );

    const reloaded = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(reloaded.data?.items[0]?.display_name).toBe(
      "fresh roster after mutation",
    );
    expect(userListCalls).toBe(2);
  });

  it("ignores stale background refresh responses that finish after a mutation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    let userListCalls = 0;
    let deactivateCalls = 0;
    let backgroundRefreshStarted!: () => void;
    let resolveBackgroundRefresh!: () => void;
    const backgroundRefreshStartedPromise = new Promise<void>((resolve) => {
      backgroundRefreshStarted = resolve;
    });
    const backgroundRefreshGate = new Promise<void>((resolve) => {
      resolveBackgroundRefresh = resolve;
    });

    server.use(
      http.get("*/api/v1/users", async () => {
        userListCalls += 1;
        if (userListCalls === 1) {
          return HttpResponse.json(usersPayload("cached roster"));
        }
        if (userListCalls === 2) {
          backgroundRefreshStarted();
          await backgroundRefreshGate;
          return HttpResponse.json(usersPayload("background stale roster"));
        }
        return HttpResponse.json(usersPayload("fresh roster after mutation"));
      }),
      http.post("*/api/v1/users/:id/deactivate", () => {
        deactivateCalls += 1;
        return HttpResponse.json({
          id: "u1",
          display_name: "cached roster",
          roles: ["ADMIN"],
          is_active: false,
        });
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    const first = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(first.data?.items[0]?.display_name).toBe("cached roster");

    vi.mocked(Date.now).mockReturnValue(31_000);
    const stale = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(stale.data?.items[0]?.display_name).toBe("cached roster");
    await backgroundRefreshStartedPromise;

    await client.POST("/api/v1/users/{id}/deactivate", {
      params: { path: { id: "u1" } },
    });
    expect(deactivateCalls).toBe(1);

    resolveBackgroundRefresh();
    await flushBackgroundRefresh();

    vi.mocked(Date.now).mockReturnValue(31_100);
    const reloaded = await client.GET("/api/v1/users", USERS_REQUEST);
    expect(reloaded.data?.items[0]?.display_name).toBe(
      "fresh roster after mutation",
    );
    expect(userListCalls).toBe(3);
  });

  it("clears pending read misses after an initial network error so callers can retry", async () => {
    let calls = 0;
    server.use(
      http.get("*/api/v1/users", () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.error();
        }
        return HttpResponse.json(usersPayload("retry roster"));
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    await expect(client.GET("/api/v1/users", USERS_REQUEST)).rejects.toThrow();

    const retry = await Promise.race([
      client.GET("/api/v1/users", USERS_REQUEST),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => {
          resolve("timed-out");
        }, 50);
      }),
    ]);

    if (retry === "timed-out") {
      throw new Error("retry hung on stale pending read state");
    }
    expect(retry.data?.items[0]?.display_name).toBe("retry roster");
    expect(calls).toBe(2);
  });

  it("keeps auth, downloads, exports, attachment responses, and other client sessions outside the cache", async () => {
    let authCalls = 0;
    let downloadCalls = 0;
    let exportCalls = 0;
    let attachmentResponseCalls = 0;
    let tenantScopedCalls = 0;

    server.use(
      http.get("*/api/v1/auth/passkeys", () => {
        authCalls += 1;
        return HttpResponse.json({ items: [], call: authCalls });
      }),
      http.get("*/api/v1/mail/attachments/:id/download", () => {
        downloadCalls += 1;
        return HttpResponse.json({
          download_url: `https://files/${String(downloadCalls)}`,
        });
      }),
      http.get("*/api/v1/exports/work-diary", () => {
        exportCalls += 1;
        return HttpResponse.json({
          export_url: `https://exports/${String(exportCalls)}`,
        });
      }),
      http.get("*/api/v1/branches", () => {
        attachmentResponseCalls += 1;
        return HttpResponse.json(
          { items: [], call: attachmentResponseCalls },
          {
            headers: {
              "Content-Disposition": 'attachment; filename="branches.json"',
            },
          },
        );
      }),
      http.get("*/api/v1/users", () => {
        tenantScopedCalls += 1;
        return HttpResponse.json({ items: [], call: tenantScopedCalls });
      }),
    );

    const client = createConsoleApiClient(TOKEN_V1);
    await client.GET("/api/v1/auth/passkeys");
    await client.GET("/api/v1/auth/passkeys");
    expect(authCalls).toBe(2);

    await client.GET("/api/v1/mail/attachments/{id}/download", {
      params: { path: { id: "a1" } },
    });
    await client.GET("/api/v1/mail/attachments/{id}/download", {
      params: { path: { id: "a1" } },
    });
    expect(downloadCalls).toBe(2);

    await client.GET("/api/v1/exports/work-diary", {
      params: { query: { date: "2026-06-12" } },
    });
    await client.GET("/api/v1/exports/work-diary", {
      params: { query: { date: "2026-06-12" } },
    });
    expect(exportCalls).toBe(2);

    await client.GET("/api/v1/branches");
    await client.GET("/api/v1/branches");
    expect(attachmentResponseCalls).toBe(2);

    const tenantAClient = createConsoleApiClient(TOKEN_V1);
    const tenantBClient = createConsoleApiClient(TOKEN_V2);
    await tenantAClient.GET("/api/v1/users", USERS_REQUEST);
    await tenantBClient.GET("/api/v1/users", USERS_REQUEST);
    expect(tenantScopedCalls).toBe(2);
  });
});
