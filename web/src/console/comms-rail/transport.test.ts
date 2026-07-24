import { describe, expect, it, vi } from "vitest";

import { createAuthenticatedCommsRailApi } from "./transport";

function result(data: unknown, status = 200) {
  return { data, response: new Response(null, { status }) };
}

describe("createAuthenticatedCommsRailApi", () => {
  it("uses only generated authenticated operations with no-store reads", async () => {
    const api = {
      GET: vi.fn(() => Promise.resolve(result({ items: [] }))),
      PUT: vi.fn(() => Promise.resolve(result({}))),
      PATCH: vi.fn(() => Promise.resolve(result({}))),
      POST: vi.fn(() => Promise.resolve(result({}))),
    } as never;
    const transport = createAuthenticatedCommsRailApi(api);
    const controller = new AbortController();

    await Promise.all([
      transport.listMessengerThreads(controller.signal),
      transport.listMailThreads(controller.signal),
      transport.listNotifications(controller.signal),
      transport.listNotices(controller.signal),
    ]);

    expect(api.GET).toHaveBeenNthCalledWith(1, "/api/messenger/threads", expect.objectContaining({
      headers: { "Cache-Control": "no-store, no-cache" }, signal: controller.signal,
    }));
    expect(api.GET).toHaveBeenNthCalledWith(2, "/api/v1/mail/threads", expect.objectContaining({
      headers: { "Cache-Control": "no-store, no-cache" }, signal: controller.signal,
    }));
    expect(api.GET).toHaveBeenNthCalledWith(3, "/api/v1/me/notifications", expect.objectContaining({
      headers: { "Cache-Control": "no-store, no-cache" }, signal: controller.signal,
    }));
    expect(api.GET).toHaveBeenNthCalledWith(4, "/api/v1/notices", expect.objectContaining({
      headers: { "Cache-Control": "no-store, no-cache" }, signal: controller.signal,
    }));
  });

  it("uses the three authoritative generated read-state mutations", async () => {
    const api = {
      GET: vi.fn(), PUT: vi.fn(() => Promise.resolve(result({}))), PATCH: vi.fn(() => Promise.resolve(result({}))), POST: vi.fn(() => Promise.resolve(result({}))),
    } as never;
    const transport = createAuthenticatedCommsRailApi(api);
    const controller = new AbortController();

    await transport.markMessengerRead?.("thread-id", "message-id", controller.signal);
    await transport.markMailRead?.("mail-id", controller.signal);
    await transport.markNotificationRead?.("notification-id", controller.signal);

    expect(api.PUT).toHaveBeenCalledWith("/api/messenger/threads/{threadId}/read-receipt", expect.objectContaining({
      params: { path: { threadId: "thread-id" } }, body: { last_read_message_id: "message-id" },
      headers: { "Cache-Control": "no-store, no-cache" }, signal: controller.signal,
    }));
    expect(api.PATCH).toHaveBeenCalledWith("/api/v1/mail/threads/{id}/read-state", expect.objectContaining({
      params: { path: { id: "mail-id" } }, body: { seen: true },
    }));
    expect(api.POST).toHaveBeenCalledWith("/api/v1/me/notifications/{id}/read", expect.objectContaining({
      params: { path: { id: "notification-id" } },
    }));
  });
});

