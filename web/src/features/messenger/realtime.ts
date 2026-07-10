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
