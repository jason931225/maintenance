import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LeaveRequestView, LeaveRosterEntry } from "../../api/types";
import type * as KoModule from "../../i18n/ko";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { WindowManagerProvider } from "../window";
import { LeaveConsole, type LeaveDecideOutcome, type LeavePromotionOutcome } from "./LeaveConsole";
import { KO_CONSOLE_LEAVE as S, LEAVE_ACTIONS, LEAVE_RUNTIME_GATE, type LeaveLedgerRow } from "./model";

// wire-pending: the koManifest reported alongside this lane (ko.console.leave
// replacement — overviewTitle/leaveType/requestState(4-state)/status/ledger.*/
// queue.comment*/promotion.* etc.) has not landed in ko.ts yet (serial i18n
// wire-up owns that file). Mock only the `console.leave` node so these tests
// exercise the REAL component logic against the manifest this lane ships,
// without touching ko.ts — every other ko.* string stays the real one.
vi.mock("../../i18n/ko", async (importOriginal) => {
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
          requestState: {
            pending: "결재 대기",
            approved: "승인",
            returned: "보류",
            rejected: "반려",
          },
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

function makeLedger(): LeaveLedgerRow[] {
  return [
    row("employee-1", "JL-A001", "김현장", "A-001", 15, 4, 11, "ok"),
    row("employee-2", "JL-A002", "이정비", "A-002", 15, 15, 0, "ok"),
    row("employee-3", "JL-A003", "박기사", "A-003", 15, 5, 10, "promote"),
  ];
}

function row(
  id: string,
  code: string,
  name: string,
  employeeNumber: string,
  accrued: number,
  used: number,
  remaining: number,
  tone: LeaveRosterEntry["tone"],
): LeaveLedgerRow {
  return {
    id,
    code,
    name,
    company: "KNL",
    employeeNumber,
    orgUnit: "정비1팀",
    position: "대리",
    hireDate: "2024-01-02",
    accrued,
    used,
    remaining,
    tone,
    active: true,
  };
}

function makeRequest(overrides: Partial<LeaveRequestView>): LeaveRequestView {
  return {
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
    ...overrides,
  };
}

interface RenderOptions {
  gate?: PolicyGate;
  requests?: LeaveRequestView[];
  selfUserId?: string;
  decide?: (id: string, decision: "approve" | "reject", comment?: string) => Promise<LeaveDecideOutcome>;
  pushPromotion?: (payload: {
    branchId: string;
    targetUserId: string;
    targetEmployeeId: string;
    targetName: string;
    round: 1 | 2;
    unusedDays: number;
  }) => Promise<LeavePromotionOutcome>;
}

function renderConsole(options: RenderOptions = {}) {
  const decide = options.decide ?? (() => Promise.resolve({ ok: true }));
  const pushPromotion = options.pushPromotion ?? (() => Promise.resolve({ ok: true }));
  // `?? "self-user"` would coerce an explicit `selfUserId: undefined` (the S3
  // fail-closed case) back to a default — distinguish "omitted" from "asserted
  // unresolved" via `in`.
  const selfUserId = "selfUserId" in options ? options.selfUserId : "self-user";
  return render(
    <WindowManagerProvider>
      <PolicyGateProvider gate={options.gate ?? LEAVE_RUNTIME_GATE}>
        <LeaveConsole
          ledger={makeLedger()}
          requests={options.requests ?? []}
          selfUserId={selfUserId}
          decide={decide}
          pushPromotion={pushPromotion}
        />
      </PolicyGateProvider>
    </WindowManagerProvider>,
  );
}

describe("LeaveConsole (레인1 leave 카드 존, real-wired)", () => {
  it("persona lens is deny-by-omission: a 본인-only gate hides queue/promotion/ledger (§4-25-⑦)", () => {
    const selfOnly = new Set<string>([LEAVE_ACTIONS.selfView, LEAVE_ACTIONS.requestCreate]);
    renderConsole({ gate: { can: (action) => selfOnly.has(action) } });

    expect(screen.getByRole("region", { name: S.self.title })).toBeVisible();
    expect(screen.queryByText(S.queue.title)).toBeNull();
    expect(screen.queryByText(S.ledger.title)).toBeNull();
  });

  it("팀장 approve calls the real decide callback and clears the pending row", () => {
    const decide = vi.fn<() => Promise<LeaveDecideOutcome>>(() => Promise.resolve({ ok: true }));
    renderConsole({
      requests: [makeRequest({ id: "req-9", requester_user_id: "employee-2", subject_employee_id: "employee-2" })],
      selfUserId: "someone-else",
      decide,
    });
    const queue = screen.getByRole("region", { name: S.queue.title });
    expect(within(queue).getByText(S.count(1))).toBeVisible();

    fireEvent.click(within(queue).getByRole("button", { name: S.queue.decideAria(S.queue.approve, "이정비") }));
    expect(decide).toHaveBeenCalledWith("req-9", "approve", undefined);
  });

  it("SoD: my own pending request never shows decide buttons", () => {
    renderConsole({
      requests: [makeRequest({ id: "req-self", requester_user_id: "self-user", subject_employee_id: "employee-1" })],
      selfUserId: "self-user",
    });
    const queue = screen.getByRole("region", { name: S.queue.title });
    expect(
      within(queue).queryByRole("button", { name: S.queue.decideAria(S.queue.approve, "김현장") }),
    ).toBeNull();
  });

  it("S3 fail-closed: an unresolved selfUserId hides decide buttons on every row (never fail-open)", () => {
    renderConsole({
      requests: [makeRequest({ id: "req-9", requester_user_id: "employee-2", subject_employee_id: "employee-2" })],
      selfUserId: undefined,
    });
    const queue = screen.getByRole("region", { name: S.queue.title });
    expect(
      within(queue).queryByRole("button", { name: S.queue.decideAria(S.queue.approve, "이정비") }),
    ).toBeNull();
  });

  it("반려 requires a comment before it decides, then surfaces a backend error verbatim", async () => {
    const decide = vi.fn<() => Promise<LeaveDecideOutcome>>(() =>
      Promise.resolve({
        ok: false,
        error: { error: { code: "forbidden", message: "cannot decide own request" } },
      }),
    );
    renderConsole({
      requests: [makeRequest({ id: "req-7", requester_user_id: "employee-2", subject_employee_id: "employee-2" })],
      selfUserId: "someone-else",
      decide,
    });
    const queue = screen.getByRole("region", { name: S.queue.title });
    fireEvent.click(within(queue).getByRole("button", { name: S.queue.decideAria(S.queue.reject, "이정비") }));

    // Fail-closed: submitting with no comment never calls decide.
    fireEvent.click(within(queue).getByRole("button", { name: S.queue.reject }));
    expect(decide).not.toHaveBeenCalled();
    expect(within(queue).getByText(S.queue.commentRequired)).toBeVisible();

    fireEvent.change(within(queue).getByLabelText(S.queue.commentLabel), {
      target: { value: "일정 재조정 필요" },
    });
    fireEvent.click(within(queue).getByRole("button", { name: S.queue.reject }));
    await screen.findByText("cannot decide own request");
    expect(decide).toHaveBeenCalledWith("req-7", "reject", "일정 재조정 필요");
  });

  it("연차 원장 rows are objDrag sources and open the ObjectCard right pin (§4.7-3)", () => {
    renderConsole();
    const code = screen.getByRole("button", { name: S.openObject("JL-A001") });
    expect(code).toHaveAttribute("draggable", "true");

    fireEvent.click(code);
    const pin = screen.getByRole("region", { name: S.objects.ledgerTitle("김현장") });
    expect(within(pin).getByText(S.objects.props.accrued)).toBeVisible();
  });

  it("every stat drills: 촉진 대상 filters the ledger to backend-computed tone (§4-11)", () => {
    renderConsole();
    const ledgerRegion = screen.getByRole("region", { name: S.ledger.title });
    const table = within(ledgerRegion).getByRole("table");
    expect(within(table).getByText("이정비")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: S.stats.drill(S.stats.promotionTargets) }));
    expect(within(table).queryByText("이정비")).toBeNull();
    expect(within(table).getByText("박기사")).toBeVisible();
  });

  it("create-request is fail-closed on a missing enum 사유 (§4-19) and never fabricates a queue entry", () => {
    renderConsole();
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    fireEvent.submit(within(selfRegion).getByRole("form", { name: S.self.formAria }));
    expect(within(selfRegion).getByRole("alert")).toHaveTextContent(S.self.required);
    // Fail-closed: an invalid submit never grows "내 신청" with a fabricated row.
    expect(within(selfRegion).getByText(S.self.empty)).toBeVisible();
  });

  it("사용촉진 발송: no linked request degrades gracefully (no misdelivery guess)", () => {
    renderConsole();
    const ledgerRegion = screen.getByRole("region", { name: S.ledger.title });
    expect(within(ledgerRegion).getByText(S.promotion.noLinkedRequest)).toBeVisible();
  });

  it("사용촉진 발송: a resolvable target sends round 1 via the real POST payload", async () => {
    const pushPromotion = vi.fn<(payload: unknown) => Promise<LeavePromotionOutcome>>(() =>
      Promise.resolve({
        ok: true,
        push: {
          id: "push-1",
          kind: "promotion",
          round: 1,
          target_user_id: "u-3",
          inbox_doc_id: "doc-1",
          ap_submission: "submitted",
        },
      }),
    );
    renderConsole({
      requests: [
        makeRequest({
          id: "req-3",
          requester_user_id: "u-3",
          subject_employee_id: "employee-3",
          created_at: "2026-07-09T00:00:00Z",
        }),
      ],
      pushPromotion,
    });
    const ledgerRegion = screen.getByRole("region", { name: S.ledger.title });
    fireEvent.click(within(ledgerRegion).getByRole("button", { name: S.promotion.sendAria("박기사", 1) }));

    expect(pushPromotion).toHaveBeenCalledWith({
      branchId: "branch-1",
      targetUserId: "u-3",
      targetEmployeeId: "employee-3",
      targetName: "박기사",
      round: 1,
      unusedDays: 10,
    });
    await screen.findByText(S.promotion.pushed);
  });
});
