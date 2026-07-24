import type {
  MailThreadView,
  MessengerThreadSummary,
  NotificationSummary,
} from "../../api/types";

import type {
  CommsRailAction,
  CommsRailGeneration,
  CommsRailItem,
  CommsRailSource,
} from "./model";

export interface CommsRailResponse<T> {
  status: number;
  data: T | undefined;
}

export interface CommsRailApi {
  listMessengerThreads(signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  listMailThreads(signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  listNotifications(signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  listNotices(signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  markMessengerRead?(threadId: string, lastMessageId: string, signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  markMailRead?(threadId: string, signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  markNotificationRead?(notificationId: string, signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
}

export interface CommsRailOperations {
  listMessengerThreads(signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  listMailThreads(signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  listNotifications(signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  listNotices(signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  markMessengerRead?(threadId: string, lastMessageId: string, signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  markMailRead?(threadId: string, signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
  markNotificationRead?(notificationId: string, signal: AbortSignal): Promise<CommsRailResponse<unknown>>;
}

/** Adapts existing generated/current operation owners; it never creates auth transport. */
export function createCommsRailOperationApi(operations: CommsRailOperations): CommsRailApi {
  const markMessengerRead = operations.markMessengerRead?.bind(operations);
  const markMailRead = operations.markMailRead?.bind(operations);
  const markNotificationRead = operations.markNotificationRead?.bind(operations);
  return {
    listMessengerThreads: (signal) => operations.listMessengerThreads(signal),
    listMailThreads: (signal) => operations.listMailThreads(signal),
    listNotifications: (signal) => operations.listNotifications(signal),
    listNotices: (signal) => operations.listNotices(signal),
    markMessengerRead: markMessengerRead
      ? (threadId, lastMessageId, signal) => markMessengerRead(threadId, lastMessageId, signal) : undefined,
    markMailRead: markMailRead
      ? (threadId, signal) => markMailRead(threadId, signal) : undefined,
    markNotificationRead: markNotificationRead
      ? (notificationId, signal) => markNotificationRead(notificationId, signal) : undefined,
  };
}

export type DecodedRailResult =
  | { kind: "ok"; items: CommsRailItem[] }
  | { kind: "denied"; status: 401 | 403 }
  | { kind: "malformed" }
  | { kind: "error"; code: "network_error" | "server_error" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SCREENS = new Set(["overview", "messenger", "mail", "notifications", "board"]);
/**
 * Wire shape of the generated `NoticeSummary` response for `GET /api/v1/notices`.
 * The installed API client declaration has not yet exposed this schema, so keep the
 * compatibility type local while validating every field received at this boundary.
 */
interface NoticeSummary {
  id: string;
  code: string;
  author_user_id: string;
  title: string;
  body: string;
  status: "published";
  created_at: string;
  published_at: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function publishedNotices(value: unknown): NoticeSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => record(item) && validUuid(item.id) && validUuid(item.author_user_id) &&
    typeof item.code === "string" && typeof item.title === "string" && typeof item.body === "string" &&
    item.status === "published" && validTimestamp(item.created_at) && validTimestamp(item.published_at))
    ? value as NoticeSummary[]
    : undefined;
}

function decodeStatus<T>(response: CommsRailResponse<T>, decode: (value: T) => CommsRailItem[] | undefined): DecodedRailResult {
  if (response.status === 401 || response.status === 403) return { kind: "denied", status: response.status };
  if (response.status < 200 || response.status >= 300) return { kind: "error", code: "server_error" };
  const items = response.data === undefined ? undefined : decode(response.data);
  return items ? { kind: "ok", items } : { kind: "malformed" };
}

function messengerThreads(value: unknown): MessengerThreadSummary[] | undefined {
  if (!record(value) || !Array.isArray(value.items)) return undefined;
  return value.items.every((item) => record(item) && validUuid(item.id) && validUuid(item.branch_id) &&
    (item.kind === "channel" || item.kind === "direct") &&
    (item.visibility === "channel" || item.visibility === "direct") &&
    typeof item.muted === "boolean" && (item.title === null || typeof item.title === "string") &&
    (item.last_message_id === null || validUuid(item.last_message_id)) &&
    (item.last_message_at === null || validTimestamp(item.last_message_at)) &&
    finiteNonNegative(item.member_count) && finiteNonNegative(item.unread_count) && validTimestamp(item.created_at) && validTimestamp(item.updated_at))
    ? value.items as MessengerThreadSummary[]
    : undefined;
}

function mailThreads(value: unknown): MailThreadView[] | undefined {
  return Array.isArray(value) && value.every((item) => record(item) && validUuid(item.id) &&
    typeof item.subject === "string" && validTimestamp(item.last_message_at) &&
    finiteNonNegative(item.message_count) && finiteNonNegative(item.unread_count) &&
    typeof item.has_attachments === "boolean" && typeof item.is_flagged === "boolean")
    ? value as MailThreadView[]
    : undefined;
}

function notifications(value: unknown): NotificationSummary[] | undefined {
  if (!record(value) || !Array.isArray(value.items)) return undefined;
  return value.items.every((item) => record(item) && validUuid(item.id) && validUuid(item.recipient_user_id) &&
    typeof item.category === "string" && typeof item.kind === "string" && typeof item.text === "string" &&
    typeof item.unread === "boolean" && validTimestamp(item.created_at) &&
    (item.read_at === null || validTimestamp(item.read_at)) && (item.resolved_at === null || validTimestamp(item.resolved_at)) &&
    validNotificationLink(item.link)) ? value.items as NotificationSummary[] : undefined;
}

function validNotificationLink(value: unknown): boolean {
  if (!record(value) || typeof value.type !== "string") return false;
  return value.type === "screen" ? typeof value.screen === "string" :
    value.type === "object" && typeof value.kind === "string" && validUuid(value.id);
}

function safeNotificationTarget(notification: NotificationSummary): CommsRailItem["target"] | undefined {
  if (notification.link.type !== "screen" || !SAFE_SCREENS.has(notification.link.screen)) return undefined;
  const route = notification.link.screen === "notifications" ? "/notifications" : `/${notification.link.screen}`;
  return { kind: "full-screen", source: "notifications", id: notification.id, route };
}

export function decodeMessengerRail(response: CommsRailResponse<unknown>): DecodedRailResult {
  return decodeStatus(response, (value) => messengerThreads(value)?.map((thread) => ({
    id: thread.id, source: "messenger", occurredAt: thread.last_message_at ?? thread.updated_at,
    code: "messenger_thread", unread: thread.unread_count > 0,
    target: { kind: "inline", source: "messenger", id: thread.id },
    action: !thread.muted && thread.unread_count > 0 && thread.last_message_id
      ? { kind: "mark-messenger-read", threadId: thread.id, lastMessageId: thread.last_message_id } : undefined,
    title: thread.title, branchId: thread.branch_id, visibility: thread.visibility,
    unreadCount: thread.unread_count, muted: thread.muted, memberCount: thread.member_count,
  })));
}

export function decodeMailRail(response: CommsRailResponse<unknown>): DecodedRailResult {
  return decodeStatus(response, (value) => mailThreads(value)?.map((thread) => ({
    id: thread.id, source: "mail", occurredAt: thread.last_message_at, code: "mail_thread",
    unread: thread.unread_count > 0, target: { kind: "inline", source: "mail", id: thread.id },
    action: thread.unread_count > 0 ? { kind: "mark-mail-read", threadId: thread.id } : undefined,
    subject: thread.subject, unreadCount: thread.unread_count, messageCount: thread.message_count,
    hasAttachments: thread.has_attachments, flagged: thread.is_flagged,
  })));
}

export function decodeNotificationRail(response: CommsRailResponse<unknown>): DecodedRailResult {
  return decodeStatus(response, (value) => notifications(value)?.map((notification) => ({
    id: notification.id, source: "notifications", occurredAt: notification.created_at,
    code: "notification", unread: notification.unread, target: safeNotificationTarget(notification),
    action: notification.unread ? { kind: "mark-notification-read", notificationId: notification.id } : undefined,
    category: notification.category, notificationKind: (notification as NotificationSummary & { kind: string }).kind, text: notification.text,
  })));
}

export function decodeNoticeRail(response: CommsRailResponse<unknown>): DecodedRailResult {
  return decodeStatus(response, (value) => publishedNotices(value)?.map((notice) => ({
      id: notice.id, source: "notices", occurredAt: notice.published_at!,
      code: "notice", unread: false,
      target: { kind: "inline", source: "notices", id: notice.id },
      title: notice.title, status: "published" as const,
    })));
}

export async function loadCommsRailSource(
  api: CommsRailApi,
  source: CommsRailSource,
  generation: CommsRailGeneration,
  signal: AbortSignal,
): Promise<DecodedRailResult> {
  // Generation is intentionally accepted here so every adapter call site has an
  // explicit authority boundary.  The store owns comparison/discard semantics.
  void generation;
  try {
    switch (source) {
      case "messenger": return decodeMessengerRail(await api.listMessengerThreads(signal));
      case "mail": return decodeMailRail(await api.listMailThreads(signal));
      case "notifications": return decodeNotificationRail(await api.listNotifications(signal));
      case "notices": return decodeNoticeRail(await api.listNotices(signal));
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // Do not leak transport/server error details through a rail state.
    void error;
    return { kind: "error", code: "network_error" };
  }
}

export async function performCommsRailAction(
  api: CommsRailApi,
  action: CommsRailAction,
  signal: AbortSignal,
): Promise<{ kind: "ok" } | { kind: "denied"; status: 401 | 403 } | { kind: "error" } | { kind: "aborted" }> {
  try {
  let response: CommsRailResponse<unknown> | undefined;
  switch (action.kind) {
    case "mark-messenger-read": response = await api.markMessengerRead?.(action.threadId, action.lastMessageId, signal); break;
    case "mark-mail-read": response = await api.markMailRead?.(action.threadId, signal); break;
    case "mark-notification-read": response = await api.markNotificationRead?.(action.notificationId, signal); break;
  }
  if (!response || response.status < 200 || response.status >= 300) {
    return response?.status === 401 || response?.status === 403 ? { kind: "denied", status: response.status } : { kind: "error" };
  }
  return { kind: "ok" };
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return { kind: "aborted" };
    // Do not disclose rejected transport detail to the rail/view layer.
    void error;
    return { kind: "error" };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : record(error) && error.name === "AbortError";
}
