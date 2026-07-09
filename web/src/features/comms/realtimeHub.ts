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
// resumes from the last message id seen. ponytail: fixed backoff (1s, 3s after a
// server-shutdown close); add exponential backoff if reconnect storms show up.
export function createRealtimeHub(
  socketFactory: SocketFactory = defaultFactory,
): RealtimeHub {
  const listeners = new Set<RealtimeListener>();
  let socket: Socket | undefined;
  let params: RealtimeParams | undefined;
  let lastMessageId: string | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function open() {
    if (!params) return;
    stopped = false;
    reconnectTimer = undefined;
    const active = socketFactory(
      buildMessengerWebSocketUrl(params.baseUrl, lastMessageId),
      params.accessToken ? ["bearer", params.accessToken] : undefined,
    );
    socket = active;
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
      // 1001 = server going away (shutdown); back off a little longer. Any other
      // close (incl. 1013 "try again later") reconnects with the resume cursor.
      const delay = event.code === 1001 ? 3000 : 1000;
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
