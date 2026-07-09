import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { NotificationSummary } from "./notificationsApi";
import {
  loadCounts,
  loadMessengerThreads,
  loadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  useCommsStore,
} from "./store";

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

beforeEach(() => {
  useCommsStore.getState().reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
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

describe("loadNotifications", () => {
  it("loads the feed and prefers the dedicated unread-count endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        const url = input;
        if (url.includes("unread-count")) {
          return Promise.resolve(new Response(JSON.stringify({ unread: 7 }), { status: 200 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: [notification({ id: "a" })], next_cursor: null }),
            { status: 200 },
          ),
        );
      }),
    );

    await loadNotifications("http://localhost", "token");

    const state = useCommsStore.getState();
    expect(state.notifications.map((n) => n.id)).toEqual(["a"]);
    expect(state.notificationUnread).toBe(7);
  });

  it("falls back to the page-derived count when unread-count is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        const url = input;
        if (url.includes("unread-count")) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [notification({ id: "a", unread: true }), notification({ id: "b", unread: false })],
              next_cursor: null,
            }),
            { status: 200 },
          ),
        );
      }),
    );

    await loadNotifications("http://localhost", "token");
    expect(useCommsStore.getState().notificationUnread).toBe(1);
  });

  it("never throws on a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network"))));
    await expect(loadNotifications("http://localhost", "token")).resolves.toBeUndefined();
  });
});

describe("mark-read thunks", () => {
  it("markNotificationRead updates locally then calls the endpoint", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    useCommsStore.getState().setNotifications([notification({ id: "a" })], 1);

    await markNotificationRead("http://localhost", "token", "a");

    expect(useCommsStore.getState().notificationUnread).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/v1/me/notifications/a/read",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("markAllNotificationsRead zeroes locally then calls read-all", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    useCommsStore.getState().setNotifications([notification({ id: "a" })], 1);

    await markAllNotificationsRead("http://localhost", "token");

    expect(useCommsStore.getState().notificationUnread).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/v1/me/notifications/read-all",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
