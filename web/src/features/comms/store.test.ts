import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient, type ConsoleApiClient } from "../../api/client";
import { setRefreshCallbacks } from "../../api/refresh";
import type { NotificationSummary } from "../../api/types";
import {
  loadCounts,
  loadMessengerThreads,
  loadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  useCommsStore,
} from "./store";

const server = setupServer();

function fakeToken(id: string): string {
  const payload = btoa(JSON.stringify({ sub: id, roles: ["ADMIN"] }));
  return `header.${payload}.sig`;
}
const TOKEN_V1 = fakeToken("token-v1");
const TOKEN_V2 = fakeToken("token-v2");

function mockApi(responses: Record<string, unknown>): ConsoleApiClient {
  return {
    GET: vi.fn((path: string) =>
      Promise.resolve({ data: responses[path], error: undefined, response: new Response() }),
    ),
  } as unknown as ConsoleApiClient;
}

function notification(overrides: Partial<NotificationSummary> = {}): NotificationSummary {
  return {
    id: overrides.id ?? "n1",
    recipient_user_id: "u1",
    category: "결재",
    text: "결재 요청",
    link: { type: "screen", screen: "approvals" },
    unread: overrides.unread ?? true,
    created_at: "2026-07-08T00:00:00Z",
    read_at: null,
    ...overrides,
  };
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  useCommsStore.getState().reset();
});
afterEach(() => {
  server.resetHandlers();
  setRefreshCallbacks(
    () => Promise.reject(new Error("unexpected refresh callback")),
    () => {},
  );
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

describe("comms store setters", () => {
  it("applyNotificationCreated prepends and bumps unread, deduping by id", () => {
    const store = useCommsStore.getState();
    store.applyNotificationCreated(notification({ id: "a" }));
    store.applyNotificationCreated(notification({ id: "b" }));
    store.applyNotificationCreated(notification({ id: "a" })); // duplicate

    const state = useCommsStore.getState();
    expect(state.notifications.map((n) => n.id)).toEqual(["b", "a"]);
    expect(state.notificationUnread).toBe(2);
  });

  it("markNotificationReadLocal clears one and decrements", () => {
    useCommsStore.getState().setNotifications(
      [notification({ id: "a" }), notification({ id: "b" })],
      2,
    );
    useCommsStore.getState().markNotificationReadLocal("a");

    const state = useCommsStore.getState();
    expect(state.notifications.find((n) => n.id === "a")?.unread).toBe(false);
    expect(state.notificationUnread).toBe(1);
  });

  it("markAllNotificationsReadLocal zeroes the count", () => {
    useCommsStore.getState().setNotifications(
      [notification({ id: "a" }), notification({ id: "b" })],
      2,
    );
    useCommsStore.getState().markAllNotificationsReadLocal();

    const state = useCommsStore.getState();
    expect(state.notifications.every((n) => !n.unread)).toBe(true);
    expect(state.notificationUnread).toBe(0);
  });
});

describe("loadCounts", () => {
  it("aggregates approvals, mail, and support counts", async () => {
    await loadCounts(
      mockApi({
        "/api/approval-items": { total: 3, items: [] },
        "/api/v1/mail/folders": [{ unread_count: 4 }, { unread_count: 1 }],
        "/api/v1/support/tickets": {
          items: [
            { status: "OPEN", origin: "CUSTOMER" },
            { status: "ON_HOLD", origin: "INTERNAL" },
            { status: "CLOSED", origin: "CUSTOMER" },
          ],
        },
      }),
      { approvals: true, mail: true, support: true, messenger: true },
    );

    expect(useCommsStore.getState().counts).toMatchObject({
      approvals: 3,
      mail: 5,
      supportOpen: 2,
      supportUnread: 1,
    });
  });

  it("skips fetches for ungranted surfaces", async () => {
    const api = mockApi({});
    await loadCounts(api, {
      approvals: false,
      mail: false,
      support: false,
      messenger: false,
    });
    expect(api.GET).not.toHaveBeenCalled();
  });
});

describe("loadMessengerThreads", () => {
  it("sets the messenger badge from the summed unread counts", async () => {
    await loadMessengerThreads(
      mockApi({
        "/api/messenger/threads": {
          items: [{ unread_count: 2 }, { unread_count: 3 }, { unread_count: 0 }],
        },
      }),
    );
    expect(useCommsStore.getState().counts.messenger).toBe(5);
  });
});

// These thunks now route through the shared typed client (createConsoleApiClient)
// instead of a hand-rolled fetch, restoring its single-flight 401 refresh and the
// X-Auth-Transport cookie header (issue #219). The tests drive the REAL client
// against a mocked network so the refresh/retry middleware actually runs.
describe("loadNotifications", () => {
  it("loads the feed via the typed client and prefers the unread-count endpoint", async () => {
    server.use(
      http.get("*/api/v1/me/notifications", () =>
        HttpResponse.json({ items: [notification({ id: "a" })], next_cursor: null }),
      ),
      http.get("*/api/v1/me/notifications/unread-count", () =>
        HttpResponse.json({ unread: 7 }),
      ),
    );

    await loadNotifications(createConsoleApiClient(TOKEN_V1));

    const state = useCommsStore.getState();
    expect(state.notifications.map((n) => n.id)).toEqual(["a"]);
    expect(state.notificationUnread).toBe(7);
  });

  it("falls back to the page-derived count when unread-count is unavailable", async () => {
    server.use(
      http.get("*/api/v1/me/notifications", () =>
        HttpResponse.json({
          items: [
            notification({ id: "a", unread: true }),
            notification({ id: "b", unread: false }),
          ],
          next_cursor: null,
        }),
      ),
      http.get("*/api/v1/me/notifications/unread-count", () =>
        HttpResponse.json({ error: "nope" }, { status: 503 }),
      ),
    );

    await loadNotifications(createConsoleApiClient(TOKEN_V1));
    expect(useCommsStore.getState().notificationUnread).toBe(1);
  });

  it("never throws on a transport failure", async () => {
    server.use(http.get("*/api/v1/me/notifications", () => HttpResponse.error()));
    await expect(
      loadNotifications(createConsoleApiClient(TOKEN_V1)),
    ).resolves.toBeUndefined();
  });
});

describe("mark-read thunks", () => {
  it("markNotificationRead updates locally then POSTs via the typed client with the cookie transport header", async () => {
    let transport: string | null = null;
    server.use(
      http.post("*/api/v1/me/notifications/:id/read", ({ request, params }) => {
        transport = request.headers.get("X-Auth-Transport");
        return HttpResponse.json(notification({ id: String(params.id), unread: false }));
      }),
    );
    useCommsStore.getState().setNotifications([notification({ id: "a" })], 1);

    await markNotificationRead(createConsoleApiClient(TOKEN_V1), "a");

    expect(useCommsStore.getState().notificationUnread).toBe(0);
    // The shared client opts into the refresh-cookie transport — the hand-rolled
    // adapter never sent this, so the backend couldn't set the HttpOnly cookie.
    expect(transport).toBe("cookie");
  });

  it("refreshes the token and retries once when a mark-read POST 401s", async () => {
    const refresh = vi.fn(() => Promise.resolve({ access_token: TOKEN_V2 }));
    setRefreshCallbacks(refresh, () => {});
    const bearers: string[] = [];
    let attempts = 0;
    server.use(
      http.post("*/api/v1/me/notifications/:id/read", ({ request }) => {
        attempts += 1;
        bearers.push(request.headers.get("Authorization") ?? "");
        if (attempts === 1) {
          return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        return HttpResponse.json(notification({ id: "a", unread: false }));
      }),
    );
    useCommsStore.getState().setNotifications([notification({ id: "a" })], 1);

    await markNotificationRead(createConsoleApiClient(TOKEN_V1), "a");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
    expect(bearers).toEqual([`Bearer ${TOKEN_V1}`, `Bearer ${TOKEN_V2}`]);
  });

  it("markAllNotificationsRead zeroes locally then POSTs read-all via the typed client", async () => {
    let called = 0;
    server.use(
      http.post("*/api/v1/me/notifications/read-all", () => {
        called += 1;
        return HttpResponse.json({ marked: 3 });
      }),
    );
    useCommsStore.getState().setNotifications([notification({ id: "a" })], 1);

    await markAllNotificationsRead(createConsoleApiClient(TOKEN_V1));

    expect(useCommsStore.getState().notificationUnread).toBe(0);
    expect(called).toBe(1);
  });
});
