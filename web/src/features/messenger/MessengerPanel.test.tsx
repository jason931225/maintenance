import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

const thread: MessengerThreadSummary = {
  id: threadId,
  kind: "work_order",
  branch_id: branchId,
  title: "20260612-001",
  work_order_id: workOrderId,
  last_message_id: secondMessageId,
  last_message_at: "2026-06-12T09:12:00Z",
  member_count: 3,
  created_at: "2026-06-12T09:00:00Z",
  updated_at: "2026-06-12T09:12:00Z",
};

const firstMessage = message(firstMessageId, "초기 점검", 10);
const secondMessage = message(secondMessageId, "현장 도착", 12);
const searchMessage = message("99999999-9999-4999-8999-999999999999", "검색 결과", 13);

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
        : { items: [secondMessage], next_cursor: firstMessageId },
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
    await user.click(screen.getByRole("button", { name: ko.messenger.loadOlder }));
    expect(await screen.findByText("초기 점검")).toBeVisible();

    await user.type(screen.getByLabelText(ko.messenger.search), "검색");
    await user.click(screen.getByRole("button", { name: ko.messenger.searchButton }));
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
    body,
    attachment_evidence_ids: attachmentEvidenceIds,
    sent_at: `2026-06-12T09:${String(minute).padStart(2, "0")}:00Z`,
    created_at: `2026-06-12T09:${String(minute).padStart(2, "0")}:00Z`,
  };
}
