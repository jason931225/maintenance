import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext, type AuthContextValue, type AuthSession } from "../../context/auth";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { MAIL_ACTIONS } from "./mailScreenConfig";
import { MailScreen } from "./MailScreen";

function detailResponseForRequest({
  params,
  request,
}: {
  params: { id?: string | readonly string[] };
  request: Request;
}) {
  const paramId = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = paramId ?? new URL(request.url).pathname.split("/").pop();
  return HttpResponse.json(id === threads[1].id ? secondDetail : firstDetail);
}

const server = setupServer(http.get(/.*\/api\/v1\/mail\/threads\/.*/, detailResponseForRequest));

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(() => {
  server.close();
});

const allowAll: PolicyGate = { can: () => true };

const session: AuthSession = {
  access_token: "token",
  roles: ["ADMIN"],
  feature_grants: ["mail_use"],
};

function makeAuthContext(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
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
    ...overrides,
  };
}

const folders = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    role: "INBOX",
    name: "Inbox",
    unread_count: 2,
    total_count: 8,
  },
  {
    id: "11111111-1111-4111-8111-222222222222",
    role: "SENT",
    name: "Sent",
    unread_count: 0,
    total_count: 3,
  },
];

const threads = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    subject: "급여명세서 확인",
    last_message_at: "2026-06-26T01:00:00Z",
    message_count: 2,
    unread_count: 1,
    has_attachments: true,
    is_flagged: true,
    governance: {
      classification: "confidential",
      retention_label: "R7",
      litigation_hold: true,
    },
  },
  {
    id: "22222222-2222-4222-8222-333333333333",
    subject: "월간 보고",
    last_message_at: "2026-06-26T02:00:00Z",
    message_count: 1,
    unread_count: 0,
    has_attachments: false,
    is_flagged: false,
  },
];

const firstDetail = {
  id: threads[0].id,
  subject: threads[0].subject,
  messages: [
    {
      id: "33333333-3333-4333-8333-111111111111",
      thread_id: threads[0].id,
      direction: "IN",
      message_id: "<previous@example.com>",
      in_reply_to: null,
      from_address: "ops@example.com",
      from_name: "운영팀",
      to: [{ address: "employee@example.com", name: "직원" }],
      cc: [],
      subject: threads[0].subject,
      snippet: "이전 본문",
      body_text: "이전 텍스트",
      body_html: null,
      seen: true,
      flagged: false,
      answered: false,
      has_attachments: false,
      received_at: "2026-06-25T01:00:00Z",
      attachments: [],
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      thread_id: threads[0].id,
      direction: "IN",
      message_id: "<m1@example.com>",
      in_reply_to: "<previous@example.com>",
      from_address: "hr@example.com",
      from_name: "인사팀",
      to: [{ address: "employee@example.com", name: "직원" }],
      cc: [],
      subject: threads[0].subject,
      snippet: "요약 본문",
      body_text: "텍스트 본문만 표시 WO-77",
      body_html:
        "<p onclick=\"alert(1)\"><strong>안전 HTML 본문</strong></p><img src=\"https://tracker.example/pixel\" onerror=\"alert(1)\"><a href=\"javascript:alert(1)\">악성 링크</a><a href=\"https://www.cossok.com/\">공식 링크</a>",
      seen: false,
      flagged: false,
      answered: false,
      has_attachments: true,
      received_at: "2026-06-26T01:00:00Z",
      sender_auth: {
        spf: "pass",
        dkim: "pass",
        dmarc: "fail",
        tls: "verified",
        storage_encryption: "encrypted",
      },
      governance: {
        classification: "sensitive",
        retention_label: "R7",
        litigation_hold: true,
        object_refs: [{ code: "WO-77", kind: "work_order", href: "/work-orders/77" }],
      },
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
};

const secondDetail = {
  id: threads[1].id,
  subject: threads[1].subject,
  messages: [
    {
      ...firstDetail.messages[1],
      id: "33333333-3333-4333-8333-444444444444",
      thread_id: threads[1].id,
      message_id: "<m2@example.com>",
      from_name: "보고팀",
      from_address: "report@example.com",
      subject: threads[1].subject,
      snippet: "월간 보고 본문",
      body_text: "월간 보고 본문 WO-77 CS-9",
      body_html: null,
      attachments: [],
      has_attachments: false,
      governance: {
        classification: "normal",
        object_refs: [
          { code: "WO-77", kind: "work_order", href: "/work-orders/77" },
          { code: "CS-9", kind: "case", href: "javascript:alert(1)" },
        ],
      },
    },
  ],
};

function mockMailbox() {
  server.use(
    http.get("*/api/v1/mail/account", () => HttpResponse.json({ id: "acct", status: "ACTIVE" })),
    http.get("*/api/v1/mail/folders", () => HttpResponse.json(folders)),
    http.get("*/api/v1/mail/threads", () => HttpResponse.json(threads)),
    http.get("*/api/v1/mail/threads/:id", detailResponseForRequest),
    http.get("/api/v1/mail/threads/:id", detailResponseForRequest),
  );
}

function renderMailScreen(gate: PolicyGate = allowAll, ctx = makeAuthContext()) {
  return render(
    <AuthContext.Provider value={ctx}>
      <PolicyGateProvider gate={gate}>
        <MailScreen />
      </PolicyGateProvider>
    </AuthContext.Provider>,
  );
}

describe("MailScreen", () => {
  it("renders the responsive console mail panes, governed chips, download-only attachments, and sanitized bodies", async () => {
    mockMailbox();

    renderMailScreen();

    expect(await screen.findByRole("heading", { name: "메일함" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "메일 폴더" })).toBeVisible();
    expect(screen.getByRole("list", { name: "메일 스레드" })).toBeVisible();
    expect(screen.getByRole("region", { name: "메일 읽기" })).toBeVisible();
    expect(await screen.findByText("받은 편지함")).toBeVisible();
    expect(screen.getByText("2/8")).toBeVisible();
    expect(await screen.findByText("안전 HTML 본문")).toBeVisible();
    expect(screen.getAllByText("대외비").length).toBeGreaterThan(0);
    expect(screen.getAllByText("민감").length).toBeGreaterThan(0);
    expect(screen.getAllByText("보존 R7").length).toBeGreaterThan(0);
    expect(screen.getAllByText("보존명령").length).toBeGreaterThan(0);
    expect(screen.getByText("DMARC 실패")).toBeVisible();
    expect(screen.getByRole("button", { name: "invoice.pdf 다운로드" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "invoice.pdf 인제스트" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "invoice.pdf 증거 등재" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "개체 첨부" })).not.toBeInTheDocument();

    const surface = screen.getByRole("navigation", { name: "메일 폴더" }).closest(".mail-screen__surface");
    expect(surface).not.toBeNull();
    expect(surface).toHaveClass("mail-screen__surface");
    expect(surface?.querySelector(".mail-screen__threads")).toBeTruthy();
    expect(surface?.querySelector(".mail-screen__reader")).toBeTruthy();

    const body = screen.getByTestId("mail-html-body");
    expect(body.querySelector("img, script")).toBeNull();
    expect(body.querySelector("[onclick]")).toBeNull();
    expect(body.querySelector("a[href^='javascript:']")).toBeNull();
    const safeLink = within(body).getByRole("link", { name: "공식 링크" });
    expect(safeLink).toHaveAttribute("target", "_blank");
    expect(safeLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("supports J/K thread selection, Enter read-state, and explicit mark-read calls", async () => {
    const patched = vi.fn();
    mockMailbox();
    server.use(
      http.patch("*/api/v1/mail/threads/:id/read-state", async ({ request }) => {
        patched(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderMailScreen();

    const list = await screen.findByRole("list", { name: "메일 스레드" });
    fireEvent.keyDown(list, { key: "j" });
    expect(
      await screen.findByText("월간 보고 본문", { exact: false }, { timeout: 20_000 }),
    ).toBeVisible();
    const safeObjectLink = await screen.findByRole("link", { name: "WO-77" });
    expect(safeObjectLink).toHaveAttribute("href", "/work-orders/77");
    expect(screen.queryByRole("link", { name: "CS-9" })).not.toBeInTheDocument();
    fireEvent.keyDown(list, { key: "k" });
    fireEvent.keyDown(list, { key: "Enter" });

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({ seen: true });
    });
    await userEvent.click(await screen.findByRole("button", { name: "읽지 않음으로 표시" }));
    await waitFor(() => {
      expect(patched).toHaveBeenLastCalledWith({ seen: false });
    });
  });

  it("sends new, reply, and forward messages through existing mail endpoints", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    const replied = vi.fn();
    const forwarded = vi.fn();
    mockMailbox();
    server.use(
      http.post("*/api/v1/mail/send", async ({ request }) => {
        sent(await request.json());
        return HttpResponse.json({ message_id: "sent", rfc_message_id: "<sent@example.com>" }, { status: 201 });
      }),
      http.post("*/api/v1/mail/reply", async ({ request }) => {
        replied(await request.json());
        return HttpResponse.json({ message_id: "reply", rfc_message_id: "<reply@example.com>" }, { status: 201 });
      }),
      http.post("*/api/v1/mail/forward", async ({ request }) => {
        forwarded(await request.json());
        return HttpResponse.json({ message_id: "forward", rfc_message_id: "<forward@example.com>" }, { status: 201 });
      }),
    );

    renderMailScreen();

    const composer = await screen.findByRole("form", { name: "메일 작성" });
    await user.type(within(composer).getByLabelText("받는 사람"), "payroll@example.com");
    await user.type(within(composer).getByLabelText("제목"), "정산 확인");
    await user.type(within(composer).getByLabelText("본문"), "확인 부탁드립니다.");
    await user.click(within(composer).getByRole("button", { name: "메일 보내기" }));

    await waitFor(() => { expect(sent).toHaveBeenCalledTimes(1); });
    expect(sent.mock.calls[0][0]).toMatchObject({
      to: [{ address: "payroll@example.com" }],
      subject: "정산 확인",
      body_text: "확인 부탁드립니다.",
    });

    await user.click(await screen.findByRole("button", { name: "답장" }));
    await user.type(within(composer).getByLabelText("본문"), "확인했습니다.");
    await user.click(within(composer).getByRole("button", { name: "답장 보내기" }));
    await waitFor(() => { expect(replied).toHaveBeenCalledTimes(1); });
    expect(replied.mock.calls[0][0]).toMatchObject({
      to: [{ address: "hr@example.com" }],
      subject: "Re: 급여명세서 확인",
      in_reply_to: "<m1@example.com>",
      references: ["<previous@example.com>", "<m1@example.com>"],
    });

    await user.click(await screen.findByRole("button", { name: "전달" }));
    await user.type(within(composer).getByLabelText("받는 사람"), "manager@example.com");
    await user.type(within(composer).getByLabelText("본문"), "검토 부탁드립니다.");
    await user.click(within(composer).getByRole("button", { name: "전달 보내기" }));
    await waitFor(() => { expect(forwarded).toHaveBeenCalledTimes(1); });
    expect(forwarded.mock.calls[0][0]).toMatchObject({
      to: [{ address: "manager@example.com" }],
      subject: "Fwd: 급여명세서 확인",
      in_reply_to: "<m1@example.com>",
      references: ["<previous@example.com>", "<m1@example.com>"],
    });
  });

  it("omits policy-denied affordances and uses stable mail policy action names", async () => {
    const seen: string[] = [];
    const gate: PolicyGate = {
      can: (action) => {
        seen.push(action);
        return action === MAIL_ACTIONS.read || action === MAIL_ACTIONS.governanceView;
      },
    };
    mockMailbox();

    renderMailScreen(gate);

    expect(await screen.findByRole("heading", { name: "메일함" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "답장" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "전달" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "메일 보내기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "invoice.pdf 다운로드" })).not.toBeInTheDocument();
    expect(seen).toEqual(expect.arrayContaining([
      MAIL_ACTIONS.read,
      MAIL_ACTIONS.send,
      MAIL_ACTIONS.markRead,
      MAIL_ACTIONS.governanceView,
    ]));
  });

  it("fails closed for sensitive or attachment egress when governance evaluation is unavailable", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    mockMailbox();
    server.use(
      http.post("*/api/v1/mail/send", async ({ request }) => {
        sent(await request.json());
        return HttpResponse.json({ message_id: "sent", rfc_message_id: "<sent@example.com>" }, { status: 201 });
      }),
    );

    renderMailScreen();

    const composer = await screen.findByRole("form", { name: "메일 작성" });
    await user.type(within(composer).getByLabelText("받는 사람"), "external@example.com");
    await user.type(within(composer).getByLabelText("제목"), "대외 발송");
    await user.type(within(composer).getByLabelText("본문"), "첨부 확인 부탁드립니다.");
    await user.click(within(composer).getByRole("button", { name: "민감" }));
    await user.click(within(composer).getByRole("button", { name: "메일 보내기" }));

    expect(await screen.findByRole("alert", { name: "반출 차단" })).toBeVisible();
    expect(screen.getAllByText("민감").length).toBeGreaterThan(0);
    expect(screen.getByText("승인 요청")).toBeVisible();
    expect(screen.queryByRole("button", { name: "승인 요청" })).not.toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
  });
});
