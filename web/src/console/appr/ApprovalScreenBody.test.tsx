import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext, type AuthContextValue } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { ApprovalScreenBody } from "./ApprovalScreenBody";

const server = setupServer();
const T = ko.console.appr;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function renderBody(roles: string[]) {
  const authValue = {
    session: { access_token: "appr-token", user_id: "user-9", roles },
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api: createConsoleApiClient("appr-token"),
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  } as unknown as AuthContextValue;
  return render(
    <AuthContext.Provider value={authValue}>
      <ApprovalScreenBody />
    </AuthContext.Provider>,
  );
}

describe("ApprovalScreenBody", () => {
  it("mounts the real approval-compose surface bound to the session token", async () => {
    let sawAuth = false;
    server.use(
      http.get("*/api/v1/workflow-studio/submittable-definitions", ({ request }) => {
        sawAuth = request.headers.get("authorization") === "Bearer appr-token";
        return HttpResponse.json({ items: [] });
      }),
    );

    renderBody(["MEMBER"]);

    // The compose section renders for any signed-in role (aria-label = 전자결재)
    // and its submittable-definitions read carries the session bearer token.
    expect(await screen.findByRole("region", { name: T.title })).toBeInTheDocument();
    expect(sawAuth).toBe(true);
  });
});
