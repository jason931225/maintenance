import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createConsoleApiClient } from "../../api/client";
import type {
  MessengerMessageSummary,
  MessengerThreadSummary,
} from "../../api/types";
import { ko } from "../../i18n/ko";
import { MessengerPanel } from "./MessengerPanel";

const threadId = "22222222-2222-4222-8222-222222222222";
const branchId = "11111111-1111-4111-8111-111111111111";
const workOrderId = "33333333-3333-4333-8333-333333333333";
const senderId = "44444444-4444-4444-8444-444444444444";
const firstMessageId = "55555555-5555-4555-8555-555555555555";
const secondMessageId = "66666666-6666-4666-8666-666666666666";
const sentMessageId = "77777777-7777-4777-8777-777777777777";
const evidenceId = "88888888-8888-4888-8888-888888888888";

const readReceiptBodies: unknown[] = [];
const sentBodies: unknown[] = [];
const uploadedEvidence: string[] = [];
const confirmedEvidence: string[] = [];
const scrollIntoView = vi.fn();

const thread: MessengerThreadSummary = {
  id: threadId,
  kind: "work_order",
  branch_id: branchId,
  title: "20260612-001",
  work_order_id: workOrderId,
  last_message_id: secondMessageId,
  last_message_at: "2026-06-12T09:12:00Z",
  member_count: 3,
  unread_count: 1,
  created_at: "2026-06-12T09:00:00Z",
  updated_at: "2026-06-12T09:12:00Z",
};

const firstMessage = message(firstMessageId, "초기 점검", 10);
const secondMessage = message(secondMessageId, "현장 도착", 12);
const searchMessage = message(
  "99999999-9999-4999-8999-999999999999",
  "검색 결과",
  13,
);

const server = setupServer(
  http.get("*/api/messenger/threads", () =>
    HttpResponse.json({
      items: [thread],
    }),
  ),
  http.get("*/api/messenger/threads/:threadId/messages", ({ request }) => {
    const url = new URL(request.url);
    const beforeMessageId = url.searchParams.get("before_message_id");
    return HttpResponse.json(
      beforeMessageId
        ? { items: [firstMessage], next_cursor: null }
        : { items: [secondMessage, firstMessage], next_cursor: firstMessageId },
    );
  }),
  http.put(
    "*/api/messenger/threads/:threadId/read-receipt",
    async ({ request }) => {
      readReceiptBodies.push(await request.json());
      return HttpResponse.json({
        thread_id: threadId,
        user_id: senderId,
        last_read_message_id: secondMessageId,
        read_at: "2026-06-12T09:12:30Z",
        updated_at: "2026-06-12T09:12:30Z",
      });
    },
  ),
  http.get("*/api/messenger/search", () =>
    HttpResponse.json({
      items: [searchMessage],
    }),
  ),
  http.post("*/api/v1/evidence/presign", () =>
    HttpResponse.json({
      id: evidenceId,
      work_order_id: workOrderId,
      stage: "REPORT",
      upload: {
        method: "PUT",
        url: "https://upload.example.com/evidence",
        headers: [["content-type", "text/plain"]],
        expires_in_secs: 300,
      },
    }),
  ),
  http.put("https://upload.example.com/evidence", ({ request }) => {
    uploadedEvidence.push(request.headers.get("content-type") ?? "missing");
    return new HttpResponse(null, { status: 200 });
  }),
  http.post("*/api/v1/evidence/:evidenceId/confirm", ({ params }) => {
    confirmedEvidence.push(String(params.evidenceId));
    return HttpResponse.json({
      id: evidenceId,
      status: "CONFIRMED",
      confirmed_at: "2026-06-12T09:14:00Z",
    });
  }),
  http.post(
    "*/api/messenger/threads/:threadId/messages",
    async ({ request }) => {
      const body = await request.json();
      sentBodies.push(body);
      return HttpResponse.json(
        message(sentMessageId, (body as { body: string }).body, 14, [
          evidenceId,
        ]),
        { status: 201 },
      );
    },
  ),
);

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      addEventListener() {}
      close() {}
    },
  );
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  readReceiptBodies.length = 0;
  sentBodies.length = 0;
  uploadedEvidence.length = 0;
  confirmedEvidence.length = 0;
  scrollIntoView.mockClear();
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

describe("MessengerPanel", () => {
  it("loads threads, paginates messages, searches, sends, and attaches WO-bound media", async () => {
    const user = userEvent.setup();

    render(
      <MessengerPanel
        api={createConsoleApiClient("test-access-token")}
        accessToken="test-access-token"
        apiBaseUrl="http://localhost:8080"
      />,
    );

    expect(await screen.findByText("현장 도착")).toBeVisible();
    await waitFor(() => {
      expect(readReceiptBodies[0]).toEqual({
        last_read_message_id: secondMessageId,
      });
    });
    await user.click(
      screen.getByRole("button", { name: ko.messenger.loadOlder }),
    );
    expect(await screen.findByText("초기 점검")).toBeVisible();

    await user.type(screen.getByLabelText(ko.messenger.search), "검색");
    await user.click(
      screen.getByRole("button", { name: ko.messenger.searchButton }),
    );
    expect((await screen.findAllByText("검색 결과")).length).toBeGreaterThan(0);

    await user.upload(
      screen.getByLabelText(ko.messenger.attachment),
      new File(["evidence"], "evidence.txt", { type: "text/plain" }),
    );
    await user.type(screen.getByLabelText(ko.messenger.composer), "첨부 전송");
    await user.click(screen.getByRole("button", { name: ko.messenger.send }));

    await waitFor(() => {
      expect(sentBodies).toContainEqual({
        body: "첨부 전송",
        attachment_evidence_ids: [evidenceId],
      });
      expect(uploadedEvidence).toEqual(["text/plain"]);
      expect(confirmedEvidence).toEqual([evidenceId]);
      expect(readReceiptBodies.length).toBeGreaterThan(0);
    });
  });

  it("sends with Enter, keeps Shift+Enter as a newline, highlights mentions, and focuses the latest message", async () => {
    const user = userEvent.setup();

    render(
      <MessengerPanel
        api={createConsoleApiClient("test-access-token")}
        accessToken="test-access-token"
        apiBaseUrl="http://localhost:8080"
      />,
    );

    expect(await screen.findByText("현장 도착")).toBeVisible();

    const composer = screen.getByLabelText(ko.messenger.composer);
    await user.type(composer, "첫 줄");
    await user.keyboard("{Shift>}{Enter}{/Shift}두 번째 줄");

    expect(composer).toHaveValue("첫 줄\n두 번째 줄");
    expect(sentBodies).toEqual([]);

    await user.clear(composer);
    await user.type(composer, "@이운창 확인했습니다.");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(sentBodies).toContainEqual({
        body: "@이운창 확인했습니다.",
        attachment_evidence_ids: [],
      });
    });

    const latestMention = await screen.findByText("@이운창");
    const latestMessage = latestMention.closest("article");
    expect(latestMessage).not.toBeNull();
    expect(latestMessage).toHaveTextContent("@이운창 확인했습니다.");
    expect(latestMessage).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalled();
    expect(latestMention).toHaveClass("font-semibold");
  });

  it("creates a new conversation then sends into it", async () => {
    const user = userEvent.setup();
    const memberId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const newThreadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const createdBodies: unknown[] = [];
    const participantDirectoryRequests: URL[] = [];
    const adminUserDirectoryRequests: URL[] = [];

    server.use(
      http.get("*/api/messenger/members", ({ request }) => {
        participantDirectoryRequests.push(new URL(request.url));
        return HttpResponse.json({
          items: [
            {
              id: senderId,
              display_name: "나",
              team: "MAINTENANCE",
            },
            {
              id: memberId,
              display_name: "김정비",
              team: "MAINTENANCE",
            },
          ],
        });
      }),
      http.get("*/api/v1/users", ({ request }) => {
        adminUserDirectoryRequests.push(new URL(request.url));
        return HttpResponse.json(
          { error: { code: "forbidden", message: "UserManage required" } },
          { status: 403 },
        );
      }),
      http.post("*/api/messenger/threads", async ({ request }) => {
        createdBodies.push(await request.json());
        return HttpResponse.json(
          {
            id: newThreadId,
            kind: "dm",
            branch_id: branchId,
            title: "현장 협의",
            work_order_id: null,
            last_message_id: null,
            last_message_at: null,
            member_count: 2,
            unread_count: 0,
            created_at: "2026-06-12T10:00:00Z",
            updated_at: "2026-06-12T10:00:00Z",
          },
          { status: 201 },
        );
      }),
      http.get("*/api/messenger/threads/:threadId/messages", () =>
        HttpResponse.json({ items: [], next_cursor: null }),
      ),
      http.post(
        "*/api/messenger/threads/:threadId/messages",
        async ({ request }) => {
          const body = (await request.json()) as { body: string };
          return HttpResponse.json(
            {
              id: sentMessageId,
              thread_id: newThreadId,
              branch_id: branchId,
              sender_id: senderId,
              sender_name: "나",
              body: body.body,
              attachment_evidence_ids: [],
              sent_at: "2026-06-12T10:01:00Z",
              created_at: "2026-06-12T10:01:00Z",
            },
            { status: 201 },
          );
        },
      ),
    );

    render(
      <MessengerPanel
        api={createConsoleApiClient("test-access-token")}
        accessToken="test-access-token"
        apiBaseUrl="http://localhost:8080"
        branchId={branchId}
        currentUserId={senderId}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: ko.messenger.newThread }),
    );

    await user.type(
      await screen.findByLabelText(ko.messenger.subject),
      "현장 협의",
    );
    // The signed-in member is excluded; only 김정비 is selectable.
    await user.click(await screen.findByLabelText("김정비"));
    await user.click(screen.getByRole("button", { name: ko.messenger.create }));

    await waitFor(() => {
      expect(participantDirectoryRequests).toHaveLength(1);
      expect(
        participantDirectoryRequests[0]?.searchParams.get("branch_id"),
      ).toBe(branchId);
      expect(adminUserDirectoryRequests).toHaveLength(0);
      expect(createdBodies).toContainEqual({
        branch_id: branchId,
        kind: "dm",
        title: "현장 협의",
        member_ids: [memberId],
      });
    });

    // The new thread is selected; sending reuses the existing send path.
    await user.type(
      await screen.findByLabelText(ko.messenger.composer),
      "첫 메시지",
    );
    await user.click(screen.getByRole("button", { name: ko.messenger.send }));

    expect(await screen.findByText("첫 메시지")).toBeVisible();
  });


  it("opens the source conversation from a search result", async () => {
    const user = userEvent.setup();
    const teamThreadId = "aaaaaaaa-1111-4aaa-8aaa-111111111111";
    const teamThread: MessengerThreadSummary = {
      id: teamThreadId,
      kind: "team",
      branch_id: branchId,
      title: "정비팀 공지",
      work_order_id: null,
      last_message_id: "bbbbbbbb-1111-4bbb-8bbb-111111111111",
      last_message_at: "2026-06-12T08:30:00Z",
      member_count: 5,
      unread_count: 1,
      created_at: "2026-06-12T08:00:00Z",
      updated_at: "2026-06-12T08:30:00Z",
    };
    const teamMessage: MessengerMessageSummary = {
      id: "bbbbbbbb-1111-4bbb-8bbb-111111111111",
      thread_id: teamThreadId,
      branch_id: branchId,
      sender_id: senderId,
      sender_name: "운영팀",
      body: "정비팀 주간 공지",
      attachment_evidence_ids: [],
      read_count: 2,
      read_target_count: 4,
      sent_at: "2026-06-12T08:30:00Z",
      created_at: "2026-06-12T08:30:00Z",
    };
    const messageRequests: string[] = [];

    server.use(
      http.get("*/api/messenger/threads", () =>
        HttpResponse.json({ items: [thread, teamThread] }),
      ),
      http.get("*/api/messenger/search", () =>
        HttpResponse.json({ items: [teamMessage] }),
      ),
      http.get("*/api/messenger/threads/:threadId/messages", ({ params }) => {
        const requestedThreadId = String(params.threadId);
        messageRequests.push(requestedThreadId);
        return HttpResponse.json(
          requestedThreadId === teamThreadId
            ? { items: [teamMessage], next_cursor: null }
            : { items: [secondMessage], next_cursor: null },
        );
      }),
    );

    render(
      <MessengerPanel
        api={createConsoleApiClient("test-access-token")}
        accessToken="test-access-token"
        apiBaseUrl="http://localhost:8080"
      />,
    );

    expect(await screen.findByText("현장 도착")).toBeVisible();
    await waitFor(() => {
      expect(screen.getAllByText(ko.messenger.unreadCount(1))).toHaveLength(1);
    });

    await user.type(screen.getByLabelText(ko.messenger.search), "공지");
    await user.click(
      screen.getByRole("button", { name: ko.messenger.searchButton }),
    );

    await user.click(
      await screen.findByRole("button", {
        name: ko.messenger.openSearchResult("정비팀 공지"),
      }),
    );

    await waitFor(() => {
      expect(messageRequests).toContain(teamThreadId);
    });
    const selectedTeamThread = screen
      .getAllByRole("button", { name: /정비팀 공지/ })
      .find((button) => button.getAttribute("aria-pressed") === "true");
    expect(selectedTeamThread).toBeDefined();
    expect(
      screen.getByRole("heading", { name: /정비팀 공지/ }),
    ).toBeVisible();
  });

  it("surfaces search failures without publishing stale results", async () => {
    const user = userEvent.setup();

    server.use(
      http.get("*/api/messenger/search", () =>
        HttpResponse.json(
          { error: { code: "unavailable", message: "search unavailable" } },
          { status: 503 },
        ),
      ),
    );

    render(
      <MessengerPanel
        api={createConsoleApiClient("test-access-token")}
        accessToken="test-access-token"
        apiBaseUrl="http://localhost:8080"
      />,
    );

    expect(await screen.findByText("현장 도착")).toBeVisible();

    await user.type(screen.getByLabelText(ko.messenger.search), "검색");
    await user.click(
      screen.getByRole("button", { name: ko.messenger.searchButton }),
    );

    expect(await screen.findByText(ko.messenger.searchFailed)).toBeVisible();
    expect(screen.queryByRole("heading", { name: ko.messenger.searchResults }))
      .not.toBeInTheDocument();
  });

  it("surfaces message-page failures from direct thread actions", async () => {
    const user = userEvent.setup();
    const teamThreadId = "aaaaaaaa-1111-4aaa-8aaa-111111111111";
    const teamThread: MessengerThreadSummary = {
      id: teamThreadId,
      kind: "team",
      branch_id: branchId,
      title: "정비팀 공지",
      work_order_id: null,
      last_message_id: "bbbbbbbb-1111-4bbb-8bbb-111111111111",
      last_message_at: "2026-06-12T08:30:00Z",
      member_count: 5,
      unread_count: 1,
      created_at: "2026-06-12T08:00:00Z",
      updated_at: "2026-06-12T08:30:00Z",
    };

    server.use(
      http.get("*/api/messenger/threads", () =>
        HttpResponse.json({ items: [thread, teamThread] }),
      ),
      http.get("*/api/messenger/threads/:threadId/messages", ({ params }) => {
        if (String(params.threadId) === teamThreadId) {
          return HttpResponse.json(
            { error: { code: "unavailable", message: "messages unavailable" } },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          items: [secondMessage, firstMessage],
          next_cursor: firstMessageId,
        });
      }),
    );

    render(
      <MessengerPanel
        api={createConsoleApiClient("test-access-token")}
        accessToken="test-access-token"
        apiBaseUrl="http://localhost:8080"
      />,
    );

    expect(await screen.findByText("현장 도착")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /정비팀 공지/ }));

    expect(await screen.findByText(ko.messenger.readFailed)).toBeVisible();
  });

  it("keeps a successful send even when the follow-up read receipt fails", async () => {
    const user = userEvent.setup();

    server.use(
      http.put(
        "*/api/messenger/threads/:threadId/read-receipt",
        async ({ request }) => {
          const body = await request.json();
          readReceiptBodies.push(body);
          if (
            (body as { last_read_message_id?: string }).last_read_message_id ===
            sentMessageId
          ) {
            return HttpResponse.json(
              { error: { code: "unavailable", message: "receipt unavailable" } },
              { status: 503 },
            );
          }
          return HttpResponse.json({
            thread_id: threadId,
            user_id: senderId,
            last_read_message_id: secondMessageId,
            read_at: "2026-06-12T09:12:30Z",
            updated_at: "2026-06-12T09:12:30Z",
          });
        },
      ),
    );

    render(
      <MessengerPanel
        api={createConsoleApiClient("test-access-token")}
        accessToken="test-access-token"
        apiBaseUrl="http://localhost:8080"
      />,
    );

    expect(await screen.findByText("현장 도착")).toBeVisible();

    const composer = screen.getByLabelText(ko.messenger.composer);
    await user.type(composer, "읽음 실패 후에도 전송 유지");
    await user.click(screen.getByRole("button", { name: ko.messenger.send }));

    await waitFor(() => {
      expect(sentBodies).toContainEqual({
        body: "읽음 실패 후에도 전송 유지",
        attachment_evidence_ids: [],
      });
      expect(composer).toHaveValue("");
    });
    expect(screen.queryByText(ko.messenger.sendFailed)).not.toBeInTheDocument();
  });

  it("surfaces participant directory failures while creating a conversation", async () => {
    const user = userEvent.setup();

    server.use(
      http.get("*/api/messenger/members", () =>
        HttpResponse.json(
          { error: { code: "forbidden", message: "branch scope required" } },
          { status: 403 },
        ),
      ),
    );

    render(
      <MessengerPanel
        api={createConsoleApiClient("test-access-token")}
        accessToken="test-access-token"
        apiBaseUrl="http://localhost:8080"
        branchId={branchId}
        currentUserId={senderId}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: ko.messenger.newThread }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      ko.messenger.participantsLoadFailed,
    );
    expect(
      screen.getByRole("button", { name: ko.messenger.create }),
    ).toBeDisabled();
  });
});

function message(
  id: string,
  body: string,
  minute: number,
  attachmentEvidenceIds: string[] = [],
): MessengerMessageSummary {
  return {
    id,
    thread_id: threadId,
    branch_id: branchId,
    sender_id: senderId,
    sender_name: "나",
    body,
    attachment_evidence_ids: attachmentEvidenceIds,
    read_count: 1,
    read_target_count: 2,
    sent_at: `2026-06-12T09:${String(minute).padStart(2, "0")}:00Z`,
    created_at: `2026-06-12T09:${String(minute).padStart(2, "0")}:00Z`,
  };
}
