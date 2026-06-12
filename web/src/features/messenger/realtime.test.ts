import { describe, expect, it } from "vitest";

import { buildMessengerWebSocketUrl } from "./realtime";

describe("buildMessengerWebSocketUrl", () => {
  it("uses the realtime route and passes the last processed message cursor on reconnect", () => {
    const url = buildMessengerWebSocketUrl(
      "https://console.example.com",
      "55555555-5555-4555-8555-555555555555",
    );

    expect(url).toBe(
      "wss://console.example.com/api/v1/ws?last_message_id=55555555-5555-4555-8555-555555555555",
    );
  });

  it("does not invent a cursor on first connection", () => {
    expect(buildMessengerWebSocketUrl("http://localhost:8080")).toBe(
      "ws://localhost:8080/api/v1/ws",
    );
  });
});
