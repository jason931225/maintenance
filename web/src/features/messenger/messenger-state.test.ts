import { describe, expect, it } from "vitest";

import type {
  MessengerMessageSummary,
  MessengerThreadSummary,
} from "../../api/types";
import {
  createMessengerState,
  messengerReducer,
  resumeCursor,
} from "./messenger-state";

const branchId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const senderId = "33333333-3333-4333-8333-333333333333";

describe("messengerReducer", () => {
  it("loads thread pages and keeps cursor pagination stable", () => {
    const state = messengerReducer(createMessengerState(), {
      type: "threadsLoaded",
      threads: [thread({ id: threadId, title: "팀 채널" })],
    });

    const selected = messengerReducer(state, {
      type: "threadSelected",
      threadId,
    });

    const latest = messengerReducer(selected, {
      type: "messagesPageLoaded",
      threadId,
      page: {
        items: [
          message({ id: "55555555-5555-4555-8555-555555555555", body: "최근 공유", minute: 12 }),
          message({ id: "44444444-4444-4444-8444-444444444444", body: "초기 점검", minute: 10 }),
        ],
        next_cursor: "44444444-4444-4444-8444-444444444444",
      },
    });

    expect(latest.messagesByThread[threadId].map((item) => item.body)).toEqual([
      "초기 점검",
      "최근 공유",
    ]);
    expect(latest.nextCursorByThread[threadId]).toBe(
      "44444444-4444-4444-8444-444444444444",
    );

    const withOlder = messengerReducer(latest, {
      type: "messagesPageLoaded",
      threadId,
      page: {
        items: [
          message({ id: "44444444-4444-4444-8444-444444444444", body: "초기 점검", minute: 10 }),
          message({ id: "12121212-1212-4212-8212-121212121212", body: "이전 사진", minute: 4 }),
        ],
        next_cursor: null,
      },
    });

    expect(withOlder.messagesByThread[threadId].map((item) => item.body)).toEqual([
      "이전 사진",
      "초기 점검",
      "최근 공유",
    ]);
    expect(withOlder.nextCursorByThread[threadId]).toBeNull();
  });

  it("applies live message_posted events once and advances the resume cursor", () => {
    const state = messengerReducer(createMessengerState(), {
      type: "messagesPageLoaded",
      threadId,
      page: {
        items: [message({ id: "44444444-4444-4444-8444-444444444444", body: "초기 점검", minute: 10 })],
        next_cursor: null,
      },
    });
    const liveMessage = message({
      id: "55555555-5555-4555-8555-555555555555",
      body: "현장 도착",
      minute: 15,
    });

    const afterLive = messengerReducer(state, {
      type: "realtimeEventReceived",
      event: { type: "message_posted", message: liveMessage },
    });
    const afterDuplicate = messengerReducer(afterLive, {
      type: "realtimeEventReceived",
      event: { type: "message_posted", message: liveMessage },
    });

    expect(afterDuplicate.messagesByThread[threadId].map((item) => item.body)).toEqual([
      "초기 점검",
      "현장 도착",
    ]);
    expect(afterDuplicate.lastMessageIdByThread[threadId]).toBe(liveMessage.id);
    expect(resumeCursor(afterDuplicate)).toBe(liveMessage.id);
  });

  it("prepends and selects a newly created thread", () => {
    const existingId = "99999999-9999-4999-8999-999999999999";
    const state = messengerReducer(createMessengerState(), {
      type: "threadsLoaded",
      threads: [thread({ id: existingId, title: "기존 채널" })],
    });

    const created = thread({
      id: threadId,
      title: "새 대화",
      last_message_at: "2026-06-12T10:00:00Z",
      updated_at: "2026-06-12T10:00:00Z",
    });
    const next = messengerReducer(state, { type: "threadCreated", thread: created });

    expect(next.threads.map((item) => item.id)).toEqual([threadId, existingId]);
    expect(next.selectedThreadId).toBe(threadId);
  });
});

function thread(
  overrides: Partial<MessengerThreadSummary> = {},
): MessengerThreadSummary {
  return {
    id: threadId,
    kind: "team",
    branch_id: branchId,
    title: "팀 채널",
    work_order_id: null,
    last_message_id: null,
    last_message_at: null,
    member_count: 3,
    created_at: "2026-06-12T09:00:00Z",
    updated_at: "2026-06-12T09:00:00Z",
    ...overrides,
  };
}

function message({
  id,
  body,
  minute,
}: {
  id: string;
  body: string;
  minute: number;
}): MessengerMessageSummary {
  return {
    id,
    thread_id: threadId,
    branch_id: branchId,
    sender_id: senderId,
    body,
    attachment_evidence_ids: [],
    sent_at: `2026-06-12T09:${String(minute).padStart(2, "0")}:00Z`,
    created_at: `2026-06-12T09:${String(minute).padStart(2, "0")}:00Z`,
  };
}
