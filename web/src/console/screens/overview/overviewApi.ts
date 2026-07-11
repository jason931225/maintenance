// Overview data access — the two REAL W1 person-scoped endpoints plus the
// notification feed. Scope is bound server-side from the caller's JWT/org (these
// paths take no scope query param — they fan in each source through its own
// deny-by-omission predicate), so correct wiring is just the bearer + cookie;
// mirrors createMessengerConsoleApi's requestJson exactly.

import type { NotificationSummary } from "../../../api/types";
import type {
  ActionInboxResponse,
  EmployeeAttendanceRecord,
  MailThreadSummary,
  NotificationCountsSummary,
} from "./overviewModel";

export interface OverviewApi {
  loadInbox(): Promise<ActionInboxResponse>;
  /** Soft-fail self-service attendance backing the 출근 chip. Optional so a
   *  test double can omit it; non-employee/HR-less callers 403 → []. */
  loadMyAttendance?(): Promise<EmployeeAttendanceRecord[]>;
}

/** The comms rail's own data needs — shared by the shell-level rail (every
 * screen) and composed into `createOverviewApi` below (the overview screen's
 * action-inbox load has no overlap with these, but historically shared one
 * Promise.all; the shell rail now owns this fetch independently). */
export interface CommsRailApi {
  loadNotificationCounts(): Promise<NotificationCountsSummary>;
  loadNotifications(): Promise<NotificationSummary[]>;
  loadMailThreads(): Promise<MailThreadSummary[]>;
  /** 모두 읽음 — mark every unread notification read (server-scoped to the caller). */
  markAllNotificationsRead(): Promise<void>;
}

export function createCommsRailApi(accessToken?: string): CommsRailApi {
  return {
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
    // failing the whole rail load (unlike the two REQUIRED sources above).
    loadMailThreads: () =>
      requestJson<MailThreadSummary[]>("/api/v1/mail/threads?unread=true&limit=5", accessToken).catch(
        () => [],
      ),
    markAllNotificationsRead: () =>
      requestVoid("/api/v1/me/notifications/read-all", accessToken),
  };
}

export function createOverviewApi(accessToken?: string): OverviewApi {
  return {
    loadInbox: () =>
      requestJson<ActionInboxResponse>("/api/v1/me/action-inbox", accessToken),
    // Soft-fail like the mail rail: attendance is a self-service HR read the
    // caller may not be entitled to (403) or may have no linked employee row —
    // the 출근 chip then simply doesn't render.
    loadMyAttendance: () =>
      requestJson<{ items: EmployeeAttendanceRecord[] }>(
        "/api/v1/hr/attendance-records/me?limit=20",
        accessToken,
      )
        .then((page) => page.items)
        .catch(() => []),
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

/** POST with no response body (idempotent mutations like read-all). */
async function requestVoid(path: string, accessToken?: string): Promise<void> {
  const headers = new Headers();
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(path, { method: "POST", headers, credentials: "include" });
  if (!response.ok) {
    throw new Error(`overview request failed ${String(response.status)}`);
  }
}
