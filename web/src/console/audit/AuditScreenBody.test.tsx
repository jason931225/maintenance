import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext, type AuthContextValue } from "../../context/auth";
import { AuditScreenBody } from "./AuditScreenBody";

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

function renderBody(token: string | undefined) {
  const authValue = {
    session: token ? { access_token: token, roles: ["ADMIN"] } : undefined,
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api: createConsoleApiClient(token),
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  } as unknown as AuthContextValue;
  return render(
    <AuthContext.Provider value={authValue}>
      <AuditScreenBody />
    </AuthContext.Provider>,
  );
}

describe("AuditScreenBody", () => {
  it("binds the session token to the real audit feed and renders returned records", async () => {
    let sawAuth = false;
    server.use(
      http.get("*/api/audit", ({ request }) => {
        sawAuth = request.headers.get("authorization") === "Bearer audit-token";
        return HttpResponse.json({
          items: [
            {
              id: "audit-1",
              actor: "11111111-1111-4111-8111-111111111111",
              action: "policy.role.create",
              target_type: "policy_role",
              target_id: "ROLE-9",
              branch_id: null,
              before_snap: null,
              after_snap: { status: "active" },
              trace_id: "trace-0000000000000000000000001",
              span_id: "span-1",
              occurred_at: "2026-03-15T08:30:15Z",
            },
          ],
        });
      }),
    );

    renderBody("audit-token");

    expect(await screen.findByText("ROLE-9")).toBeVisible();
    expect(screen.getByText("policy.role.create")).toBeVisible();
    expect(sawAuth).toBe(true);
  });
});
