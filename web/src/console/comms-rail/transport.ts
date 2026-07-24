import type { ConsoleApiClient } from "../../api/client";

import type { CommsRailApi, CommsRailResponse } from "./adapters";

const NO_STORE = { "Cache-Control": "no-store, no-cache" } as const;

async function response<T>(request: Promise<{ data?: T; response: Response }>): Promise<CommsRailResponse<T>> {
  const result = await request;
  return { status: result.response.status, data: result.data };
}

/**
 * Authenticated generated-client transport for the communications rail.
 *
 * This is deliberately the only place the rail selects backend routes.  It
 * never creates a second client or credential boundary, and every read opts
 * out of browser/intermediary caching because the rail is principal-scoped.
 */
export function createAuthenticatedCommsRailApi(api: ConsoleApiClient): CommsRailApi {
  return {
    listMessengerThreads: (signal) => response(api.GET("/api/messenger/threads", {
      params: { query: { limit: 20 } }, headers: NO_STORE, signal,
    })),
    listMailThreads: (signal) => response(api.GET("/api/v1/mail/threads", {
      params: { query: { limit: 20 } }, headers: NO_STORE, signal,
    })),
    listNotifications: (signal) => response(api.GET("/api/v1/me/notifications", {
      params: { query: { limit: 20 } }, headers: NO_STORE, signal,
    })),
    listNotices: (signal) => response(api.GET("/api/v1/notices", {
      params: { query: { limit: 20 } }, headers: NO_STORE, signal,
    })),
    markMessengerRead: (threadId, lastMessageId, signal) => response(
      api.PUT("/api/messenger/threads/{threadId}/read-receipt", {
        params: { path: { threadId } }, body: { last_read_message_id: lastMessageId },
        headers: NO_STORE, signal,
      }),
    ),
    markMailRead: (threadId, signal) => response(api.PATCH("/api/v1/mail/threads/{id}/read-state", {
      params: { path: { id: threadId } }, body: { seen: true }, headers: NO_STORE, signal,
    })),
    markNotificationRead: (notificationId, signal) => response(api.POST("/api/v1/me/notifications/{id}/read", {
      params: { path: { id: notificationId } }, headers: NO_STORE, signal,
    })),
  };
}
