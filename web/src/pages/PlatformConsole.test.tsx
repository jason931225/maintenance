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
    slug: "acme-corporation",
    name: "Acme Corporation",
    status: "ACTIVE",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "globex-corporation",
    name: "Globex Corporation",
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
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
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
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
    );

    renderApp("/platform", makeAuthContext(platformSession));

    expect(
      await screen.findByRole("heading", { name: "테넌트 관리" }),
    ).toBeVisible();
    expect(await screen.findByText("Acme Corporation")).toBeVisible();
    expect(screen.getByText("Globex Corporation")).toBeVisible();
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
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
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
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
    );

    renderApp("/platform/tenants", makeAuthContext(platformSession));

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText("acme-corporation")).toBeVisible();
    expect(cells.getByText("활성")).toBeVisible();
  });

  it("shows the empty state when there are no tenants", async () => {
    server.use(
      http.get("*/api/platform/orgs", () => HttpResponse.json([])),
    );

    renderApp("/platform/tenants", makeAuthContext(platformSession));

    expect(
      await screen.findByText("등록된 테넌트가 없습니다."),
    ).toBeVisible();
  });

  it("shows the error state when the list request fails", async () => {
    server.use(
      http.get("*/api/platform/orgs", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderApp("/platform/tenants", makeAuthContext(platformSession));

    expect(
      await screen.findByText("테넌트 목록을 불러오지 못했습니다."),
    ).toBeVisible();
  });
});

const opsTenants = {
  tenants: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "acme-corporation",
      name: "Acme Corporation",
      status: "ACTIVE",
      user_count: 12,
      active_user_count: 9,
      active_work_orders: 4,
      open_work_orders: 7,
      last_activity_at: "2026-06-18T09:00:00Z",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      slug: "globex-corporation",
      name: "Globex Corporation",
      status: "SUSPENDED",
      user_count: 3,
      active_user_count: 0,
      active_work_orders: 0,
      open_work_orders: 0,
      last_activity_at: null,
    },
  ],
};

describe("Platform ops dashboard", () => {
  it("renders the cross-tenant health table for a platform session", async () => {
    server.use(http.get("*/api/platform/ops", () => HttpResponse.json(opsTenants)));

    renderApp("/platform/ops", makeAuthContext(platformSession));

    expect(
      await screen.findByRole("heading", { name: "플랫폼 운영 현황" }),
    ).toBeVisible();
    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText("acme-corporation")).toBeVisible();
    expect(cells.getByText("활성")).toBeVisible();
    expect(cells.getByText("12")).toBeVisible();
    expect(cells.getByText("4")).toBeVisible();
    // The no-activity placeholder renders for the suspended tenant.
    const suspendedRow = (await screen.findByText("Globex Corporation")).closest("tr");
    expect(
      within(suspendedRow as HTMLElement).getByText("활동 없음"),
    ).toBeVisible();
  });

  it("shows the empty state when no tenants are returned", async () => {
    server.use(
      http.get("*/api/platform/ops", () => HttpResponse.json({ tenants: [] })),
    );

    renderApp("/platform/ops", makeAuthContext(platformSession));

    expect(
      await screen.findByText("운영 데이터를 불러오면 표시됩니다."),
    ).toBeVisible();
  });

  it("shows the error state when the ops request fails", async () => {
    server.use(
      http.get("*/api/platform/ops", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderApp("/platform/ops", makeAuthContext(platformSession));

    expect(
      await screen.findByText("운영 현황을 불러오지 못했습니다."),
    ).toBeVisible();
  });

  it("redirects a tenant session away from /platform/ops", async () => {
    renderApp("/platform/ops", makeAuthContext(tenantSession));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "플랫폼 운영 현황" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("Platform tenant removal", () => {
  it("removes an empty tenant after confirmation and refreshes the list", async () => {
    const user = userEvent.setup();
    const deleted = vi.fn();
    let listCall = 0;
    server.use(
      http.get("*/api/platform/orgs", () => {
        listCall += 1;
        // First load returns both; after a successful delete the refetch drops Acme.
        return HttpResponse.json(listCall === 1 ? orgs : [orgs[1]]);
      }),
      http.delete("*/api/platform/orgs/:id", ({ params }) => {
        deleted(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderApp("/platform/tenants", makeAuthContext(platformSession));

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "테넌트 삭제" }),
    );

    // The confirm dialog names the tenant and warns it is irreversible.
    const dialog = await screen.findByRole("dialog", { name: "테넌트 삭제" });
    expect(
      within(dialog).getByText(/‘Acme Corporation’ 테넌트를 영구적으로 삭제/),
    ).toBeVisible();
    expect(
      within(dialog).getByText("이 작업은 되돌릴 수 없습니다. 신중히 진행하세요."),
    ).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(deleted).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
      );
    });
    // The dialog closes and the removed tenant is gone from the refreshed list.
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "테넌트 삭제" }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText("Acme Corporation")).not.toBeInTheDocument();
    });
  });

  it("surfaces the 409 archive-instead guard for a tenant with data", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      http.delete("*/api/platform/orgs/:id", () =>
        HttpResponse.json({ error: { code: "tenant_has_data" } }, { status: 409 }),
      ),
    );

    renderApp("/platform/tenants", makeAuthContext(platformSession));

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "테넌트 삭제" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "테넌트 삭제" });
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    // The guard message is surfaced and the dialog stays open (tenant not removed).
    expect(
      await within(dialog).findByText(
        "이 테넌트에는 실제 운영 데이터가 있어 삭제할 수 없습니다. 대신 보관 처리하세요.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Acme Corporation")).toBeVisible();
  });
});

describe("Platform onboard", () => {
  it("posts a new tenant and reveals the one-time OTP", async () => {
    const user = userEvent.setup();
    const posted = vi.fn();
    server.use(
      http.post("*/api/platform/orgs", async ({ request }) => {
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
      http.post("*/api/platform/orgs", () =>
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
