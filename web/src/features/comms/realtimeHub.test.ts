import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRealtimeHub, type RealtimeEvent } from "./realtimeHub";

interface FakeSocket {
  url: string;
  protocols?: string[];
  closed: boolean;
  emitMessage: (data: unknown) => void;
  emitClose: (code: number) => void;
  addEventListener: (type: string, cb: (event: unknown) => void) => void;
  close: () => void;
}

function fakeFactory() {
  const sockets: FakeSocket[] = [];
  const factory = (url: string, protocols?: string[]) => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const socket: FakeSocket = {
      url,
      protocols,
      closed: false,
      addEventListener: (type, cb) => {
        handlers[type] = cb;
      },
      close: () => {
        socket.closed = true;
      },
      emitMessage: (data) => {
        handlers.message({ data });
      },
      emitClose: (code) => {
        handlers.close({ code });
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

const params = { baseUrl: "https://console.example.com", accessToken: "tok" };

function messageEvent(id: string): RealtimeEvent {
  return {
    type: "message_posted",
    message: {
      id,
      thread_id: "t1",
      branch_id: "b1",
      sender_id: "s1",
      sender_name: "s",
      body: "hi",
      attachment_evidence_ids: [],
      read_count: 0,
      read_target_count: 0,
      sent_at: "2026-07-08T00:00:00Z",
      created_at: "2026-07-08T00:00:00Z",
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("realtimeHub", () => {
  it("opens one socket for multiple subscribers and fans out events", () => {
    const { factory, sockets } = fakeFactory();
    const hub = createRealtimeHub(factory);
    const a = vi.fn();
    const b = vi.fn();

    hub.subscribe(params, a);
    hub.subscribe(params, b);
    expect(sockets).toHaveLength(1);

    const event: RealtimeEvent = {
      type: "notification_created",
      notification: {
        id: "x",
        recipient_user_id: "u",
        category: "결재",
        text: "t",
        link: { type: "screen", screen: "approvals" },
        unread: true,
        created_at: "2026-07-08T00:00:00Z",
        read_at: null,
      },
    };
    sockets[0].emitMessage(JSON.stringify(event));

    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
  });

  it("closes the socket only when the last subscriber leaves", () => {
    const { factory, sockets } = fakeFactory();
    const hub = createRealtimeHub(factory);
    const unsubA = hub.subscribe(params, vi.fn());
    const unsubB = hub.subscribe(params, vi.fn());

    unsubA();
    expect(sockets[0].closed).toBe(false);
    unsubB();
    expect(sockets[0].closed).toBe(true);
  });

  it("reconnects with the last message id as the resume cursor", () => {
    const { factory, sockets } = fakeFactory();
    const hub = createRealtimeHub(factory);
    hub.subscribe(params, vi.fn());

    sockets[0].emitMessage(JSON.stringify(messageEvent("55555555-5555-4555-8555-555555555555")));
    sockets[0].emitClose(1013);
    vi.advanceTimersByTime(1000);

    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain("last_message_id=55555555-5555-4555-8555-555555555555");
  });

  it("does not reconnect after the last subscriber has unsubscribed", () => {
    const { factory, sockets } = fakeFactory();
    const hub = createRealtimeHub(factory);
    const unsub = hub.subscribe(params, vi.fn());
    unsub();
    sockets[0].emitClose(1001);
    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(1);
  });
});
