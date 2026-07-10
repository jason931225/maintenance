import { describe, expect, it } from "vitest";

import {
  buildComposerCandidates,
  buildMessageRows,
  renderMessageParts,
  unreadBadgeTotal,
} from "./messengerModel";
import type {
  ConsoleMessengerMember,
  ConsoleMessengerMessage,
  ConsoleMessengerThread,
} from "./types";

describe("console messenger model", () => {
  it("groups consecutive sender bubbles and places one unread divider before the unread tail", () => {
    const rows = buildMessageRows(
      [
        message({ id: "m-1", sender_id: "u-1", body: "첫 공유" }),
        message({ id: "m-2", sender_id: "u-1", body: "WO-2643 확인" }),
        message({ id: "m-3", sender_id: "u-2", body: "확인했습니다" }),
      ],
      2,
    );

    expect(rows).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ id: "m-1" }), headOn: true, dividerBefore: false }),
      expect.objectContaining({ message: expect.objectContaining({ id: "m-2" }), headOn: true, dividerBefore: true }),
      expect.objectContaining({ message: expect.objectContaining({ id: "m-3" }), headOn: true, dividerBefore: false }),
    ]);
  });

  it("renders message parts as an array with live mentions and object-code segments", () => {
    const parts = renderMessageParts("WO-2643 배차 확인 부탁 @김성호 AP-3121", {
      authorizedObjectCodes: new Set(["WO-2643"]),
      authorizedMentions: new Set(["김성호"]),
    });

    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toEqual([
      { kind: "object", text: "WO-2643", code: "WO-2643" },
      { kind: "text", text: " 배차 확인 부탁 " },
      { kind: "mention", text: "@김성호", name: "김성호" },
      { kind: "text", text: " AP-3121" },
    ]);
  });

  it("excludes muted threads from badge totals without clearing their unread count", () => {
    const threads: ConsoleMessengerThread[] = [
      thread({ id: "channel-a", muted: true, unread_count: 7, visibility: "channel" }),
      thread({ id: "direct-b", muted: false, unread_count: 2, visibility: "direct" }),
    ];

    expect(unreadBadgeTotal(threads)).toBe(2);
    expect(threads[0].unread_count).toBe(7);
  });

  it("offers @ members, # channels, bare object codes, and never the removed ! trigger", () => {
    const members: ConsoleMessengerMember[] = [
      { id: "u-1", display_name: "김성호", team: "정비" },
    ];
    const channels = [thread({ id: "ch-1", title: "배차 관제", visibility: "channel" })];
    const objectCodes = ["WO-2643", "AP-3121"];

    expect(buildComposerCandidates("@김", 2, { members, channels, objectCodes })).toEqual([
      expect.objectContaining({ kind: "mention", label: "김성호", insertText: "@김성호" }),
    ]);
    expect(buildComposerCandidates("#배", 2, { members, channels, objectCodes })).toEqual([
      expect.objectContaining({ kind: "channel", label: "배차 관제", insertText: "#배차 관제" }),
    ]);
    expect(buildComposerCandidates("WO-", 3, { members, channels, objectCodes })).toEqual([
      expect.objectContaining({ kind: "object", label: "WO-2643", insertText: "WO-2643" }),
    ]);
    expect(buildComposerCandidates("!긴급", 3, { members, channels, objectCodes })).toEqual([]);
  });
});

function thread(overrides: Partial<ConsoleMessengerThread>): ConsoleMessengerThread {
  return {
    id: "thread-1",
    kind: "team",
    visibility: "channel",
    muted: false,
    branch_id: "branch-1",
    title: "배차 관제",
    work_order_id: null,
    last_message_id: null,
    last_message_at: null,
    member_count: 3,
    unread_count: 0,
    created_at: "2026-07-09T09:00:00Z",
    updated_at: "2026-07-09T09:00:00Z",
    ...overrides,
  };
}

function message(overrides: Partial<ConsoleMessengerMessage>): ConsoleMessengerMessage {
  return {
    id: "m-1",
    thread_id: "thread-1",
    branch_id: "branch-1",
    sender_id: "u-1",
    sender_name: "김성호",
    body: "본문",
    attachment_evidence_ids: [],
    read_count: 0,
    read_target_count: 2,
    ack_count: 0,
    acked_by_me: false,
    quoted_message_id: null,
    quoted_body: null,
    quoted_sender_name: null,
    sent_at: "2026-07-09T09:00:00Z",
    created_at: "2026-07-09T09:00:00Z",
    ...overrides,
  };
}
