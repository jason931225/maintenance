import { beforeEach, describe, expect, it } from "vitest";

import { notificationRoute } from "./notificationLink";
import { createRealtimeHub, type RealtimeEvent } from "./realtimeHub";
import { useCommsStore } from "./store";
import { ingestRealtimeEvent } from "./useCommsRuntime";

// M2b AC: a messenger @-mention (#202 delivers it as a notification_created
// frame on the shared socket) must surface as a notification-center row the rail
// store ingests. This drives the real socket→store path (hub → ingestRealtimeEvent).

interface FakeSocket {
  emitMessage: (data: unknown) => void;
  addEventListener: (type: string, cb: (event: unknown) => void) => void;
  close: () => void;
}

function fakeFactory() {
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const socket: FakeSocket = {
      addEventListener: (type, cb) => {
        handlers[type] = cb;
      },
      close: () => undefined,
      emitMessage: (data) => {
        handlers.message({ data });
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

// The exact payload #202 puts on the wire for an @-mention (see
// backend/crates/messenger/adapter-postgres/src/lib.rs): category "메신저", an
// Object link kind "messenger_thread" pointing at the thread.
const mentionFrame: RealtimeEvent = {
  type: "notification_created",
  notification: {
    id: "mention-1",
    recipient_user_id: "u1",
    category: "메신저",
    text: "메신저에서 회원님을 멘션했습니다",
    link: { type: "object", kind: "messenger_thread", id: "thread-42" },
    unread: true,
    created_at: "2026-07-09T00:00:00Z",
    read_at: null,
  },
};

beforeEach(() => {
  useCommsStore.getState().reset();
});

describe("messenger @-mention → notification center", () => {
  it("ingests a mention frame from the shared socket as an unread rail row", () => {
    const { factory, sockets } = fakeFactory();
    const hub = createRealtimeHub(factory);
    hub.subscribe({ baseUrl: "https://c.example.com", accessToken: "t" }, (event) => {
      ingestRealtimeEvent(event, "u1");
    });

    sockets[0].emitMessage(JSON.stringify(mentionFrame));

    const state = useCommsStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      id: "mention-1",
      category: "메신저",
      unread: true,
      link: { type: "object", kind: "messenger_thread", id: "thread-42" },
    });
    expect(state.notificationUnread).toBe(1);
    // A mention click lands on the messenger page (no per-thread route exists).
    expect(notificationRoute(state.notifications[0].link)).toBe("/messenger");
  });

  it("does not bump the messenger badge for a mention (it is a notification, not a message)", () => {
    ingestRealtimeEvent(mentionFrame, "u1");
    expect(useCommsStore.getState().counts.messenger).toBe(0);
  });
});
