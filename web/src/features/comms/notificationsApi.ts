// Notifications HTTP surface, typed locally.
//
// TODO(client-regen): the notifications REST (#198) + the unread-count endpoint
// land in the generated OpenAPI client (`@maintenance/api-client-ts`) after a
// schema regen. Until this branch's client is rebuilt, these paths/types are not
// in `components["schemas"]` / `paths`, so we hand-roll the calls against
// baseUrl+bearer. Once the client carries them, swap these for
// `api.GET("/api/v1/me/notifications")` etc. and delete the local types.

export interface NotificationLinkObject {
  type: "object";
  kind: string;
  id: string;
}
export interface NotificationLinkScreen {
  type: "screen";
  screen: string;
}
export type NotificationLink = NotificationLinkObject | NotificationLinkScreen;

export interface NotificationSummary {
  id: string;
  recipient_user_id: string;
  /** Extensible category (결재/멘션/문서/공지/근태/급여 and beyond). */
  category: string;
  text: string;
  link: NotificationLink;
  unread: boolean;
  created_at: string;
  read_at: string | null;
}

export interface NotificationPage {
  items: NotificationSummary[];
  next_cursor: string | null;
}

// Returns null on any transport failure — a notification call failing must never
// crash the shell or surface as an unhandled rejection.
async function notificationsFetch(
  baseUrl: string,
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  try {
    return await fetch(new URL(path, baseUrl).toString(), {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    });
  } catch {
    return null;
  }
}

export async function fetchNotifications(
  baseUrl: string,
  accessToken: string,
  limit = 30,
): Promise<NotificationPage | null> {
  const res = await notificationsFetch(
    baseUrl,
    accessToken,
    `/api/v1/me/notifications?limit=${String(limit)}`,
  );
  if (!res?.ok) return null;
  try {
    return (await res.json()) as NotificationPage;
  } catch {
    return null;
  }
}

export async function fetchUnreadCount(
  baseUrl: string,
  accessToken: string,
): Promise<number | null> {
  const res = await notificationsFetch(
    baseUrl,
    accessToken,
    "/api/v1/me/notifications/unread-count",
  );
  if (!res?.ok) return null;
  try {
    const data = (await res.json()) as { unread?: number };
    return typeof data.unread === "number" ? data.unread : null;
  } catch {
    return null;
  }
}

export async function postNotificationRead(
  baseUrl: string,
  accessToken: string,
  id: string,
): Promise<void> {
  await notificationsFetch(
    baseUrl,
    accessToken,
    `/api/v1/me/notifications/${encodeURIComponent(id)}/read`,
    { method: "POST" },
  );
}

export async function postNotificationsReadAll(
  baseUrl: string,
  accessToken: string,
): Promise<void> {
  await notificationsFetch(baseUrl, accessToken, "/api/v1/me/notifications/read-all", {
    method: "POST",
  });
}
