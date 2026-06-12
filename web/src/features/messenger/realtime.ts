import type { MessengerRealtimeEvent } from "./messenger-state";

export function buildMessengerWebSocketUrl(
  baseUrl: string,
  lastMessageId?: string,
) {
  const url = new URL("/api/v1/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (lastMessageId) {
    url.searchParams.set("last_message_id", lastMessageId);
  }
  return url.toString();
}

export interface MessengerRealtimeConnection {
  close: () => void;
}

export interface MessengerRealtimeOptions {
  baseUrl: string;
  accessToken?: string;
  lastMessageId?: string;
  onEvent: (event: MessengerRealtimeEvent) => void;
  onDisconnect?: () => void;
  webSocketFactory?: (
    url: string,
    protocols?: string | string[],
  ) => Pick<WebSocket, "addEventListener" | "close">;
}

export function connectMessengerRealtime({
  baseUrl,
  accessToken,
  lastMessageId,
  onEvent,
  onDisconnect,
  webSocketFactory = (url, protocols) => {
    if (typeof WebSocket === "undefined") {
      return {
        addEventListener: () => undefined,
        close: () => undefined,
      };
    }
    return new WebSocket(url, protocols);
  },
}: MessengerRealtimeOptions): MessengerRealtimeConnection {
  const protocols = accessToken ? ["bearer", accessToken] : undefined;
  const socket = webSocketFactory(
    buildMessengerWebSocketUrl(baseUrl, lastMessageId),
    protocols,
  );

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    const parsed = JSON.parse(event.data) as MessengerRealtimeEvent;
    onEvent(parsed);
  });
  socket.addEventListener("close", () => {
    onDisconnect?.();
  });

  return {
    close: () => {
      socket.close();
    },
  };
}
