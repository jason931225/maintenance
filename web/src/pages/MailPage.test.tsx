import { render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext, type AuthContextValue, type AuthSession } from "../context/auth";
import { MailPage } from "./MailPage";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

const adminSession: AuthSession = {
  access_token: "a",
  roles: ["ADMIN"],
};

const featureGrantSession: AuthSession = {
  access_token: "feature",
  roles: ["MEMBER"],
  feature_grants: ["mail_use"],
};

const deniedSession: AuthSession = {
  access_token: "denied",
  roles: ["MEMBER"],
};

const folders = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    role: "INBOX",
    name: "Inbox",
    unread_count: 1,
    total_count: 4,
  },
];

const threads = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    subject: "급여명세서 확인",
    last_message_at: "2026-06-26T01:00:00Z",
    message_count: 1,
    unread_count: 1,
    has_attachments: true,
    is_flagged: false,
    governance: {
      classification: "confidential",
      retention_label: "R7",
      litigation_hold: true,
    },
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

function mockMailbox() {
  server.use(
    http.get("*/api/v1/mail/account", () => HttpResponse.json({ id: "acct", status: "ACTIVE" })),
    http.get("*/api/v1/mail/folders", () => HttpResponse.json(folders)),
    http.get("*/api/v1/mail/threads", () => HttpResponse.json(threads)),
    http.get(/.*\/api\/v1\/mail\/threads\/.*/, () => HttpResponse.json(detail)),
  );
}

function renderPage(session: AuthSession = adminSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MailPage />
    </AuthContext.Provider>,
  );
}

describe("MailPage", () => {
  it("mounts the console mail screen with route-level mail roles", async () => {
    mockMailbox();

    renderPage();

    expect(await screen.findByRole("heading", { name: "메일함" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "메일 폴더" })).toBeVisible();
    expect(await screen.findByText("안전 HTML 본문")).toBeVisible();
    expect(screen.getByRole("button", { name: "invoice.pdf 인제스트" })).toBeVisible();
    expect(screen.getByRole("button", { name: "메일 보내기" })).toBeVisible();

    const body = screen.getByTestId("mail-html-body");
    expect(body.querySelector("img, script")).toBeNull();
    expect(body.querySelector("[onclick]")).toBeNull();
    expect(body.querySelector("a[href^='javascript:']")).toBeNull();
    expect(within(body).getByRole("link", { name: "공식 링크" })).toHaveAttribute("target", "_blank");
  });

  it("allows explicit mail_use grants and denies sessions without route mail access", async () => {
    mockMailbox();

    const { unmount } = renderPage(featureGrantSession);
    expect(await screen.findByRole("heading", { name: "메일함" })).toBeVisible();
    expect(screen.getByRole("button", { name: "메일 보내기" })).toBeVisible();
    unmount();

    renderPage(deniedSession);
    expect(screen.queryByRole("heading", { name: "메일함" })).not.toBeInTheDocument();
  });
});