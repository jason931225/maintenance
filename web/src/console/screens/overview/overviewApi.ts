// Overview data access — the two REAL W1 person-scoped endpoints plus the
// notification feed. Scope is bound server-side from the caller's JWT/org (these
// paths take no scope query param — they fan in each source through its own
// deny-by-omission predicate), so correct wiring is just the bearer + cookie;
// mirrors createMessengerConsoleApi's requestJson exactly.

import type { NotificationSummary } from "../../../api/types";
import type {
  ActionInboxResponse,
  MailThreadSummary,
  NotificationCountsSummary,
} from "./overviewModel";

export interface OverviewApi {
  loadInbox(): Promise<ActionInboxResponse>;
  loadNotificationCounts(): Promise<NotificationCountsSummary>;
  loadNotifications(): Promise<NotificationSummary[]>;
  loadMailThreads(): Promise<MailThreadSummary[]>;
}

export function createOverviewApi(accessToken?: string): OverviewApi {
  return {
    loadInbox: () =>
      requestJson<ActionInboxResponse>("/api/v1/me/action-inbox", accessToken),
    loadNotificationCounts: () =>
      requestJson<NotificationCountsSummary>(
        "/api/v1/me/notifications/summary",
        accessToken,
      ),
    loadNotifications: async () =>
      (
        await requestJson<{ items: NotificationSummary[] }>(
          "/api/v1/me/notifications?limit=30",
          accessToken,
        )
      ).items,
    // Soft-fail: mail is a caller-scoped, licensable feature (MailUse) — a
    // 403/unavailable mailbox degrades to an empty 메일 rail panel rather than
    // failing the whole overview load (unlike the three REQUIRED sources above).
    loadMailThreads: () =>
      requestJson<MailThreadSummary[]>("/api/v1/mail/threads?unread=true&limit=5", accessToken).catch(
        () => [],
      ),
  };
}

async function requestJson<T>(path: string, accessToken?: string): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(path, { method: "GET", headers, credentials: "include" });
  if (!response.ok) {
    throw new Error(`overview request failed ${String(response.status)}`);
  }
  return (await response.json()) as T;
}
