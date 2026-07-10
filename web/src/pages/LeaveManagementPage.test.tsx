import { fireEvent, render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthorizeBulkCache } from "../api/authorizeBulk";
import { createConsoleApiClient } from "../api/client";
import { WindowManagerProvider } from "../console/window";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import type * as KoModule from "../i18n/ko";
import { LeaveManagementPage } from "./LeaveManagementPage";

// wire-pending: same koManifest gap as console/leave/LeaveConsole.test.tsx —
// mock only `console.leave`, everything else stays the real ko.ts.
vi.mock("../i18n/ko", async (importOriginal) => {
  const actual = await importOriginal<typeof KoModule>();
  return {
    ko: {
      ...actual.ko,
      console: {
        ...actual.ko.console,
        leave: {
          count: (count: number) => `${String(count)}건`,
          openObject: (code: string) => `${code} 개체 카드 열기`,
          overviewTitle: "연차 현황",
          leaveType: { annual: "연차", half_day: "반차" },
          stats: {
            aria: "연차 현황 요약",
            headcount: "재직",
            remaining: "잔여",
            burnRate: "소진율",
            promotionTargets: "촉진 대상",
            people: (count: number) => `${String(count)}명`,
            percent: (rate: number) => `${String(rate)}%`,
            drill: (label: string) => `${label} 기준 원장 필터`,
          },
          self: {
            title: "내 연차",
            myRequests: "내 신청",
            empty: "신청 내역 없음",
            formAria: "연차 신청 유효성 확인",
            reasonLabel: "사유",
            reasonPlaceholder: "사유 선택",
            startLabel: "시작일",
            endLabel: "종료일",
            validate: "입력값 확인",
            required: "필수 항목 미입력",
            invalidRange: "종료일이 시작일보다 빠름",
            formLink: "연차신청서로 제출",
            unknownEmployee: "직원 확인 필요",
          },
          reasons: {
            annual: "연차",
            half_am: "반차(오전)",
            half_pm: "반차(오후)",
            family_event: "경조",
            sick: "병가",
          },
          requestState: { pending: "결재 대기", approved: "승인", returned: "보류", rejected: "반려" },
          queue: {
            title: "팀 결재함",
            aria: "결재 대기 신청",
            empty: "결재 대기 없음",
            approve: "승인",
            reject: "반려",
            cancel: "취소",
            commentLabel: "반려 사유",
            commentPlaceholder: "사유 입력",
            commentRequired: "반려 사유를 입력하세요",
            decideAria: (decision: string, employeeName: string) => `${employeeName} 신청 ${decision}`,
            decideFailed: "결재를 처리하지 못했습니다",
          },
          promotion: {
            title: "사용촉진 발송 이력",
            listAria: "사용촉진 발송 이력",
            legalBasis: "근로기준법 제61조",
            roundChip: (round: number) => `${String(round)}차`,
            send: (round: number) => `${String(round)}차 발송`,
            sendAria: (name: string, round: number) => `${name} ${String(round)}차 발송`,
            noLinkedRequest: "연동된 신청 없음",
            done: "촉진 완료",
            pushed: "발송 완료",
            pushFailed: "발송하지 못했습니다",
            apStatus: { submitted: "AP 상신됨", pending_engine_definition: "AP 연동 대기" },
          },
          ledger: {
            title: "인원별 연차 원장",
            usageTitle: "인원별 잔여 연차",
            listAria: "연차 원장 목록",
            columns: {
              employee: "직원",
              department: "부서/직책",
              tenure: "입사일 기준",
              accrued: "발생",
              used: "사용",
              remaining: "잔여",
              status: "상태",
            },
          },
          status: {
            ok: "정상",
            promote: "사용촉진 대상",
            low: "잔여 부족",
            hireDateMissing: "입사일 확인",
            exited: "퇴사/정산 검토",
          },
          objects: {
            ledgerType: "연차 원장",
            ledgerTitle: (name: string) => `${name} 연차 원장`,
            props: { accrued: "발생", used: "사용", remaining: "잔여", hireDate: "입사일" },
          },
        },
      },
    },
  };
});

const server = setupServer();

const adminSession: AuthSession = {
  access_token: "admin-token",
  user_id: "admin-user",
  org_id: "org-1",
  roles: ["ADMIN"],
  branches: ["branch-1"],
};

function makeEmployee(overrides: Record<string, unknown>) {
  return {
    company: "KNL",
    org_unit: "정비1팀",
    position: "대리",
    hire_date: "2024-01-02",
    exit_date: null,
    status: "ACTIVE",
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

const employees = [
  makeEmployee({ id: "employee-1", name: "김현장", employee_number: "A-001" }),
  makeEmployee({ id: "employee-2", name: "이정비", employee_number: "A-002" }),
];

const roster = {
  items: [
    { employee_id: "employee-1", name: "김현장", team: "정비1팀", grant: 15, used: 4, left: 11, tone: "ok" },
    { employee_id: "employee-2", name: "이정비", team: "정비1팀", grant: 15, used: 15, left: 0, tone: "low" },
  ],
};

const requestsPage = {
  items: [
    {
      id: "req-1",
      branch_id: "branch-1",
      requester_user_id: "employee-2",
      subject_employee_id: "employee-2",
      leave_type: "annual",
      days: 1,
      start_date: "2026-07-20",
      end_date: "2026-07-20",
      reason: "개인 사유",
      status: "pending",
      decided_by: null,
      decided_at: null,
      created_at: "2026-07-10T00:00:00Z",
    },
  ],
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  clearAuthorizeBulkCache();
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function makeAuthContext(): AuthContextValue {
  return {
    session: adminSession,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(adminSession.access_token),
  };
}

function useHandlers() {
  server.use(
    http.get("*/api/v1/employees", () => HttpResponse.json({ items: employees, total: 2, limit: 1000, offset: 0 })),
    http.get("*/api/v1/leave/balances", () => HttpResponse.json(roster)),
    http.get("*/api/v1/leave/requests", () => HttpResponse.json(requestsPage)),
    http.post("*/api/v1/policy/authorize/bulk", async ({ request }) => {
      const body = (await request.json()) as { checks: unknown[] };
      return HttpResponse.json({ decisions: body.checks.map(() => ({ effect: "allow" })) });
    }),
  );
}

function renderPage() {
  return render(
    <AuthContext.Provider value={makeAuthContext()}>
      <MemoryRouter>
        <WindowManagerProvider>
          <LeaveManagementPage />
        </WindowManagerProvider>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("LeaveManagementPage (real-wired to /api/v1/leave/*)", () => {
  it("renders the roster + decision queue from the real leave engine", async () => {
    useHandlers();
    renderPage();

    expect(await screen.findByRole("heading", { name: "연차관리", level: 1 })).toBeVisible();
    const ledgerRegion = await screen.findByRole("region", { name: "인원별 연차 원장" });
    expect(within(within(ledgerRegion).getByRole("table")).getByText("이정비")).toBeVisible();
    const queueRegion = screen.getByRole("region", { name: "팀 결재함" });
    expect(within(queueRegion).getByText("이정비")).toBeVisible();
  });

  it("ledger rows are objDrag sources and open the ObjectCard right pin (§4.7-3)", async () => {
    useHandlers();
    renderPage();

    const code = await screen.findByRole("button", { name: "JL-A001 개체 카드 열기" });
    expect(code).toHaveAttribute("draggable", "true");

    fireEvent.click(code);
    const pin = screen.getByRole("region", { name: "김현장 연차 원장" });
    expect(within(pin).getByText("JL-A001")).toBeVisible();
  });

  it("approving a queue row calls the real decide endpoint and refetches the ledger", async () => {
    useHandlers();
    let decideCalls = 0;
    let decided = false;
    server.use(
      http.get("*/api/v1/leave/requests", () =>
        HttpResponse.json(decided ? { items: [] } : requestsPage),
      ),
      http.post("*/api/v1/leave/requests/:id/decide", async ({ request, params }) => {
        decideCalls += 1;
        const body = (await request.json()) as { decision: string };
        expect(params.id).toBe("req-1");
        expect(body.decision).toBe("approve");
        decided = true;
        return HttpResponse.json({ ...requestsPage.items[0], status: "approved" });
      }),
    );

    renderPage();
    const queueRegion = await screen.findByRole("region", { name: "팀 결재함" });
    fireEvent.click(within(queueRegion).getByRole("button", { name: "이정비 신청 승인" }));

    await screen.findByText("결재 대기 없음");
    expect(decideCalls).toBe(1);
  });
});
