// The ONE comms store (UI-M2b). Owns the shell's aggregated unread counts, the
// personal notification feed, and the rail's own UI state — so the sidebar
// badges, the topbar bell, and the comms rail all read a single source instead
// of each re-fetching counts (the old Sidebar.loadCounts + Topbar bell dupes).
// Mutating messenger state reuses the messenger reducer verbatim.

import { create } from "zustand";

import type { ConsoleApiClient } from "../../api/client";
import {
  createMessengerState,
  messengerReducer,
  type MessengerAction,
  type MessengerState,
} from "../messenger/messenger-state";
import {
  fetchNotifications,
  fetchUnreadCount,
  postNotificationRead,
  postNotificationsReadAll,
  type NotificationSummary,
} from "./notificationsApi";

export interface CommsCounts {
  approvals: number;
  messenger: number;
  mail: number;
  supportOpen: number;
  supportUnread: number;
}

/** Which shell fetches are allowed for the current session (role/feature gated). */
export interface CommsGates {
  approvals: boolean;
  mail: boolean;
  support: boolean;
  messenger: boolean;
}

export type RailSection = "messenger" | "mail" | "notifications";

export type RailSubview =
  | { kind: "home" }
  | { kind: "thread"; threadId: string }
  | { kind: "mail"; threadId: string };

interface CommsState {
  counts: CommsCounts;
  messenger: MessengerState;
  notifications: NotificationSummary[];
  notificationUnread: number;

  // Rail UI. collapsedPref: user override — null means "auto" (follow viewport).
  collapsedPref: boolean | null;
  openSection: RailSection;
  subview: RailSubview;

  setCounts: (partial: Partial<CommsCounts>) => void;
  dispatchMessenger: (action: MessengerAction) => void;
  setNotifications: (items: NotificationSummary[], unread: number) => void;
  applyNotificationCreated: (notification: NotificationSummary) => void;
  markNotificationReadLocal: (id: string) => void;
  markAllNotificationsReadLocal: () => void;

  setCollapsedPref: (value: boolean | null) => void;
  toggleSection: (section: RailSection) => void;
  openRailToNotifications: () => void;
  setSubview: (subview: RailSubview) => void;
  reset: () => void;
}

const emptyCounts: CommsCounts = {
  approvals: 0,
  messenger: 0,
  mail: 0,
  supportOpen: 0,
  supportUnread: 0,
};

export const useCommsStore = create<CommsState>((set) => ({
  counts: emptyCounts,
  messenger: createMessengerState(),
  notifications: [],
  notificationUnread: 0,
  collapsedPref: null,
  openSection: "notifications",
  subview: { kind: "home" },

  setCounts: (partial) => {
    set((s) => ({ counts: { ...s.counts, ...partial } }));
  },
  dispatchMessenger: (action) => {
    set((s) => ({ messenger: messengerReducer(s.messenger, action) }));
  },
  setNotifications: (items, unread) => {
    set({ notifications: items, notificationUnread: Math.max(0, unread) });
  },
  applyNotificationCreated: (notification) => {
    set((s) => {
      if (s.notifications.some((n) => n.id === notification.id)) return s;
      return {
        notifications: [notification, ...s.notifications],
        notificationUnread: s.notificationUnread + (notification.unread ? 1 : 0),
      };
    });
  },
  markNotificationReadLocal: (id) => {
    set((s) => {
      let decrement = 0;
      const notifications = s.notifications.map((n) => {
        if (n.id === id && n.unread) {
          decrement = 1;
          return { ...n, unread: false, read_at: n.read_at ?? new Date().toISOString() };
        }
        return n;
      });
      return {
        notifications,
        notificationUnread: Math.max(0, s.notificationUnread - decrement),
      };
    });
  },
  markAllNotificationsReadLocal: () => {
    set((s) => ({
      notifications: s.notifications.map((n) =>
        n.unread
          ? { ...n, unread: false, read_at: n.read_at ?? new Date().toISOString() }
          : n,
      ),
      notificationUnread: 0,
    }));
  },

  setCollapsedPref: (value) => {
    set({ collapsedPref: value });
  },
  toggleSection: (section) => {
    set((s) => ({
      openSection: s.openSection === section ? s.openSection : section,
      subview: { kind: "home" },
    }));
  },
  openRailToNotifications: () => {
    set({ collapsedPref: false, openSection: "notifications", subview: { kind: "home" } });
  },
  setSubview: (subview) => {
    set({ subview });
  },
  reset: () => {
    set({
      counts: emptyCounts,
      messenger: createMessengerState(),
      notifications: [],
      notificationUnread: 0,
      collapsedPref: null,
      openSection: "notifications",
      subview: { kind: "home" },
    });
  },
}));

function sumThreadUnread(
  threads: { unread_count: number }[],
): number {
  return threads.reduce((sum, thread) => sum + Math.max(0, thread.unread_count), 0);
}

function isOpenSupportTicket(status: string): boolean {
  return status === "OPEN" || status === "IN_PROGRESS" || status === "ON_HOLD";
}

// ── Async thunks ────────────────────────────────────────────────────────────
// Kept out of the store so the pure setters above stay trivially testable. Each
// fetch is independently guarded — one endpoint failing never blanks the others.

export async function loadCounts(
  api: ConsoleApiClient,
  gates: CommsGates,
): Promise<void> {
  const next: Partial<CommsCounts> = {};
  await Promise.all([
    gates.approvals
      ? api
          .GET("/api/approval-items", { params: { query: { limit: 100, offset: 0 } } })
          .then((r) => {
            next.approvals = r.data?.total ?? r.data?.items.length ?? 0;
          })
          .catch(() => undefined)
      : Promise.resolve(),
    gates.mail
      ? api
          .GET("/api/v1/mail/folders")
          .then((r) => {
            next.mail =
              r.data?.reduce((sum, folder) => sum + Math.max(0, folder.unread_count), 0) ?? 0;
          })
          .catch(() => undefined)
      : Promise.resolve(),
    gates.support
      ? api
          .GET("/api/v1/support/tickets", {
            params: { query: { include_untriaged: true, limit: 100 } },
          })
          .then((r) => {
            const tickets = r.data?.items ?? [];
            next.supportOpen = tickets.filter((t) => isOpenSupportTicket(t.status)).length;
            next.supportUnread = tickets.filter(
              (t) => t.origin === "CUSTOMER" && isOpenSupportTicket(t.status),
            ).length;
          })
          .catch(() => undefined)
      : Promise.resolve(),
  ]);
  useCommsStore.getState().setCounts(next);
}

export async function loadMessengerThreads(api: ConsoleApiClient): Promise<void> {
  try {
    const r = await api.GET("/api/messenger/threads", { params: { query: { limit: 100 } } });
    if (!r.data) return;
    // Badge count is a plain sum of the raw payload (robust to partial thread
    // shapes); the reducer holds the full threads for the rail's thread rows.
    useCommsStore.getState().setCounts({ messenger: sumThreadUnread(r.data.items) });
    useCommsStore.getState().dispatchMessenger({
      type: "threadsLoaded",
      threads: r.data.items,
    });
  } catch {
    // best-effort; badge keeps its last value
  }
}

export async function loadNotifications(
  baseUrl: string,
  accessToken: string,
): Promise<void> {
  const page = await fetchNotifications(baseUrl, accessToken, 30);
  if (!page) return;
  const listUnread = page.items.filter((n) => n.unread).length;
  const exact = await fetchUnreadCount(baseUrl, accessToken);
  useCommsStore.getState().setNotifications(page.items, exact ?? listUnread);
}

export async function markNotificationRead(
  baseUrl: string,
  accessToken: string,
  id: string,
): Promise<void> {
  useCommsStore.getState().markNotificationReadLocal(id);
  // Mark-read is idempotent; a failed ack self-corrects on the next reload.
  await postNotificationRead(baseUrl, accessToken, id).catch(() => undefined);
}

export async function markAllNotificationsRead(
  baseUrl: string,
  accessToken: string,
): Promise<void> {
  useCommsStore.getState().markAllNotificationsReadLocal();
  await postNotificationsReadAll(baseUrl, accessToken).catch(() => undefined);
}
