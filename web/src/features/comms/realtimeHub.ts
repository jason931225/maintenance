import type { MessengerMessageSummary } from "../../api/types";
import { buildMessengerWebSocketUrl } from "../messenger/realtime";
import type { NotificationSummary } from "./notificationsApi";

// The one realtime channel (`GET /api/v1/ws`) carries both messenger traffic and
// personal notifications. Widen the event union past messenger-only so the comms
// runtime can fan out notification_created too.
export type RealtimeEvent =
  | { type: "message_posted"; message: MessengerMessageSummary }
  | { type: "notification_created"; notification: NotificationSummary };

export interface RealtimeParams {
  baseUrl: string;
  accessToken: string;
}

export type RealtimeListener = (event: RealtimeEvent) => void;

type Socket = Pick<WebSocket, "addEventListener" | "close">;
type SocketFactory = (url: string, protocols?: string[]) => Socket;

export interface RealtimeHub {
  subscribe: (
    params: RealtimeParams,
    listener: RealtimeListener,
    initialCursor?: string,
  ) => () => void;
  /** Test aid: drop all state (listeners, socket, cursor). */
  reset: () => void;
}

const defaultFactory: SocketFactory = (url, protocols) => {
  if (typeof WebSocket === "undefined") {
    return { addEventListener: () => undefined, close: () => undefined };
  }
  return new WebSocket(url, protocols);
};

// ponytail: ONE process-wide socket, ref-counted by subscriber. First subscriber
// opens it, last unsubscribe closes it — so the comms rail and MessengerPanel
// share a single /api/v1/ws connection instead of double-connecting. Reconnect
// resumes from the last message id seen, with exponential backoff (reset on a
// successful open) so a downed endpoint isn't hammered.
export function createRealtimeHub(
  socketFactory: SocketFactory = defaultFactory,
): RealtimeHub {
  const listeners = new Set<RealtimeListener>();
  let socket: Socket | undefined;
  let params: RealtimeParams | undefined;
  let lastMessageId: string | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reconnectAttempts = 0;

  function open() {
    if (!params) return;
    stopped = false;
    reconnectTimer = undefined;
    const active = socketFactory(
      buildMessengerWebSocketUrl(params.baseUrl, lastMessageId),
      params.accessToken ? ["bearer", params.accessToken] : undefined,
    );
    socket = active;
    active.addEventListener("open", () => {
      reconnectAttempts = 0;
    });
    active.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data !== "string") return;
      let parsed: RealtimeEvent;
      try {
        parsed = JSON.parse(data) as RealtimeEvent;
      } catch {
        return;
      }
      if (parsed.type === "message_posted") {
        lastMessageId = parsed.message.id;
      }
      for (const listener of [...listeners]) {
        listener(parsed);
      }
    });
    active.addEventListener("close", (event) => {
      socket = undefined;
      if (stopped || listeners.size === 0) return;
      // Exponential backoff from the resume cursor: a downed endpoint (or a
      // jsdom socket in tests that never connects) must not be hammered every
      // second. 1001 (server going away) starts a notch higher. Reset on a
      // successful open above. Cap ~30s.
      const base = event.code === 1001 ? 3000 : 1000;
      const delay = Math.min(base * 2 ** reconnectAttempts, 30_000);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(open, delay);
    });
  }

  function teardown() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    socket?.close();
    socket = undefined;
  }

  return {
    subscribe(next, listener, initialCursor) {
      params = next;
      if (initialCursor && !lastMessageId) {
        lastMessageId = initialCursor;
      }
      listeners.add(listener);
      if (!socket && !reconnectTimer) {
        open();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          teardown();
        }
      };
    },
    reset() {
      teardown();
      listeners.clear();
      params = undefined;
      lastMessageId = undefined;
      stopped = false;
    },
  };
}

export const realtimeHub = createRealtimeHub();
