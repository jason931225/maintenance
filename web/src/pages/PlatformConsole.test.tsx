import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  MemoryRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
} from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ProtectedRoute } from "../components/ProtectedRoute";
import { RequirePlatformRoute } from "../components/RequirePlatformRoute";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import {
  createRefreshAuthority,
  createRefreshCoordinator,
  setRefreshCallbacks,
} from "../api/refresh";
import { PlatformOpsPage } from "../features/platform/PlatformOpsPage";
import { PlatformGroupsPage } from "./PlatformGroupsPage";
import { PlatformAccountPage } from "./PlatformAccountPage";
import { PlatformOnboardPage } from "./PlatformOnboardPage";
import { PlatformTenantsPage } from "./PlatformTenantsPage";

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
    group_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    group_slug: "group",
    group_name: "그룹",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "globex-corporation",
    name: "Globex Corporation",
    status: "SUSPENDED",
    group_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    group_slug: "external",
    group_name: "외부그룹",
    created_at: "2026-02-01T00:00:00Z",
  },
];

const platformGroups = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "group",
    name: "그룹",
    status: "ACTIVE",
    member_count: 1,
    members: [
      {
        id: orgs[0].id,
        slug: orgs[0].slug,
        name: orgs[0].name,
        status: orgs[0].status,
      },
    ],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    slug: "external",
    name: "외부그룹",
    status: "ACTIVE",
    member_count: 0,
    members: [],
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
];

const emptyGroupAccountsHandler = http.get(
  "*/api/platform/groups/:groupId/accounts",
  () => HttpResponse.json([]),
);

function makeAuthContext(
  session: AuthSession,
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
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
    enterViewAs: () => true,
    exitViewAs: () => undefined,
    api,
    ...overrides,
  };
}

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/dispatch" element={<h1>Dispatch Board</h1>} />
          </Route>
          <Route element={<RequirePlatformRoute />}>
            <Route path="/platform" element={<Outlet />}>
              <Route
                index
                element={<Navigate to="/platform/tenants" replace />}
              />
              <Route path="tenants" element={<PlatformTenantsPage />} />
              <Route path="groups" element={<PlatformGroupsPage />} />
              <Route path="ops" element={<PlatformOpsPage />} />
              <Route path="account" element={<PlatformAccountPage />} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function renderPlatformPage(
  page: ReactNode,
  path: string,
  ctx = makeAuthContext(platformSession),
) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
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
    server.use(http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)));

    renderApp("/platform", makeAuthContext(platformSession));

    expect(
      await screen.findByRole("heading", { name: "테넌시 관리" }),
    ).toBeVisible();
    expect(await screen.findByText("Acme Corporation")).toBeVisible();
    expect(screen.getByText("Globex Corporation")).toBeVisible();
  });

  it("uses the provider authority to recover a stale platform-console bearer", async () => {
    const authority = createRefreshAuthority(
      createRefreshCoordinator(),
      "platform-ui-source-incarnation",
    );
    const refresh = vi.fn(() => Promise.resolve({ access_token: "fresh-platform-token" }));
    setRefreshCallbacks(authority, refresh, () => {});
    server.use(
      http.get("*/api/platform/orgs", ({ request }) =>
        request.headers.get("authorization") === "Bearer fresh-platform-token"
          ? HttpResponse.json(orgs)
          : HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const ctx = makeAuthContext(platformSession);
    Object.assign(ctx, {
      refreshAuthority: authority,
      sourceRefreshAuthority: authority,
    });
    renderApp("/platform/tenants", ctx);

    expect(await screen.findByText("Acme Corporation")).toBeVisible();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("redirects a tenant session away from /platform", async () => {
    renderApp("/platform/tenants", makeAuthContext(tenantSession));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "테넌시 관리" }),
      ).not.toBeInTheDocument();
    });
  });

  it("redirects a platform session away from a tenant route to /platform", async () => {
    server.use(http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)));

    renderApp("/dispatch", makeAuthContext(platformSession));

    // It lands on the platform console rather than the tenant dispatch board.
    expect(
      await screen.findByRole("heading", { name: "테넌시 관리" }),
    ).toBeVisible();
  });

  it("routes platform admins to the group management surface", async () => {
    server.use(
      http.get("*/api/platform/groups", () =>
        HttpResponse.json(platformGroups),
      ),
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      emptyGroupAccountsHandler,
    );

    renderApp("/platform/groups", makeAuthContext(platformSession));

    expect(
      await screen.findByRole("heading", { name: "그룹 관리" }),
    ).toBeVisible();
    expect(await screen.findByText("그룹")).toBeVisible();
    expect(screen.getByText("Acme Corporation")).toBeVisible();
  });

  it("routes platform admins to self-service account settings", async () => {
    server.use(
      http.get("*/api/v1/auth/passkeys", () => HttpResponse.json([])),
    );

    renderApp("/platform/account", makeAuthContext(platformSession));

    expect(
      await screen.findByRole("heading", { name: "플랫폼 계정 설정" }),
    ).toBeVisible();
    expect(await screen.findByText("등록된 패스키가 없습니다.")).toBeVisible();
  });
});

describe("Platform tenant list", () => {
  it("renders rows with status badges", async () => {
    server.use(http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)));

    renderPlatformPage(<PlatformTenantsPage />, "/platform/tenants");

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText("acme-corporation")).toBeVisible();
    expect(cells.getByText("활성")).toBeVisible();
    expect(cells.getByText("그룹")).toBeVisible();
  });

  it("filters tenant management by group and individual organization", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)));

    renderPlatformPage(<PlatformTenantsPage />, "/platform/tenants");

    expect(await screen.findByText("Acme Corporation")).toBeVisible();
    expect(screen.getByText("Globex Corporation")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("보기 범위"), [
      `group:${orgs[0].group_id}`,
    ]);
    expect(screen.getByText("Acme Corporation")).toBeVisible();
    expect(screen.queryByText("Globex Corporation")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("보기 범위"), [
      `org:${orgs[1].id}`,
    ]);
    expect(await screen.findByText("Globex Corporation")).toBeVisible();
    expect(screen.queryByText("Acme Corporation")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no tenants", async () => {
    server.use(http.get("*/api/platform/orgs", () => HttpResponse.json([])));

    renderPlatformPage(<PlatformTenantsPage />, "/platform/tenants");

    expect(await screen.findByText("등록된 테넌시가 없습니다.")).toBeVisible();
  });

  it("shows the error state when the list request fails", async () => {
    server.use(
      http.get("*/api/platform/orgs", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderPlatformPage(<PlatformTenantsPage />, "/platform/tenants");

    expect(
      await screen.findByText("테넌시 목록을 불러오지 못했습니다."),
    ).toBeVisible();
  });

  it("starts a writable tenant management context for an active org", async () => {
    const user = userEvent.setup();
    const started = vi.fn();
    const enterViewAs = vi.fn(() => true);
    server.use(
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      http.post("*/api/platform/tenant-context", async ({ request }) => {
        started(await request.json());
        return HttpResponse.json({
          access_token: "tenant-management-token",
          token_type: "Bearer",
          acting_org_id: orgs[0].id,
          acting_org_name: orgs[0].name,
          acting_role: "SUPER_ADMIN",
          expires_at: "2026-06-19T00:00:00Z",
        });
      }),
    );

    renderPlatformPage(
      <PlatformTenantsPage />,
      "/platform/tenants",
      makeAuthContext(platformSession, { enterViewAs }),
    );

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "조직 관리" }),
    );

    await waitFor(() => {
      expect(started).toHaveBeenCalledWith({ org_id: orgs[0].id });
    });
    await waitFor(() => {
      expect(enterViewAs).toHaveBeenCalledWith({
        token: "tenant-management-token",
        mode: "MANAGE",
        actingOrgId: orgs[0].id,
        actingOrgName: orgs[0].name,
        actingRole: "SUPER_ADMIN",
      });
    });
  });

  it("keeps the platform page authoritative when tenant-context adoption is rejected", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      http.post("*/api/platform/tenant-context", () =>
        HttpResponse.json({
          access_token: "retired-tenant-token",
          token_type: "Bearer",
          acting_org_id: orgs[0].id,
          acting_org_name: orgs[0].name,
          acting_role: "SUPER_ADMIN",
          expires_at: "2026-06-19T00:00:00Z",
        }),
      ),
    );
    renderPlatformPage(
      <PlatformTenantsPage />,
      "/platform/tenants",
      makeAuthContext(platformSession, { enterViewAs: () => false }),
    );

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "조직 관리" }),
    );

    expect(
      await screen.findByText("조직 관리 모드로 전환하지 못했습니다. 다시 시도하세요."),
    ).toBeVisible();
    expect(screen.getByText("Acme Corporation")).toBeVisible();
  });
});

describe("Platform group management", () => {
  it("shows Elso's subsidiary slug as lso in group lists", async () => {
    const elsoOrg = {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "elso",
      name: "(주)엘소",
      status: "ACTIVE",
      group_id: platformGroups[0].id,
      group_slug: platformGroups[0].slug,
      group_name: platformGroups[0].name,
      created_at: "2026-03-01T00:00:00Z",
    };
    const elsoGroup = {
      ...platformGroups[0],
      member_count: 1,
      members: [
        {
          id: elsoOrg.id,
          slug: elsoOrg.slug,
          name: elsoOrg.name,
          status: elsoOrg.status,
        },
      ],
    };

    server.use(
      http.get("*/api/platform/groups", () => HttpResponse.json([elsoGroup])),
      http.get("*/api/platform/orgs", () => HttpResponse.json([elsoOrg])),
      http.get("*/api/platform/groups/:groupId/accounts", () =>
        HttpResponse.json([
          {
            user_id: "99999999-9999-4999-8999-999999999999",
            display_name: "엘소 관리자",
            phone: null,
            tenant_roles: ["MEMBER"],
            is_active: true,
            has_passkey: true,
            account_status: "ACTIVE",
            org_id: elsoOrg.id,
            org_slug: "elso",
            org_name: elsoOrg.name,
            group_roles: ["GROUP_ADMIN"],
            created_at: "2026-03-01T00:00:00Z",
          },
        ]),
      ),
    );

    renderPlatformPage(<PlatformGroupsPage />, "/platform/groups");

    expect((await screen.findAllByText("(주)엘소"))[0]).toBeVisible();
    expect(screen.getAllByText("lso").length).toBeGreaterThan(0);
    expect(screen.queryByText("elso")).not.toBeInTheDocument();
  });

  it("renders groups separately from tenancy and member organizations", async () => {
    server.use(
      http.get("*/api/platform/groups", () =>
        HttpResponse.json(platformGroups),
      ),
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      emptyGroupAccountsHandler,
    );

    renderPlatformPage(<PlatformGroupsPage />, "/platform/groups");

    expect(
      await screen.findByRole("heading", { name: "그룹 관리" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "그룹" })).toBeVisible();
    expect(screen.getByText(/소속 조직 1개/)).toBeVisible();
    expect(screen.getByText("Acme Corporation")).toBeVisible();
    expect(screen.getAllByText("보기 범위")[0]).toBeVisible();
    expect(screen.getAllByText(/전체 그룹\/조직.*그룹.*조직/)[0]).toBeVisible();
  });

  it("edits group identity and creates a tenant-anchored group account", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    const created = vi.fn();
    let group = platformGroups[0];
    let accounts: unknown[] = [];
    server.use(
      http.get("*/api/platform/groups", () =>
        HttpResponse.json([group, platformGroups[1]]),
      ),
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      http.get("*/api/platform/groups/:groupId/accounts", () =>
        HttpResponse.json(accounts),
      ),
      http.patch("*/api/platform/groups/:groupId", async ({ request }) => {
        const body = (await request.json()) as { name: string; slug: string };
        patched(body);
        group = { ...group, ...body };
        return HttpResponse.json(group);
      }),
      http.post(
        "*/api/platform/groups/:groupId/accounts",
        async ({ request }) => {
          const body = await request.json();
          created(body);
          const account = {
            user_id: "99999999-9999-4999-8999-999999999999",
            display_name: "개발자",
            phone: "webservicepost@gmail.com",
            tenant_roles: ["MEMBER"],
            is_active: true,
            has_passkey: false,
            account_status: "PENDING_SETUP",
            org_id: orgs[0].id,
            org_slug: orgs[0].slug,
            org_name: orgs[0].name,
            group_roles: ["GROUP_ADMIN"],
            created_at: "2026-06-26T00:00:00Z",
          };
          accounts = [account];
          return HttpResponse.json(
            {
              account,
              otp: "otp-123456",
              otp_expires_at: "2026-06-27T00:00:00Z",
            },
            { status: 201 },
          );
        },
      ),
    );

    renderPlatformPage(<PlatformGroupsPage />, "/platform/groups");

    await screen.findByRole("heading", { name: "그룹" });
    await user.clear(screen.getAllByLabelText("그룹명")[1]);
    await user.type(screen.getAllByLabelText("그룹명")[1], "그룹 본사");
    await user.clear(screen.getAllByLabelText("슬러그")[1]);
    await user.type(screen.getAllByLabelText("슬러그")[1], "group-hq");
    await user.click(screen.getAllByRole("button", { name: "그룹 저장" })[0]);

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        name: "그룹 본사",
        slug: "group-hq",
      });
    });
    expect(
      await screen.findByRole("heading", { name: "그룹 본사" }),
    ).toBeVisible();

    await user.selectOptions(screen.getAllByLabelText("소속 조직/테넌시")[0], [
      orgs[0].id,
    ]);
    await user.type(screen.getAllByLabelText("이름")[0], "개발자");
    await user.type(
      screen.getAllByLabelText("연락처 또는 이메일")[0],
      "webservicepost@gmail.com",
    );
    await user.click(
      screen.getAllByRole("button", { name: "그룹 계정 추가" })[0],
    );

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({
        org_id: orgs[0].id,
        display_name: "개발자",
        phone: "webservicepost@gmail.com",
        tenant_roles: ["MEMBER"],
        group_role: "GROUP_ADMIN",
      });
    });
    expect(await screen.findByText(/otp-123456/)).toBeVisible();
    expect((await screen.findAllByText("가입 대기")).length).toBeGreaterThan(0);
  });

  it("assigns an organization to a group and refreshes membership", async () => {
    const user = userEvent.setup();
    const assigned = vi.fn();
    let assignedGlobex = false;
    server.use(
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      http.get("*/api/platform/groups", () =>
        HttpResponse.json(
          assignedGlobex
            ? [
                {
                  ...platformGroups[0],
                  member_count: 2,
                  members: [
                    ...platformGroups[0].members,
                    {
                      id: orgs[1].id,
                      slug: orgs[1].slug,
                      name: orgs[1].name,
                      status: orgs[1].status,
                    },
                  ],
                },
                platformGroups[1],
              ]
            : platformGroups,
        ),
      ),
      emptyGroupAccountsHandler,
      http.put(
        "*/api/platform/groups/:groupId/organizations/:orgId",
        ({ params }) => {
          assigned(params);
          assignedGlobex = true;
          return HttpResponse.json({
            ...orgs[1],
            group_id: platformGroups[0].id,
            group_slug: platformGroups[0].slug,
            group_name: platformGroups[0].name,
          });
        },
      ),
    );

    renderPlatformPage(<PlatformGroupsPage />, "/platform/groups");

    await screen.findByRole("heading", { name: "그룹" });
    await user.selectOptions(screen.getAllByLabelText("자회사/조직 배정")[0], [
      orgs[1].id,
    ]);
    await user.click(screen.getAllByRole("button", { name: "그룹에 배정" })[0]);

    await waitFor(() => {
      expect(assigned).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: platformGroups[0].id,
          orgId: orgs[1].id,
        }),
      );
    });
    expect(await screen.findByText(/소속 조직 2개/)).toBeVisible();
    expect(screen.getByText("Globex Corporation")).toBeVisible();
  });

  it("starts a writable organization-management context from a group member", async () => {
    const user = userEvent.setup();
    const started = vi.fn();
    const enterViewAs = vi.fn(() => true);
    server.use(
      http.get("*/api/platform/groups", () =>
        HttpResponse.json(platformGroups),
      ),
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      emptyGroupAccountsHandler,
      http.post("*/api/platform/tenant-context", async ({ request }) => {
        started(await request.json());
        return HttpResponse.json({
          access_token: "tenant-management-token",
          token_type: "Bearer",
          acting_org_id: orgs[0].id,
          acting_org_name: orgs[0].name,
          acting_role: "SUPER_ADMIN",
          expires_at: "2026-06-19T00:00:00Z",
        });
      }),
    );

    renderPlatformPage(
      <PlatformGroupsPage />,
      "/platform/groups",
      makeAuthContext(platformSession, { enterViewAs }),
    );

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "조직 관리" }),
    );

    await waitFor(() => {
      expect(started).toHaveBeenCalledWith({ org_id: orgs[0].id });
    });
    await waitFor(() => {
      expect(enterViewAs).toHaveBeenCalledWith({
        token: "tenant-management-token",
        mode: "MANAGE",
        actingOrgId: orgs[0].id,
        actingOrgName: orgs[0].name,
        actingRole: "SUPER_ADMIN",
      });
    });
  });

  it("does not leave group management after a retired tenant-context response", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/platform/groups", () => HttpResponse.json(platformGroups)),
      http.get("*/api/platform/orgs", () => HttpResponse.json(orgs)),
      emptyGroupAccountsHandler,
      http.post("*/api/platform/tenant-context", () =>
        HttpResponse.json({
          access_token: "retired-tenant-token",
          token_type: "Bearer",
          acting_org_id: orgs[0].id,
          acting_org_name: orgs[0].name,
          acting_role: "SUPER_ADMIN",
          expires_at: "2026-06-19T00:00:00Z",
        }),
      ),
    );
    renderPlatformPage(
      <PlatformGroupsPage />,
      "/platform/groups",
      makeAuthContext(platformSession, { enterViewAs: () => false }),
    );

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "조직 관리" }),
    );

    expect(
      await screen.findByText("조직 관리 모드로 전환하지 못했습니다. 다시 시도하세요."),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "그룹 관리" })).toBeVisible();
  });
});

const opsTenants = {
  tenants: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "acme-corporation",
      name: "Acme Corporation",
      status: "ACTIVE",
      group_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      group_slug: "group",
      group_name: "그룹",
      user_count: 12,
      active_user_count: 9,
      active_work_orders: 4,
      open_work_orders: 7,
      last_activity_at: "2026-06-18T09:00:00Z",
      route_adoption: [
        {
          release_cycle: "2026.07.2",
          console_route_events: 42,
          legacy_route_events: 0,
          rum_error_events: 1,
          rum_perf_p95_ms: 180,
          last_event_at: "2026-06-18T09:30:00Z",
        },
      ],
      zero_legacy_release_cycles: 2,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      slug: "globex-corporation",
      name: "Globex Corporation",
      status: "SUSPENDED",
      group_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      group_slug: "external",
      group_name: "외부그룹",
      user_count: 3,
      active_user_count: 0,
      active_work_orders: 0,
      open_work_orders: 0,
      last_activity_at: null,
      route_adoption: [],
      zero_legacy_release_cycles: 0,
    },
  ],
};

describe("Platform ops dashboard", () => {
  it("renders the cross-tenant health table for a platform session", async () => {
    server.use(
      http.get("*/api/platform/ops", () => HttpResponse.json(opsTenants)),
    );

    renderPlatformPage(<PlatformOpsPage />, "/platform/ops");

    expect(
      await screen.findByRole("heading", { name: "플랫폼 운영 현황" }),
    ).toBeVisible();
    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText("acme-corporation")).toBeVisible();
    expect(cells.getByText("그룹")).toBeVisible();
    expect(cells.getByText("활성")).toBeVisible();
    expect(cells.getByText("12")).toBeVisible();
    expect(cells.getByText("4")).toBeVisible();
    expect(
      cells.getByText("2026.07.2 · 콘솔 42 / 기존 0 · 오류 1 · p95 180ms · 무기존 릴리스 2"),
    ).toBeVisible();
    // The no-activity placeholder renders for the suspended tenant.
    const suspendedRow = (
      await screen.findByText("Globex Corporation")
    ).closest("tr");
    expect(
      within(suspendedRow as HTMLElement).getByText("활동 없음"),
    ).toBeVisible();
  });

  it("filters platform ops by group", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/platform/ops", () => HttpResponse.json(opsTenants)),
    );

    renderPlatformPage(<PlatformOpsPage />, "/platform/ops");

    expect(await screen.findByText("Acme Corporation")).toBeVisible();
    expect(screen.getByText("Globex Corporation")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("보기 범위"), [
      `group:${opsTenants.tenants[0].group_id}`,
    ]);
    expect(screen.getByText("Acme Corporation")).toBeVisible();
    expect(screen.queryByText("Globex Corporation")).not.toBeInTheDocument();
  });

  it("shows the empty state when no tenants are returned", async () => {
    server.use(
      http.get("*/api/platform/ops", () => HttpResponse.json({ tenants: [] })),
    );

    renderPlatformPage(<PlatformOpsPage />, "/platform/ops");

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

    renderPlatformPage(<PlatformOpsPage />, "/platform/ops");

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

    renderPlatformPage(<PlatformTenantsPage />, "/platform/tenants");

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "테넌시 삭제" }),
    );

    // The confirm dialog names the tenant and warns it is irreversible.
    const dialog = await screen.findByRole("dialog", { name: "테넌시 삭제" });
    expect(
      within(dialog).getByText(/‘Acme Corporation’ 테넌시를 영구적으로 삭제/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        "이 작업은 되돌릴 수 없습니다. 신중히 진행하세요.",
      ),
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
        screen.queryByRole("dialog", { name: "테넌시 삭제" }),
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
        HttpResponse.json(
          { error: { code: "tenant_has_data" } },
          { status: 409 },
        ),
      ),
    );

    renderPlatformPage(<PlatformTenantsPage />, "/platform/tenants");

    const row = (await screen.findByText("Acme Corporation")).closest("tr");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "테넌시 삭제" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "테넌시 삭제" });
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    // The guard message is surfaced and the dialog stays open (tenant not removed).
    expect(
      await within(dialog).findByText(
        "이 테넌시에는 실제 운영 데이터가 있어 삭제할 수 없습니다. 대신 보관 처리하세요.",
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

    renderPlatformPage(<PlatformOnboardPage />, "/platform/onboard");

    await screen.findByRole("heading", { name: "테넌시 등록" });

    await user.type(screen.getByLabelText("이름"), "새롬테크");
    await user.type(screen.getByLabelText("슬러그"), "saerom-tech");
    await user.click(screen.getByRole("button", { name: "테넌시 등록" }));

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

    renderPlatformPage(<PlatformOnboardPage />, "/platform/onboard");

    await user.type(screen.getByLabelText("이름"), "중복");
    await user.type(screen.getByLabelText("슬러그"), "taken-slug");
    await user.click(screen.getByRole("button", { name: "테넌시 등록" }));

    expect(
      await screen.findByText(
        "이미 사용 중인 슬러그입니다. 다른 값을 입력하세요.",
      ),
    ).toBeVisible();
  });
});
