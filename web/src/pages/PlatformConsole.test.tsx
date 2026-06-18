import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";

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

const orgs = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "hanbit-logistics",
    name: "한빛물류",
    status: "ACTIVE",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "daeyang-corp",
    name: "대양기업",
    status: "SUSPENDED",
    created_at: "2026-02-01T00:00:00Z",
  },
];

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
    api,
  };
}

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const platformSession: AuthSession = {
  access_token: "platform-token",
  isPlatform: true,
};

const tenantSession: AuthSession = {
  access_token: "tenant-token",
  roles: ["ADMIN"],
  branches: ["11111111-1111-4111-8111-111111111111"],
};

describe("Platform console routing", () => {
  it("routes a platform session to the tenant console list", async () => {
    server.use(
      http.get("*/platform/orgs", () => HttpResponse.json(orgs)),
    );

    renderApp("/platform", makeAuthContext(platformSession));

    expect(
      await screen.findByRole("heading", { name: "테넌트 관리" }),
    ).toBeVisible();
    expect(await screen.findByText("한빛물류")).toBeVisible();
    expect(screen.getByText("대양기업")).toBeVisible();
  });

  it("redirects a tenant session away from /platform", async () => {
    renderApp("/platform/tenants", makeAuthContext(tenantSession));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "테넌트 관리" }),
      ).not.toBeInTheDocument();
    });
  });

  it("redirects a platform session away from a tenant route to /platform", async () => {
    server.use(
      http.get("*/platform/orgs", () => HttpResponse.json(orgs)),
    );

    renderApp("/dispatch", makeAuthContext(platformSession));

    // It lands on the platform console rather than the tenant dispatch board.
    expect(
      await screen.findByRole("heading", { name: "테넌트 관리" }),
    ).toBeVisible();
  });
});

describe("Platform tenant list", () => {
  it("renders rows with status badges", async () => {
    server.use(
      http.get("*/platform/orgs", () => HttpResponse.json(orgs)),
    );

    renderApp("/platform/tenants", makeAuthContext(platformSession));

    const row = (await screen.findByText("한빛물류")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText("hanbit-logistics")).toBeVisible();
    expect(cells.getByText("활성")).toBeVisible();
  });

  it("shows the empty state when there are no tenants", async () => {
    server.use(
      http.get("*/platform/orgs", () => HttpResponse.json([])),
    );

    renderApp("/platform/tenants", makeAuthContext(platformSession));

    expect(
      await screen.findByText("등록된 테넌트가 없습니다."),
    ).toBeVisible();
  });

  it("shows the error state when the list request fails", async () => {
    server.use(
      http.get("*/platform/orgs", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderApp("/platform/tenants", makeAuthContext(platformSession));

    expect(
      await screen.findByText("테넌트 목록을 불러오지 못했습니다."),
    ).toBeVisible();
  });
});

describe("Platform onboard", () => {
  it("posts a new tenant and reveals the one-time OTP", async () => {
    const user = userEvent.setup();
    const posted = vi.fn();
    server.use(
      http.post("*/platform/orgs", async ({ request }) => {
        posted(await request.json());
        return HttpResponse.json(
          {
            org: {
              id: "33333333-3333-4333-8333-333333333333",
              slug: "saerom-tech",
              name: "새롬테크",
              status: "ACTIVE",
              created_at: "2026-06-18T00:00:00Z",
            },
            otp: "OTP-ONCE-9876",
          },
          { status: 201 },
        );
      }),
    );

    renderApp("/platform/onboard", makeAuthContext(platformSession));

    await screen.findByRole("heading", { name: "테넌트 등록" });

    await user.type(screen.getByLabelText("이름"), "새롬테크");
    await user.type(screen.getByLabelText("슬러그"), "saerom-tech");
    await user.click(
      screen.getByRole("button", { name: "테넌트 등록" }),
    );

    await waitFor(() => {
      expect(posted).toHaveBeenCalledWith({
        name: "새롬테크",
        slug: "saerom-tech",
      });
    });

    expect(await screen.findByText("OTP-ONCE-9876")).toBeVisible();
    expect(
      screen.getByText(
        "이 코드는 다시 표시되지 않습니다. 안전한 별도 경로로 전달하세요.",
      ),
    ).toBeVisible();
  });

  it("surfaces a duplicate-slug conflict", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/platform/orgs", () =>
        HttpResponse.json({ error: "duplicate_slug" }, { status: 409 }),
      ),
    );

    renderApp("/platform/onboard", makeAuthContext(platformSession));

    await user.type(screen.getByLabelText("이름"), "중복");
    await user.type(screen.getByLabelText("슬러그"), "taken-slug");
    await user.click(
      screen.getByRole("button", { name: "테넌트 등록" }),
    );

    expect(
      await screen.findByText(
        "이미 사용 중인 슬러그입니다. 다른 값을 입력하세요.",
      ),
    ).toBeVisible();
  });
});
