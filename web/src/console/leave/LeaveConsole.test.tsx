import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LeaveRequestView, LeaveRosterEntry } from "../../api/types";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { WindowManagerProvider } from "../window";
import {
  LeaveConsole,
  type LeaveCreateInput,
  type LeaveCreateOutcome,
  type LeaveDecideOutcome,
  type LeavePromotionOutcome,
} from "./LeaveConsole";
import { KO_CONSOLE_LEAVE as S, LEAVE_ACTIONS, LEAVE_RUNTIME_GATE, type LeaveLedgerRow } from "./model";

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
  decide?: (id: string, decision: "approve" | "return" | "reject", comment?: string) => Promise<LeaveDecideOutcome>;
  createRequest?: (input: LeaveCreateInput) => Promise<LeaveCreateOutcome>;
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
  const createRequest = options.createRequest ?? (() => Promise.resolve({ ok: true }));
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
          createRequest={createRequest}
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

  it("보류(return) is a third, distinct decision that also requires a comment (승인/반려/거부)", async () => {
    const decide = vi.fn<() => Promise<LeaveDecideOutcome>>(() => Promise.resolve({ ok: true }));
    renderConsole({
      requests: [makeRequest({ id: "req-ret", requester_user_id: "employee-2", subject_employee_id: "employee-2" })],
      selfUserId: "someone-else",
      decide,
    });
    const queue = screen.getByRole("region", { name: S.queue.title });
    fireEvent.click(
      within(queue).getByRole("button", { name: S.queue.decideAria(S.requestState.returned, "이정비") }),
    );

    // Fail-closed: 보류 with no comment never calls decide.
    fireEvent.click(within(queue).getByRole("button", { name: S.requestState.returned }));
    expect(decide).not.toHaveBeenCalled();
    expect(within(queue).getByText(S.queue.commentRequired)).toBeVisible();

    fireEvent.change(within(queue).getByLabelText(S.queue.commentLabel), {
      target: { value: "서류 보완 요청" },
    });
    fireEvent.click(within(queue).getByRole("button", { name: S.requestState.returned }));
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith("req-ret", "return", "서류 보완 요청");
    });
  });

  it("SoD surfaces 내 신청 on the caller's own pending request (approver ≠ requester made visible)", () => {
    renderConsole({
      requests: [makeRequest({ id: "req-self", requester_user_id: "self-user", subject_employee_id: "employee-1" })],
      selfUserId: "self-user",
    });
    const queue = screen.getByRole("region", { name: S.queue.title });
    expect(within(queue).getByText(S.self.myRequests)).toBeVisible();
    expect(
      within(queue).queryByRole("button", { name: S.queue.decideAria(S.queue.approve, "김현장") }),
    ).toBeNull();
  });

  it("연차 원장 rows are objDrag sources and open the ObjectCard right pin (§4.7-3)", () => {
    renderConsole();
    const code = screen.getByRole("button", { name: S.openObject("JL-A001") });
    expect(code).toHaveAttribute("draggable", "true");

    fireEvent.click(code);
    const pin = screen.getByRole("region", { name: S.objects.ledgerTitle("김현장") });
    expect(within(pin).getByText(S.objects.props.accrued)).toBeVisible();
  });

  it("원장 직원 코드 cell stays single-line (no one-char-per-line wrap) beside an open detail pin", () => {
    renderConsole();
    const codeCell = screen.getByRole("button", { name: S.openObject("JL-A001") }).closest("td");
    expect(codeCell).not.toBeNull();
    expect(codeCell).toHaveStyle({ whiteSpace: "nowrap" });
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

  it("create-request is fail-closed on an incomplete form (§4-19) and never fabricates a queue entry", () => {
    renderConsole();
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    // Validation is derived from the fields, not a manual step — the
    // debug-looking "입력값 확인" button is gone (verdict R9).
    expect(within(selfRegion).queryByText(S.self.validate)).not.toBeInTheDocument();
    // An incomplete form (no 사유/기간) previews nothing and never grows "내
    // 신청" with a fabricated row.
    expect(within(selfRegion).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(selfRegion).getByText(S.self.empty)).toBeVisible();
  });

  it("create-request surfaces the derived range error when 종료일 precedes 시작일 (§4-19)", () => {
    renderConsole();
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.reasonLabel), {
      target: { value: "annual" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.startLabel), {
      target: { value: "2026-07-10" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.endLabel), {
      target: { value: "2026-07-01" },
    });
    expect(within(selfRegion).getByRole("alert")).toHaveTextContent(S.self.invalidRange);
    // Fail-closed: an invalid range never fabricates a queue row.
    expect(within(selfRegion).getByText(S.self.empty)).toBeVisible();
  });

  it("본인 신청: a valid 연차 form submits the derived self-service payload (subject/branch resolved server-side) and confirms", async () => {
    const createRequest = vi.fn<(input: LeaveCreateInput) => Promise<LeaveCreateOutcome>>(() =>
      Promise.resolve({ ok: true }),
    );
    renderConsole({ createRequest });
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.reasonLabel), {
      target: { value: "annual" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.startLabel), {
      target: { value: "2026-07-06" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.endLabel), {
      target: { value: "2026-07-08" },
    });
    fireEvent.click(within(selfRegion).getByRole("button", { name: S.self.submit }));
    // The FE never sends subject_employee_id/branch_id — the backend resolves
    // them from the caller. days is derived server-side, so it isn't sent either.
    await waitFor(() => {
      expect(createRequest).toHaveBeenCalledWith({
        leave_type: "annual",
        start_date: "2026-07-06",
        end_date: "2026-07-08",
        reason: S.reasons.annual,
      });
    });
    await within(selfRegion).findByText(S.self.submitted);
  });

  it("본인 신청: pending submission freezes the draft and suppresses duplicate submission", async () => {
    let resolveRequest!: (outcome: LeaveCreateOutcome) => void;
    const createRequest = vi.fn<(input: LeaveCreateInput) => Promise<LeaveCreateOutcome>>(
      () => new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    renderConsole({ createRequest });
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    const reason = within(selfRegion).getByLabelText(S.self.reasonLabel);
    const startDate = within(selfRegion).getByLabelText(S.self.startLabel);
    const endDate = within(selfRegion).getByLabelText(S.self.endLabel);

    fireEvent.change(reason, { target: { value: "annual" } });
    fireEvent.change(startDate, { target: { value: "2026-07-06" } });
    fireEvent.change(endDate, { target: { value: "2026-07-08" } });
    fireEvent.click(within(selfRegion).getByRole("button", { name: S.self.submit }));

    await waitFor(() => {
      expect(createRequest).toHaveBeenCalledTimes(1);
    });
    expect(reason).toBeDisabled();
    expect(startDate).toBeDisabled();
    expect(endDate).toBeDisabled();
    expect(within(selfRegion).getByRole("button", { name: S.self.submitting })).toBeDisabled();

    fireEvent.change(reason, { target: { value: "half_pm" } });
    fireEvent.change(startDate, { target: { value: "2026-07-09" } });
    fireEvent.submit(within(selfRegion).getByRole("form", { name: S.self.formAria }));
    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(reason).toHaveValue("annual");
    expect(startDate).toHaveValue("2026-07-06");

    resolveRequest({ ok: true });
    await within(selfRegion).findByText(S.self.submitted);
    expect(createRequest).toHaveBeenCalledWith({
      leave_type: "annual",
      start_date: "2026-07-06",
      end_date: "2026-07-08",
      reason: S.reasons.annual,
    });
  });

  it("본인 신청: a rejected request restores the draft, reports failure, and permits retry", async () => {
    const createRequest = vi
      .fn<(input: LeaveCreateInput) => Promise<LeaveCreateOutcome>>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ ok: true });
    renderConsole({ createRequest });
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    const reason = within(selfRegion).getByLabelText(S.self.reasonLabel);
    const startDate = within(selfRegion).getByLabelText(S.self.startLabel);
    const endDate = within(selfRegion).getByLabelText(S.self.endLabel);

    fireEvent.change(reason, { target: { value: "annual" } });
    fireEvent.change(startDate, { target: { value: "2026-07-06" } });
    fireEvent.change(endDate, { target: { value: "2026-07-08" } });
    fireEvent.click(within(selfRegion).getByRole("button", { name: S.self.submit }));

    expect(await within(selfRegion).findByRole("alert")).toHaveTextContent(S.self.submitFailed);
    expect(reason).toBeEnabled();
    expect(startDate).toBeEnabled();
    expect(endDate).toBeEnabled();
    expect(reason).toHaveValue("annual");
    expect(startDate).toHaveValue("2026-07-06");
    expect(endDate).toHaveValue("2026-07-08");

    fireEvent.click(within(selfRegion).getByRole("button", { name: S.self.submit }));
    await waitFor(() => {
      expect(createRequest).toHaveBeenCalledTimes(2);
    });
    await within(selfRegion).findByText(S.self.submitted);
  });

  it("본인 신청: a 반차 maps to half_day on a single date, and a backend rejection surfaces verbatim", async () => {
    const createRequest = vi.fn<(input: LeaveCreateInput) => Promise<LeaveCreateOutcome>>(() =>
      Promise.resolve({ ok: false, error: { error: { message: "잔여 연차가 부족합니다" } } }),
    );
    renderConsole({ createRequest });
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.reasonLabel), {
      target: { value: "half_am" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.startLabel), {
      target: { value: "2026-07-06" },
    });
    fireEvent.click(within(selfRegion).getByRole("button", { name: S.self.submit }));
    await waitFor(() => {
      expect(createRequest).toHaveBeenCalledWith({
        leave_type: "half_day",
        start_date: "2026-07-06",
        end_date: "2026-07-06",
        reason: S.reasons.half_am,
      });
    });
    expect(await within(selfRegion).findByRole("alert")).toHaveTextContent("잔여 연차가 부족합니다");
  });

  it("사용촉진 발송: no linked request degrades gracefully (no misdelivery guess)", () => {
    renderConsole();
    const promotionRegion = screen.getByRole("region", { name: S.promotion.queueTitle });
    expect(within(promotionRegion).getByText(S.promotion.noLinkedRequest)).toBeVisible();
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
    const promotionRegion = screen.getByRole("region", { name: S.promotion.queueTitle });
    fireEvent.click(within(promotionRegion).getByRole("button", { name: S.promotion.sendAria("박기사", 1) }));

    expect(pushPromotion).toHaveBeenCalledWith({
      branchId: "branch-1",
      targetUserId: "u-3",
      targetEmployeeId: "employee-3",
      targetName: "박기사",
      round: 1,
      unusedDays: 10,
    });
    await screen.findByText(S.promotion.pushed);
    // round advances to 2 — the panel keeps offering the next round rather
    // than treating a single push as terminal (regression guard).
    expect(within(promotionRegion).getByRole("button", { name: S.promotion.sendAria("박기사", 2) })).toBeVisible();
  });

  it("소진율 meter: every ledger row shows a burn-rate percent, and 촉진 대상 rows carry the inline chip (§4-11 density)", () => {
    renderConsole();
    const ledgerRegion = screen.getByRole("region", { name: S.ledger.title });
    const table = within(ledgerRegion).getByRole("table");
    const promoteRow = within(table).getByText("박기사").closest("tr");
    expect(promoteRow).not.toBeNull();
    // employee-3: used 5 / accrued 15 = 33%. The trimmed ref-density table
    // (이름·부여·사용·잔여·소진율, no 상태 column) carries the "사용촉진 대상"
    // label once — the inline meter chip on the promote-tone row.
    expect(within(promoteRow as HTMLElement).getByText(S.stats.percent(33))).toBeVisible();
    expect(within(promoteRow as HTMLElement).getAllByText(S.status.promote)).toHaveLength(1);

    const okRow = within(table).getByText("김현장").closest("tr");
    expect(within(okRow as HTMLElement).queryByText(S.status.promote)).toBeNull();
  });

  it("사용 촉진 panel is visible by default whenever there are promotion targets (no extra click)", () => {
    renderConsole();
    expect(screen.getByRole("region", { name: S.promotion.queueTitle })).toBeVisible();
  });
});
