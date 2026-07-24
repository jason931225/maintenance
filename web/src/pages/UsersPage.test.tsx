import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import { userPage } from "../test/fixtures";

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

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BRANCH_B = "22222222-2222-4222-8222-222222222222";

const branches = [
  {
    id: BRANCH_A,
    region_id: "r1",
    name: "강남지점",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: BRANCH_B,
    region_id: "r1",
    name: "분당지점",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const users = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    display_name: "제갈태수",
    employee_id: null,
    employee_name: null,
    employee_number: null,
    employee_company: null,
    employee_org_unit: null,
    employee_position: null,
    employee_identity_review_required: null,
    employee_identity_resolution_confidence: null,
    employee_link_status: "UNLINKED",
    phone: "010-1234-5678",
    team: "MAINTENANCE",
    roles: ["MECHANIC"],
    branch_ids: [BRANCH_A],
    is_active: true,
    has_passkey: true,
    account_status: "ACTIVE",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const employees = [
  {
    id: "99999999-9999-4999-8999-999999999999",
    company: "코스",
    name: "제갈태수",
    employee_number: "COSS-1001",
    org_unit: "정비팀",
    worksite_name: "본사",
    job: "정비",
    position: "팀장",
    hire_date: "2024-01-01",
    exit_date: null,
    status: "ACTIVE",
    leave_accrued: "15.00",
    leave_used: "2.00",
    leave_remaining: "13.00",
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "88888888-8888-4888-8888-888888888888",
    company: "코스",
    name: "동명이인",
    employee_number: null,
    org_unit: "물류팀",
    worksite_name: "창고",
    job: "물류",
    position: "사원",
    hire_date: null,
    exit_date: null,
    status: "ACTIVE",
    leave_accrued: null,
    leave_used: null,
    leave_remaining: null,
    identity_resolution_strategy: "source_row_fingerprint",
    identity_resolution_confidence: "low",
    identity_review_required: true,
    identity_name_only_merge: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

function employeePage(items = employees) {
  return { items, limit: 1000, offset: 0, total: items.length };
}

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

const adminSession: AuthSession = {
  access_token: "a",
  roles: ["ADMIN"],
  branches: [BRANCH_A],
};

describe("UsersPage gating", () => {
  it("redirects a non-admin away from /settings/users", async () => {
    renderApp(
      "/settings/users",
      makeAuthContext({ access_token: "a", roles: ["MECHANIC"] }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "사용자 관리" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("UsersPage listing", () => {
  it("renders users in a table with team, role, and branch labels", async () => {
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const row = (await screen.findByText("제갈태수")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    // The MAINTENANCE team renders as "정비"; the MECHANIC role as "정비사".
    expect(cells.getByText("정비")).toBeVisible();
    expect(cells.getByText("정비사")).toBeVisible();
    expect(cells.getByText("강남지점")).toBeVisible();
  });

  it("shows whether each platform user is linked to a 직원 record", async () => {
    const linkedUser = {
      ...users[0],
      employee_id: employees[0].id,
      employee_name: employees[0].name,
      employee_number: employees[0].employee_number,
      employee_company: employees[0].company,
      employee_org_unit: employees[0].org_unit,
      employee_position: employees[0].position,
      employee_identity_review_required: false,
      employee_identity_resolution_confidence: "high",
      employee_link_status: "LINKED",
    };
    const unlinkedUser = {
      ...users[0],
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      display_name: "동명이인",
      employee_id: null,
      employee_name: null,
      employee_identity_review_required: null,
      employee_identity_resolution_confidence: null,
      employee_link_status: "UNLINKED",
    };
    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(userPage([linkedUser, unlinkedUser])),
      ),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    const linkedRow = rows.find((row) =>
      within(row).queryByText("직원 연결됨"),
    );
    expect(linkedRow).toBeDefined();
    expect(within(linkedRow as HTMLElement).getByText("직원 연결됨")).toBeVisible();
    expect(
      within(linkedRow as HTMLElement).getByText("COSS-1001 · 정비팀 · 팀장"),
    ).toBeVisible();

    const unlinkedRow = (await screen.findByText("동명이인")).closest("tr");
    expect(unlinkedRow).not.toBeNull();
    expect(within(unlinkedRow as HTMLElement).getByText("직원 미연결")).toBeVisible();
  });

  it("shows pending setup instead of active for users without a passkey", async () => {
    const pendingUser = {
      ...users[0],
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      display_name: "가입대기",
      has_passkey: false,
      account_status: "PENDING_SETUP",
    };
    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(userPage([pendingUser])),
      ),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const row = (await screen.findByText("가입대기")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText("설정 대기")).toBeVisible();
    expect(cells.queryByText("활성")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no users", async () => {
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(userPage([]))),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    expect(await screen.findByText("등록된 사용자가 없습니다.")).toBeVisible();
  });

  it("paginates by offset against the real total and appends the next page", async () => {
    const user = userEvent.setup();
    const secondUser = {
      ...users[0],
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      display_name: "다음사람",
    };
    const offsets: string[] = [];
    server.use(
      http.get("*/api/v1/users", ({ request }) => {
        const offset = new URL(request.url).searchParams.get("offset") ?? "0";
        offsets.push(offset);
        // total = 2 but each page returns one row, so "더 보기" is offered until
        // the appended rows reach the total.
        return HttpResponse.json(
          offset === "0" ? userPage(users, 2) : userPage([secondUser], 2),
        );
      }),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    // First page rendered; the honest total (2) drives the "더 보기" control.
    expect(await screen.findByText("제갈태수")).toBeVisible();
    const loadMore = await screen.findByRole("button", { name: /더 보기/ });
    await user.click(loadMore);

    // The second page is appended (not replaced) and the second offset was sent.
    expect(await screen.findByText("다음사람")).toBeVisible();
    expect(screen.getByText("제갈태수")).toBeVisible();
    await waitFor(() => {
      expect(offsets).toContain("1");
    });
  });
});

describe("UsersPage create", () => {
  it("validates required fields and posts a new user", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(userPage([]))),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/users", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          {
            id: "new",
            display_name: "정민규",
            employee_id: null,
            employee_name: null,
            employee_number: null,
            employee_company: null,
            employee_org_unit: null,
            employee_position: null,
            employee_identity_review_required: null,
            employee_identity_resolution_confidence: null,
            employee_link_status: "UNLINKED",
            phone: null,
            team: "MAINTENANCE",
            roles: ["MECHANIC"],
            branch_ids: [BRANCH_A],
            is_active: true,
            has_passkey: false,
            account_status: "PENDING_SETUP",
            created_at: "2026-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    await screen.findByText("등록된 사용자가 없습니다.");

    // Open the create slide-over from the page header.
    await user.click(screen.getByRole("button", { name: "사용자 등록" }));
    const drawer = within(await screen.findByRole("dialog"));

    // Submitting empty surfaces the name validation error.
    await user.click(drawer.getByRole("button", { name: "사용자 등록" }));
    expect(await screen.findByText("이름을 입력하세요.")).toBeVisible();

    await user.type(drawer.getByLabelText("이름"), "정민규");
    // Still missing a role.
    await user.click(drawer.getByRole("button", { name: "사용자 등록" }));
    expect(
      await screen.findByText("역할을 하나 이상 선택하세요."),
    ).toBeVisible();

    await user.click(drawer.getByLabelText("정비사"));
    await user.click(drawer.getByLabelText("강남지점"));
    expect(
      drawer.queryByText(/정책은 고정값이 아니라/),
    ).not.toBeInTheDocument();
    await user.click(drawer.getByRole("button", { name: "사용자 등록" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({
        display_name: "정민규",
        phone: null,
        team: "MAINTENANCE",
        roles: ["MECHANIC"],
        branch_ids: [BRANCH_A],
      });
    });
  });
});

describe("UsersPage edit", () => {
  it("keeps an existing executive role when granting 관리자", async () => {
    const user = userEvent.setup();
    const executive = {
      ...users[0],
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      display_name: "임원",
      roles: ["EXECUTIVE"],
      branch_ids: [BRANCH_A],
    };
    const patched = vi.fn();

    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(userPage([executive])),
      ),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.patch("*/api/v1/users/:id", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({
          ...executive,
          roles: ["EXECUTIVE", "ADMIN"],
        });
      }),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1];
    await user.click(within(row).getByRole("button", { name: "수정" }));

    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByLabelText("임원")).toBeChecked();
    await user.click(drawer.getByLabelText("관리자"));
    await user.click(drawer.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        display_name: "임원",
        phone: "010-1234-5678",
        team: "MAINTENANCE",
        roles: ["EXECUTIVE", "ADMIN"],
        branch_ids: [BRANCH_A],
        employee_id: null,
      });
    });
  });

  it("shows and clears the MEMBER role when a self-signup user is elevated", async () => {
    const user = userEvent.setup();
    const pendingAdmin = {
      ...users[0],
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      display_name: "고민지",
      roles: ["MEMBER", "ADMIN"],
      branch_ids: [BRANCH_A],
    };
    const patched = vi.fn();

    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(userPage([pendingAdmin])),
      ),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.patch("*/api/v1/users/:id", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({
          ...pendingAdmin,
          roles: ["ADMIN"],
        });
      }),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1];
    await user.click(within(row).getByRole("button", { name: "수정" }));

    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByLabelText("일반 멤버")).toBeChecked();
    expect(drawer.getByLabelText("관리자")).toBeChecked();
    await user.click(drawer.getByLabelText("일반 멤버"));
    await user.click(drawer.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        display_name: "고민지",
        phone: "010-1234-5678",
        team: "MAINTENANCE",
        roles: ["ADMIN"],
        branch_ids: [BRANCH_A],
        employee_id: null,
      });
    });
  });

  it("lets an admin explicitly set and clear the linked 직원 record", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    const unlinkedUser = {
      ...users[0],
      employee_id: null,
      employee_name: null,
      employee_identity_review_required: null,
      employee_identity_resolution_confidence: null,
      employee_link_status: "UNLINKED",
    };

    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(userPage([unlinkedUser])),
      ),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.get("*/api/v1/employees", () => HttpResponse.json(employeePage())),
      http.patch("*/api/v1/users/:id", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({
          ...unlinkedUser,
          employee_id: employees[0].id,
          employee_name: employees[0].name,
          employee_identity_review_required: false,
          employee_identity_resolution_confidence: "high",
          employee_link_status: "LINKED",
        });
      }),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1];
    await user.click(within(row).getByRole("button", { name: "수정" }));

    const drawer = within(await screen.findByRole("dialog"));
    await user.selectOptions(
      await drawer.findByLabelText("직원 연결"),
      employees[0].id,
    );
    await user.click(drawer.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        display_name: "제갈태수",
        phone: "010-1234-5678",
        team: "MAINTENANCE",
        roles: ["MECHANIC"],
        branch_ids: [BRANCH_A],
        employee_id: employees[0].id,
      });
    });
  });

  it("sends null when an admin clears an existing 직원 link", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    const linkedUser = {
      ...users[0],
      employee_id: employees[0].id,
      employee_name: employees[0].name,
      employee_number: employees[0].employee_number,
      employee_company: employees[0].company,
      employee_org_unit: employees[0].org_unit,
      employee_position: employees[0].position,
      employee_identity_review_required: false,
      employee_identity_resolution_confidence: "high",
      employee_link_status: "LINKED",
    };

    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(userPage([linkedUser])),
      ),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.get("*/api/v1/employees", () => HttpResponse.json(employeePage())),
      http.patch("*/api/v1/users/:id", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ ...linkedUser, employee_id: null });
      }),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1];
    await user.click(within(row).getByRole("button", { name: "수정" }));

    const drawer = within(await screen.findByRole("dialog"));
    await user.selectOptions(await drawer.findByLabelText("직원 연결"), "");
    await user.click(drawer.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        display_name: "제갈태수",
        phone: "010-1234-5678",
        team: "MAINTENANCE",
        roles: ["MECHANIC"],
        branch_ids: [BRANCH_A],
        employee_id: null,
      });
    });
  });
});

describe("UsersPage no-credential UX", () => {
  it("shows the no-credential banner and a prominent OTP button after creating a user", async () => {
    const user = userEvent.setup();
    const newUser = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      display_name: "정민규",
      employee_id: null,
      employee_name: null,
      employee_number: null,
      employee_company: null,
      employee_org_unit: null,
      employee_position: null,
      employee_identity_review_required: null,
      employee_identity_resolution_confidence: null,
      employee_link_status: "UNLINKED",
      phone: null,
      team: "MAINTENANCE",
      roles: ["MECHANIC"],
      branch_ids: [BRANCH_A],
      is_active: true,
      has_passkey: false,
      account_status: "PENDING_SETUP",
      created_at: "2026-01-02T00:00:00Z",
    };

    server.use(
      // Initially empty user list, then returns the new user after creation.
      http.get("*/api/v1/users", () => HttpResponse.json(userPage([]))),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/users", () =>
        HttpResponse.json(newUser, { status: 201 }),
      ),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));
    await screen.findByText("등록된 사용자가 없습니다.");

    // Update the GET handler to return the newly created user.
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(userPage([newUser]))),
    );

    // Open the create slide-over, fill it in, and submit.
    await user.click(screen.getByRole("button", { name: "사용자 등록" }));
    const drawer = within(await screen.findByRole("dialog"));
    await user.type(drawer.getByLabelText("이름"), "정민규");
    await user.click(drawer.getByLabelText("정비사"));
    await user.click(drawer.getByLabelText("강남지점"));
    await user.click(drawer.getByRole("button", { name: "사용자 등록" }));

    // The no-credential prompt banner should appear.
    expect(
      await screen.findByText(
        "사용자가 등록되었습니다. 로그인 자격증명이 없으므로 아래에서 일회용 코드를 발급해 전달하세요.",
      ),
    ).toBeVisible();

    // The no-credential badge should appear in the new user's row.
    const row = (await screen.findByText("정민규")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("로그인 불가")).toBeVisible();
  });
});

describe("UsersPage OTP issue", () => {
  it("issues a sign-in OTP and shows the code", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/auth/admin/otp/issue", () =>
        HttpResponse.json({
          user_id: users[0].id,
          otp: "ABCD1234",
          expires_at: "2026-06-19T00:00:00Z",
        }),
      ),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const row = (await screen.findByText("제갈태수")).closest("tr");
    expect(row).not.toBeNull();
    // The OTP action lives behind the row overflow ("더보기") menu.
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: /추가 작업/ }),
    );
    await user.click(
      within(row as HTMLElement).getByRole("menuitem", {
        name: "일회용 코드 발급",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "일회용 코드 발급" }),
    );

    expect(await within(dialog).findByText("ABCD1234")).toBeVisible();
  });
});

describe("UsersPage credential reset", () => {
  it("revokes the user's passkeys, reissues a sign-in code, and shows it", async () => {
    const user = userEvent.setup();
    const resetBody = vi.fn();
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/auth/admin/credential-reset", async ({ request }) => {
        resetBody(await request.json());
        return HttpResponse.json({
          user_id: users[0].id,
          otp: "RESET999",
          expires_at: "2026-06-19T00:00:00Z",
        });
      }),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const row = (await screen.findByText("제갈태수")).closest("tr");
    expect(row).not.toBeNull();
    // Open the reset dialog from the user's row overflow ("더보기") menu.
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: /추가 작업/ }),
    );
    await user.click(
      within(row as HTMLElement).getByRole("menuitem", {
        name: "패스키 재설정 / 로그인 코드 재발급",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    // The dialog must warn that existing passkeys are revoked.
    expect(within(dialog).getByText(/기존 패스키가 모두 삭제/)).toBeVisible();

    // Trigger the reset and confirm the returned one-time code is shown.
    await user.click(
      within(dialog).getByRole("button", {
        name: "패스키 재설정 및 코드 발급",
      }),
    );

    expect(await within(dialog).findByText("RESET999")).toBeVisible();
    await waitFor(() => {
      expect(resetBody).toHaveBeenCalledWith({ user_id: users[0].id });
    });
  });
});
