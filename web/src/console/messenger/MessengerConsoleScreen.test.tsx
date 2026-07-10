import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { OBJ_REF_MIME, objectRefToken } from "../window";
import { MESSENGER_ACTIONS } from "./constants";
import { MessengerConsoleScreen } from "./MessengerConsoleScreen";
import type { ConsoleMessengerMessage, ConsoleMessengerThread } from "./types";

const server = setupServer();
const allowGate: PolicyGate = { can: () => true };
const denyGate: PolicyGate = { can: () => false };
const accessToken = "console-msgr-token";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("MessengerConsoleScreen", () => {
  it("loads the carbon-copy two-pane messenger view from real parity endpoints", async () => {
    installHandlers();

    renderMessenger();

    expect(await screen.findByRole("heading", { name: "메신저" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "대화 검색" })).toBeVisible();
    expect(await screen.findByRole("button", { name: /# 배차 관제/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /김성호/ })).toBeVisible();

    const conversation = await screen.findByRole("region", { name: "배차 관제 대화" });
    expect(within(conversation).getByText("온라인")).toBeVisible();
    expect(within(conversation).getAllByText("WO-2643").length).toBeGreaterThan(0);
    expect(within(conversation).getByText("새 메시지")).toBeVisible();
    expect(within(conversation).getByText("읽음 1/2")).toBeVisible();
    expect(screen.queryByText("배지 9")).not.toBeInTheDocument();
  });

  it("omits every messenger affordance when PolicyGated denies it", async () => {
    installHandlers();

    renderMessenger(denyGate);

    expect(await screen.findByRole("heading", { name: "메신저" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "전송" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "확인" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "답장" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "할 일" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "무음" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /WO-2643/ })).not.toBeInTheDocument();
  });

  it("persists ack, reply quote, mute, todo conversion, and @ mention composer requests", async () => {
    const observed = installHandlers();
    renderMessenger();

    const conversation = await screen.findByRole("region", { name: "배차 관제 대화" });

    fireEvent.click(within(conversation).getAllByRole("button", { name: "확인" })[0]);
    await waitFor(() => {
      expect(observed.ackPaths).toEqual(["/api/messenger/messages/msg-1/ack"]);
    });
    expect(await within(conversation).findByText("확인 2")).toBeVisible();

    fireEvent.click(within(conversation).getAllByRole("button", { name: "답장" })[0]);
    expect(screen.getByText("김성호 · WO-2643 배차 확인 부탁 @김성호")).toBeVisible();

    const composer = screen.getByLabelText("메시지 입력");
    fireEvent.change(composer, {
      target: { value: "@김" },
    });
    expect(await screen.findByRole("option", { name: "김성호" })).toBeVisible();
    fireEvent.keyDown(composer, { key: "Tab" });
    fireEvent.change(composer, {
      target: { value: "@김성호 WO-2643 처리했습니다" },
    });
    fireEvent.click(screen.getByRole("button", { name: "전송" }));

    await waitFor(() => {
      expect(observed.sentBodies[0]).toMatchObject({
        body: "@김성호 WO-2643 처리했습니다",
        quoted_message_id: "msg-1",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "무음" }));
    await waitFor(() => {
      expect(observed.muteBodies).toEqual([{ muted: true }]);
    });
    expect(await screen.findByRole("button", { name: "무음 해제" })).toBeVisible();

    fireEvent.click(within(conversation).getAllByRole("button", { name: "할 일" })[0]);
    await waitFor(() => {
      expect(observed.todoBodies[0]).toMatchObject({
        text: "WO-2643 배차 확인 부탁 @김성호",
        links: [
          { kind: "messenger_thread", id: "thread-channel", label: "배차 관제" },
          { kind: "messenger_message", id: "msg-1", label: "WO-2643 배차 확인 부탁 @김성호" },
        ],
      });
    });
    expect(await within(conversation).findByText("할 일 등록")).toBeVisible();
  });

  it("drops an object reference into the composer through the token grammar", async () => {
    installHandlers();
    renderMessenger();

    await screen.findByRole("region", { name: "배차 관제 대화" });
    const composer = screen.getByLabelText("메시지 입력");
    expect(composer.value).toBe("");

    // §4-20/§4-23: the dragged payload is the "[code title]" reference token; the
    // drop parses its code and appends it as a bare-code token the composer
    // grammar re-links.
    fireEvent.drop(composer, {
      dataTransfer: mockDataTransfer({ code: "AP-777", title: "구매 기안" }),
    });

    expect(composer.value).toContain("AP-777");
  });

  it("ignores a dropped object the viewer is not policy-allowed to open (deny-by-omission)", async () => {
    // Allow every messenger affordance EXCEPT opening an object reference, so the
    // composer renders but a PBAC-denied drop is a silent no-op.
    const denyObjectGate: PolicyGate = {
      can: (action) => action !== MESSENGER_ACTIONS.objectOpen,
    };
    installHandlers();
    renderMessenger(denyObjectGate);

    await screen.findByRole("region", { name: "배차 관제 대화" });
    const composer = screen.getByLabelText("메시지 입력");
    expect(composer.value).toBe("");

    fireEvent.drop(composer, {
      dataTransfer: mockDataTransfer({ code: "AP-777", title: "구매 기안" }),
    });

    expect(composer.value).toBe("");
  });
});

// jsdom has no DataTransfer; a Map-backed stub carrying the same payload objDrag
// writes on dragStart (typed mime + text/plain token) covers the getData surface
// the drop handler reads.
function mockDataTransfer({ code, title }: { code: string; title: string }): DataTransfer {
  const store = new Map<string, string>([
    [OBJ_REF_MIME, JSON.stringify({ code, title })],
    ["text/plain", objectRefToken(code, title)],
  ]);
  return {
    setData: (format: string, value: string) => void store.set(format, value),
    getData: (format: string) => store.get(format) ?? "",
    get types() {
      return [...store.keys()];
    },
    dropEffect: "none",
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

function renderMessenger(gate: PolicyGate = allowGate) {
  return render(
    <PolicyGateProvider gate={gate}>
      <MessengerConsoleScreen
        accessToken={accessToken}
        branchId="branch-1"
        currentUserId="user-me"
      />
    </PolicyGateProvider>,
  );
}

function installHandlers() {
  const observed: {
    ackPaths: string[];
    sentBodies: unknown[];
    muteBodies: unknown[];
    todoBodies: unknown[];
  } = { ackPaths: [], sentBodies: [], muteBodies: [], todoBodies: [] };

  const channel = thread({
    id: "thread-channel",
    visibility: "channel",
    muted: false,
    title: "배차 관제",
    unread_count: 2,
    member_count: 3,
  });
  const mutedChannel = thread({
    id: "thread-muted",
    visibility: "channel",
    muted: true,
    title: "조용한 채널",
    unread_count: 7,
    member_count: 4,
  });
  const direct = thread({
    id: "thread-dm",
    visibility: "direct",
    muted: false,
    kind: "dm",
    title: "김성호",
    unread_count: 0,
    member_count: 2,
  });
  const messages = [
    message({
      id: "msg-1",
      sender_id: "user-1",
      sender_name: "김성호",
      body: "WO-2643 배차 확인 부탁 @김성호",
      read_count: 1,
      read_target_count: 2,
      ack_count: 1,
      acked_by_me: false,
    }),
    message({
      id: "msg-2",
      sender_id: "user-1",
      sender_name: "김성호",
      body: "AP-3121 승인도 확인",
      sent_at: "2026-07-09T09:01:00Z",
      created_at: "2026-07-09T09:01:00Z",
    }),
    message({
      id: "msg-3",
      sender_id: "user-me",
      sender_name: "나",
      body: "확인했습니다",
      sent_at: "2026-07-09T09:02:00Z",
      created_at: "2026-07-09T09:02:00Z",
    }),
  ];

  server.use(
    http.get("*/api/messenger/threads", ({ request }) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
      return HttpResponse.json({ items: [channel, direct] });
    }),
    http.get("*/api/messenger/channels", () => HttpResponse.json({ items: [channel, mutedChannel] })),
    http.get("*/api/messenger/members", () =>
      HttpResponse.json({ items: [{ id: "user-1", display_name: "김성호", team: "정비" }] }),
    ),
    http.get("*/api/messenger/threads/:threadId/messages", () =>
      HttpResponse.json({ items: messages, next_cursor: null }),
    ),
    http.put("*/api/messenger/threads/:threadId/read-receipt", () =>
      HttpResponse.json({
        thread_id: "thread-channel",
        user_id: "user-me",
        last_read_message_id: "msg-3",
        read_at: "2026-07-09T09:03:00Z",
        updated_at: "2026-07-09T09:03:00Z",
      }),
    ),
    http.get("*/api/messenger/threads/:threadId/presence", () =>
      HttpResponse.json({
        items: [
          { user_id: "user-1", display_name: "김성호", last_activity_at: "2026-07-09T09:02:30Z", status: "online" },
          { user_id: "user-me", display_name: "나", last_activity_at: "2026-07-09T09:02:00Z", status: "away" },
        ],
      }),
    ),
    http.post("*/api/messenger/messages/:messageId/ack", ({ request }) => {
      observed.ackPaths.push(new URL(request.url).pathname);
      return HttpResponse.json({ message_id: "msg-1", thread_id: "thread-channel", acked: true, ack_count: 2 });
    }),
    http.post("*/api/messenger/threads/:threadId/messages", async ({ request }) => {
      observed.sentBodies.push(await request.json());
      return HttpResponse.json(
        message({
          id: "msg-4",
          sender_id: "user-me",
          sender_name: "나",
          body: "@김성호 WO-2643 처리했습니다",
          quoted_message_id: "msg-1",
          quoted_body: "WO-2643 배차 확인 부탁 @김성호",
          quoted_sender_name: "김성호",
          sent_at: "2026-07-09T09:04:00Z",
          created_at: "2026-07-09T09:04:00Z",
        }),
        { status: 201 },
      );
    }),
    http.put("*/api/messenger/threads/:threadId/mute", async ({ request }) => {
      observed.muteBodies.push(await request.json());
      return HttpResponse.json({ thread_id: "thread-channel", muted: true });
    }),
    http.post("*/api/v1/me/todos", async ({ request }) => {
      observed.todoBodies.push(await request.json());
      return HttpResponse.json(
        {
          id: "todo-1",
          owner_user_id: "user-me",
          text: "WO-2643 배차 확인 부탁 @김성호",
          scopes: [],
          links: [],
          done: false,
          created_at: "2026-07-09T09:05:00Z",
          updated_at: "2026-07-09T09:05:00Z",
          done_at: null,
        },
        { status: 201 },
      );
    }),
    http.get("*/api/messenger/search", () => HttpResponse.json({ items: [messages[0]] })),
  );

  return observed;
}

function thread(overrides: Partial<ConsoleMessengerThread>): ConsoleMessengerThread {
  return {
    id: "thread-channel",
    kind: "team",
    visibility: "channel",
    muted: false,
    branch_id: "branch-1",
    title: "배차 관제",
    work_order_id: null,
    last_message_id: "msg-3",
    last_message_at: "2026-07-09T09:02:00Z",
    member_count: 3,
    unread_count: 0,
    created_at: "2026-07-09T08:00:00Z",
    updated_at: "2026-07-09T09:02:00Z",
    ...overrides,
  };
}

function message(overrides: Partial<ConsoleMessengerMessage>): ConsoleMessengerMessage {
  return {
    id: "msg-1",
    thread_id: "thread-channel",
    branch_id: "branch-1",
    sender_id: "user-1",
    sender_name: "김성호",
    body: "WO-2643 배차 확인 부탁 @김성호",
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

expect(MESSENGER_ACTIONS.read).toBe("messenger.thread.read");
