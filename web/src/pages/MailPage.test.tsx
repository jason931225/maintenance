import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import { MailPage } from "./MailPage";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const folders = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    role: "INBOX",
    name: "Inbox",
    unread_count: 2,
    total_count: 8,
  },
];

const threads = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    subject: "급여명세서 확인",
    last_message_at: "2026-06-26T01:00:00Z",
    message_count: 1,
    unread_count: 1,
    has_attachments: false,
    is_flagged: false,
  },
];

const detail = {
  id: threads[0].id,
  subject: threads[0].subject,
  messages: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      thread_id: threads[0].id,
      direction: "IN",
      message_id: "<m1@example.com>",
      in_reply_to: null,
      from_address: "hr@example.com",
      from_name: "인사팀",
      to: [{ address: "employee@example.com", name: "직원" }],
      cc: [],
      subject: threads[0].subject,
      snippet: "요약 본문",
      body_text: "텍스트 본문만 표시",
      body_html:
        "<p onclick=\"alert(1)\"><strong>안전 HTML 본문</strong></p><img src=\"https://tracker.example/pixel\" onerror=\"alert(1)\"><a href=\"javascript:alert(1)\">악성 링크</a><a href=\"https://www.cossok.com/\">공식 링크</a>",
      seen: false,
      flagged: false,
      answered: false,
      has_attachments: false,
      received_at: "2026-06-26T01:00:00Z",
      attachments: [],
    },
  ],
};

const adminSession: AuthSession = { access_token: "a", roles: ["ADMIN"] };

const mailAccount = {
  id: "44444444-4444-4444-8444-444444444444",
  display_name: "정비팀",
  email_address: "service@example.com",
  from_name: "정비팀",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_security: "SSL_TLS",
  imap_username: "service@example.com",
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_security: "SSL_TLS",
  smtp_username: "service@example.com",
  has_smtp_password: true,
  has_imap_password: true,
  status: "ACTIVE",
};

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api,
  };
}

function renderPage(ctx = makeAuthContext(adminSession)) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter>
        <MailPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function mockMailbox() {
  server.use(
    http.get("*/api/v1/mail/account", () => HttpResponse.json(mailAccount)),
    http.get("*/api/v1/mail/folders", () => HttpResponse.json(folders)),
    http.get("*/api/v1/mail/threads", () => HttpResponse.json(threads)),
    http.get("*/api/v1/mail/threads/:id", () => HttpResponse.json(detail)),
    http.get("*/api/v1/sales/inquiries", () =>
      HttpResponse.json({ items: [], limit: 5, offset: 0, total: 0 }),
    ),
  );
}

describe("MailPage", () => {
  it("loads folders, threads, and renders sanitized HTML mail bodies", async () => {
    mockMailbox();

    renderPage();

    expect(await screen.findByRole("heading", { name: "메일함" })).toBeVisible();
    expect(await screen.findByText("받은 편지함")).toBeVisible();
    expect(screen.getAllByText("급여명세서 확인").length).toBeGreaterThan(0);
    expect(await screen.findByText("안전 HTML 본문")).toBeVisible();
    const body = screen.getByTestId("mail-html-body");
    expect(body.querySelector("img, script")).toBeNull();
    expect(body.querySelector("[onclick]")).toBeNull();
    expect(body.querySelector("a[href^='javascript:']")).toBeNull();
    const safeLink = within(body).getByRole("link", { name: "공식 링크" });
    expect(safeLink).toHaveAttribute("target", "_blank");
    expect(safeLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("sends a composed message through the mail API", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    mockMailbox();
    server.use(
      http.post("*/api/v1/mail/send", async ({ request }) => {
        sent(await request.json());
        return HttpResponse.json({
          message_id: "44444444-4444-4444-8444-444444444444",
          rfc_message_id: "<sent@example.com>",
        }, { status: 201 });
      }),
    );

    renderPage();

    const compose = await screen.findByRole("heading", { name: "새 메일" });
    const form = compose.closest("section");
    expect(form).not.toBeNull();
    if (!form) throw new Error("compose form missing");
    await user.type(within(form).getByLabelText("받는 사람"), "payroll@example.com");
    await user.type(within(form).getByLabelText("제목"), "정산 확인");
    await user.type(within(form).getByLabelText("본문"), "확인 부탁드립니다.");
    await user.click(within(form).getByRole("button", { name: "메일 보내기" }));

    await waitFor(() => { expect(sent).toHaveBeenCalledTimes(1); });
    expect(sent.mock.calls[0][0]).toEqual({
      to: [{ address: "payroll@example.com" }],
      subject: "정산 확인",
      body_text: "확인 부탁드립니다.",
    });
    expect(await screen.findByText("메일을 보냈습니다.")).toBeVisible();
  });

  it("replies to a selected thread through the threaded reply API", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    const detachedSend = vi.fn();
    mockMailbox();
    server.use(
      http.post("*/api/v1/mail/send", async ({ request }) => {
        detachedSend(await request.json());
        return HttpResponse.json({ error: { code: "wrong_endpoint" } }, { status: 500 });
      }),
      http.post("*/api/v1/mail/reply", async ({ request }) => {
        sent(await request.json());
        return HttpResponse.json({
          message_id: "44444444-4444-4444-8444-444444444444",
          rfc_message_id: "<reply@example.com>",
        }, { status: 201 });
      }),
    );

    renderPage();

    await screen.findByText("인사팀");
    await user.click(await screen.findByRole("button", { name: "답장" }));

    const compose = await screen.findByRole("heading", { name: "답장 작성" });
    const form = compose.closest("section");
    expect(form).not.toBeNull();
    if (!form) throw new Error("compose form missing");
    expect(within(form).getByLabelText("받는 사람")).toHaveValue("hr@example.com");
    expect(within(form).getByLabelText("제목")).toHaveValue("Re: 급여명세서 확인");
    await user.type(within(form).getByLabelText("본문"), "확인했습니다.");
    await user.click(within(form).getByRole("button", { name: "답장 보내기" }));

    await waitFor(() => { expect(sent).toHaveBeenCalledTimes(1); });
    expect(detachedSend).not.toHaveBeenCalled();
    expect(sent.mock.calls[0][0]).toEqual({
      to: [{ address: "hr@example.com" }],
      subject: "Re: 급여명세서 확인",
      body_text: expect.stringContaining("확인했습니다."),
      in_reply_to: "<m1@example.com>",
      references: ["<m1@example.com>"],
    });
    expect(await screen.findByText("답장을 보냈습니다.")).toBeVisible();
  });

  it("forwards an existing message through the threaded forward API", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    const detachedSend = vi.fn();
    mockMailbox();
    server.use(
      http.post("*/api/v1/mail/send", async ({ request }) => {
        detachedSend(await request.json());
        return HttpResponse.json({ error: { code: "wrong_endpoint" } }, { status: 500 });
      }),
      http.post("*/api/v1/mail/forward", async ({ request }) => {
        sent(await request.json());
        return HttpResponse.json({
          message_id: "44444444-4444-4444-8444-444444444444",
          rfc_message_id: "<forward@example.com>",
        }, { status: 201 });
      }),
    );

    renderPage();

    await screen.findByText("인사팀");
    await user.click(await screen.findByRole("button", { name: "전달" }));

    const compose = await screen.findByRole("heading", { name: "전달 작성" });
    const form = compose.closest("section");
    expect(form).not.toBeNull();
    if (!form) throw new Error("compose form missing");
    expect(within(form).getByLabelText("받는 사람")).toHaveValue("");
    expect(within(form).getByLabelText("제목")).toHaveValue("Fwd: 급여명세서 확인");
    await user.type(within(form).getByLabelText("받는 사람"), "manager@example.com");
    await user.type(within(form).getByLabelText("본문"), "검토 부탁드립니다.");
    await user.click(within(form).getByRole("button", { name: "전달 보내기" }));

    await waitFor(() => { expect(sent).toHaveBeenCalledTimes(1); });
    expect(detachedSend).not.toHaveBeenCalled();
    expect(sent.mock.calls[0][0]).toEqual({
      to: [{ address: "manager@example.com" }],
      subject: "Fwd: 급여명세서 확인",
      body_text: expect.stringContaining("검토 부탁드립니다."),
      in_reply_to: "<m1@example.com>",
      references: ["<m1@example.com>"],
    });
    expect(await screen.findByText("메일을 전달했습니다.")).toBeVisible();
  });

  it("shows setup guidance instead of a broken mailbox when mail is unavailable", async () => {
    server.use(
      http.get("*/api/v1/mail/account", () =>
        HttpResponse.json({ error: { code: "email_not_configured" } }, { status: 503 }),
      ),
      http.get("*/api/v1/mail/folders", () =>
        HttpResponse.json({ error: { code: "email_not_configured" } }, { status: 503 }),
      ),
      http.get("*/api/v1/mail/threads", () =>
        HttpResponse.json({ error: { code: "email_not_configured" } }, { status: 503 }),
      ),
      http.get("*/api/v1/sales/inquiries", () =>
        HttpResponse.json({ items: [], limit: 5, offset: 0, total: 0 }),
      ),
    );

    renderPage();

    expect(await screen.findByText("메일 기능이 아직 구성되지 않았습니다.")).toBeVisible();
    expect(screen.getByRole("link", { name: "메일 서버 설정" })).toHaveAttribute(
      "href",
      "/settings/email",
    );
  });

  it("shows admin readiness instead of compose when no mailbox account is configured", async () => {
    server.use(
      http.get(
        "*/api/v1/mail/account",
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.get("*/api/v1/mail/folders", () => HttpResponse.json([])),
      http.get("*/api/v1/mail/threads", () => HttpResponse.json([])),
      http.get("*/api/v1/sales/inquiries", () =>
        HttpResponse.json({ items: [], limit: 5, offset: 0, total: 0 }),
      ),
    );

    renderPage();

    expect(await screen.findByRole("heading", { name: "메일 계정 설정 필요" })).toBeVisible();
    expect(screen.getByText("관리자가 SMTP/IMAP 서버와 발신 이름을 저장합니다.")).toBeVisible();
    expect(screen.getByRole("link", { name: "메일 서버 설정" })).toHaveAttribute(
      "href",
      "/settings/email",
    );
    expect(screen.queryByRole("heading", { name: "새 메일" })).not.toBeInTheDocument();
  });

  it("surfaces new website inquiries beside the mailbox workflow", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    mockMailbox();
    server.use(
      http.get("*/api/v1/sales/inquiries", () =>
        HttpResponse.json({
          items: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              name: "고객 담당자",
              phone: "010-1111-2222",
              topic: "USED_SALES",
              location: "창원",
              message: "2.5톤 중고 지게차 상담 요청",
              listing_id: null,
              status: "NEW",
              created_at: "2026-06-26T02:00:00Z",
              updated_at: "2026-06-26T02:00:00Z",
            },
          ],
          limit: 5,
          offset: 0,
          total: 1,
        }),
      ),
      http.patch("*/api/v1/sales/inquiries/:id", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    renderPage();

    expect(await screen.findByRole("heading", { name: "신규 고객 문의" })).toBeVisible();
    expect(await screen.findByText("고객 담당자")).toBeVisible();
    expect(screen.getByText("2.5톤 중고 지게차 상담 요청")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "연락함으로 표시" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({ status: "CONTACTED" });
    });
  });

  it("rejects unsafe attachment download URLs returned by the API", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mockMailbox();
    server.use(
      http.get("*/api/v1/mail/threads/:id", () =>
        HttpResponse.json({
          ...detail,
          messages: [
            {
              ...detail.messages[0],
              has_attachments: true,
              attachments: [
                {
                  id: "66666666-6666-4666-8666-666666666666",
                  filename: "invoice.pdf",
                  content_type: "application/pdf",
                  size_bytes: 1024,
                  is_inline: false,
                },
              ],
            },
          ],
        }),
      ),
      http.get("*/api/v1/mail/attachments/:id/download", () =>
        HttpResponse.json({ url: "javascript:alert(1)" }),
      ),
    );

    renderPage();

    await user.click(await screen.findByRole("button", { name: /invoice\.pdf/ }));

    expect(open).not.toHaveBeenCalled();
    expect(await screen.findByText("첨부파일 링크를 열지 못했습니다.")).toBeVisible();
    open.mockRestore();
  });
});
