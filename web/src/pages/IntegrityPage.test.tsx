import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

const APPROVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUESTER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FINDING_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const users = [
  {
    id: APPROVER,
    display_name: "김대표",
    phone: "010-1111-2222",
    team: "OFFICE",
    roles: ["EXECUTIVE"],
    branch_ids: [],
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: REQUESTER,
    display_name: "이기안",
    phone: "010-3333-4444",
    team: "MAINTENANCE",
    roles: ["MECHANIC"],
    branch_ids: [],
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
  },
];

const selfApprovalFinding = {
  id: FINDING_ID,
  org_id: "00000000-0000-4000-8000-000000000001",
  detector_id: "anomaly.self_approval",
  entity_type: "financial_purchase_request",
  entity_id: "11111111-1111-4111-8111-111111111111",
  source_audit_event_id: null,
  subject_user_id: APPROVER,
  score: 1.0,
  severity: "HIGH",
  evidence: {
    action: "approve_executive",
    requested_by: REQUESTER,
    submitted_by: REQUESTER,
    approver: APPROVER,
    exemption_reason: "org_lead_exempt",
  },
  status: "OPEN",
  detected_at: "2026-06-12T09:00:00Z",
  created_at: "2026-06-12T09:00:00Z",
  updated_at: "2026-06-12T09:00:00Z",
  reviewed_by: null,
  reviewed_at: null,
  review_memo: null,
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

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const executiveSession: AuthSession = {
  access_token: "a",
  roles: ["EXECUTIVE"],
};

function mockFindings(findings: unknown[]) {
  server.use(
    http.get("*/api/v1/integrity/findings", () => HttpResponse.json(findings)),
    http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
  );
}

const allowDecision = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  decided_at: "2026-06-12T10:00:00Z",
  subject_ref: "user:김대표",
  action: "role_manage",
  resource_type: "policy_role",
  resource_id: null,
  effect: "allow",
  determining_policies: ["policy-role-manage-01"],
  reason: "principal has role_manage on policy_role",
};

const denyDecision = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  decided_at: "2026-06-12T11:00:00Z",
  subject_ref: "user:이기안",
  action: "role_manage",
  resource_type: "policy_role",
  resource_id: "role-42",
  effect: "deny",
  determining_policies: [],
  reason: "no matching permit policy",
};

describe("IntegrityPage gating", () => {
  it("redirects an ADMIN away from /integrity (EXECUTIVE/SUPER_ADMIN only)", async () => {
    renderApp(
      "/integrity",
      makeAuthContext({ access_token: "a", roles: ["ADMIN"] }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "이상 징후 검토" }),
      ).not.toBeInTheDocument();
    });
  });

  it("redirects a MECHANIC away from /integrity", async () => {
    renderApp(
      "/integrity",
      makeAuthContext({ access_token: "a", roles: ["MECHANIC"] }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "이상 징후 검토" }),
      ).not.toBeInTheDocument();
    });
  });

  it("renders the page for an EXECUTIVE", async () => {
    mockFindings([]);
    renderApp("/integrity", makeAuthContext(executiveSession));
    expect(
      await screen.findByRole("heading", { name: "이상 징후 검토" }),
    ).toBeVisible();
  });

  it("renders the page for a SUPER_ADMIN", async () => {
    mockFindings([]);
    renderApp(
      "/integrity",
      makeAuthContext({ access_token: "a", roles: ["SUPER_ADMIN"] }),
    );
    expect(
      await screen.findByRole("heading", { name: "이상 징후 검토" }),
    ).toBeVisible();
  });
});

describe("IntegrityPage listing", () => {
  it("shows the empty state when there are no findings", async () => {
    mockFindings([]);
    renderApp("/integrity", makeAuthContext(executiveSession));
    expect(
      await screen.findByText("검토가 필요한 항목이 없습니다."),
    ).toBeVisible();
  });

  it("surfaces the error state when the list fails to load", async () => {
    server.use(
      http.get("*/api/v1/integrity/findings", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
    );
    renderApp("/integrity", makeAuthContext(executiveSession));
    expect(
      await screen.findByText("검토 항목을 불러오지 못했습니다."),
    ).toBeVisible();
  });

  it("renders a self-approval finding with display names (never raw UUIDs)", async () => {
    mockFindings([selfApprovalFinding]);
    renderApp("/integrity", makeAuthContext(executiveSession));

    // Detector label + neutral framing, not accusatory.
    expect(await screen.findByText("자가 승인 기록")).toBeVisible();
    expect(
      screen.getByText(
        "본인이 상신·요청한 건을 본인이 결재한 기록입니다.",
      ),
    ).toBeVisible();

    // Subject + approver resolved to a display name; the raw UUID never shows.
    // (이기안 is both the requester and submitter, so it renders more than once.)
    expect(screen.getAllByText("김대표").length).toBeGreaterThan(0);
    expect(screen.getAllByText("이기안").length).toBeGreaterThan(0);
    expect(screen.queryByText(APPROVER)).not.toBeInTheDocument();
    expect(screen.queryByText(REQUESTER)).not.toBeInTheDocument();

    // Severity + status badges and the exemption basis. ("검토 대기" also appears
    // as a filter <option>, so scope the status badge to the finding's row.)
    expect(screen.getByText("대표 권한 결재 허용")).toBeVisible();
    const row = screen.getByText("자가 승인 기록").closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLLIElement).getByText("검토 대기")).toBeVisible();
    expect(within(row as HTMLLIElement).getByText("높음")).toBeVisible();
  });

  it("requests a status filter when one is chosen", async () => {
    const seen: string[] = [];
    server.use(
      http.get("*/api/v1/integrity/findings", ({ request }) => {
        const url = new URL(request.url);
        seen.push(url.searchParams.get("status") ?? "ALL");
        return HttpResponse.json([]);
      }),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
    );
    const user = userEvent.setup();
    renderApp("/integrity", makeAuthContext(executiveSession));

    await screen.findByText("검토가 필요한 항목이 없습니다.");
    await user.selectOptions(screen.getByLabelText("상태"), "OPEN");

    await waitFor(() => {
      expect(seen).toContain("OPEN");
    });
  });
});

describe("IntegrityPage triage", () => {
  it("triages a finding as 검토 완료 and posts the new status", async () => {
    const triaged = vi.fn();
    server.use(
      http.get("*/api/v1/integrity/findings", () =>
        HttpResponse.json([selfApprovalFinding]),
      ),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
      http.post(
        "*/api/v1/integrity/findings/:id/triage",
        async ({ request, params }) => {
          triaged({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            ...selfApprovalFinding,
            status: "REVIEWED",
            reviewed_by: APPROVER,
            reviewed_at: "2026-06-13T01:00:00Z",
            review_memo: null,
          });
        },
      ),
    );
    const user = userEvent.setup();
    renderApp("/integrity", makeAuthContext(executiveSession));

    await user.click(await screen.findByRole("button", { name: "검토 처리" }));
    const dialog = await screen.findByRole("dialog", { name: "검토 처리" });
    await user.click(within(dialog).getByRole("button", { name: "처리 저장" }));

    await waitFor(() => {
      expect(triaged).toHaveBeenCalledWith({
        id: FINDING_ID,
        body: { status: "REVIEWED", memo: null },
      });
    });
  });

  it("requires a memo before dismissing or escalating", async () => {
    const triaged = vi.fn();
    server.use(
      http.get("*/api/v1/integrity/findings", () =>
        HttpResponse.json([selfApprovalFinding]),
      ),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
      http.post("*/api/v1/integrity/findings/:id/triage", () => {
        triaged();
        return HttpResponse.json(selfApprovalFinding);
      }),
    );
    const user = userEvent.setup();
    renderApp("/integrity", makeAuthContext(executiveSession));

    await user.click(await screen.findByRole("button", { name: "검토 처리" }));
    const dialog = await screen.findByRole("dialog", { name: "검토 처리" });
    await user.selectOptions(
      within(dialog).getByLabelText("처리 결과"),
      "DISMISSED",
    );
    await user.click(within(dialog).getByRole("button", { name: "처리 저장" }));

    // Memo is required: the request must NOT fire and an inline error shows.
    expect(
      await within(dialog).findByText("처리 메모를 입력하세요."),
    ).toBeVisible();
    expect(triaged).not.toHaveBeenCalled();

    // Supplying a memo then submits with the typed note.
    await user.type(
      within(dialog).getByLabelText("검토 메모"),
      "시세 상승 확인",
    );
    await user.click(within(dialog).getByRole("button", { name: "처리 저장" }));
    await waitFor(() => {
      expect(triaged).toHaveBeenCalled();
    });
  });

  it("surfaces a 409 conflict when the finding is no longer OPEN", async () => {
    server.use(
      http.get("*/api/v1/integrity/findings", () =>
        HttpResponse.json([selfApprovalFinding]),
      ),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
      http.post("*/api/v1/integrity/findings/:id/triage", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "already triaged" } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp("/integrity", makeAuthContext(executiveSession));

    await user.click(await screen.findByRole("button", { name: "검토 처리" }));
    const dialog = await screen.findByRole("dialog", { name: "검토 처리" });
    await user.click(within(dialog).getByRole("button", { name: "처리 저장" }));

    expect(
      await within(dialog).findByText(/이미 처리된 항목입니다/),
    ).toBeVisible();
  });
});

describe("IntegrityPage decisions tab", () => {
  it("shows the empty state when there are no decisions", async () => {
    mockFindings([]);
    server.use(
      http.get("*/api/v1/policy/decisions", () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp("/integrity", makeAuthContext(executiveSession));

    await user.click(
      await screen.findByRole("button", { name: "정책 판정" }),
    );
    expect(
      await screen.findByText("표시할 정책 판정 기록이 없습니다."),
    ).toBeVisible();
  });

  it("renders allow/deny decisions and drills into the matched policy", async () => {
    mockFindings([]);
    server.use(
      http.get("*/api/v1/policy/decisions", () =>
        HttpResponse.json([denyDecision, allowDecision]),
      ),
    );
    const user = userEvent.setup();
    renderApp("/integrity", makeAuthContext(executiveSession));

    await user.click(
      await screen.findByRole("button", { name: "정책 판정" }),
    );

    expect(await screen.findByText("허용")).toBeVisible();
    expect(screen.getByText("거부")).toBeVisible();
    expect(screen.getByText(/user:김대표/)).toBeVisible();
    expect(screen.getByText(/role-42/)).toBeVisible();

    // Deny-drill: expand the deny row's matched-policy detail.
    const denyRow = screen.getByText("거부").closest("li");
    expect(denyRow).not.toBeNull();
    await user.click(
      within(denyRow as HTMLLIElement).getByText("적용된 정책"),
    );
    expect(
      within(denyRow as HTMLLIElement).getByText("일치한 정책 없음"),
    ).toBeVisible();
    expect(
      within(denyRow as HTMLLIElement).getByText("no matching permit policy"),
    ).toBeVisible();
  });

  it("surfaces the error state when the decision feed fails to load", async () => {
    mockFindings([]);
    server.use(
      http.get("*/api/v1/policy/decisions", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp("/integrity", makeAuthContext(executiveSession));

    await user.click(
      await screen.findByRole("button", { name: "정책 판정" }),
    );
    expect(
      await screen.findByText("정책 판정 기록을 불러오지 못했습니다."),
    ).toBeVisible();
  });
});
