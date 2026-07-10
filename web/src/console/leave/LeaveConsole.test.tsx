import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { WindowManagerProvider } from "../window";
import { LeaveConsole } from "./LeaveConsole";
import {
  KO_CONSOLE_LEAVE as S,
  LEAVE_ACTIONS,
  LEAVE_RUNTIME_GATE,
  type LeaveLedgerRow,
} from "./model";

function makeLedger(): LeaveLedgerRow[] {
  return [
    row("employee-1", "JL-A001", "김현장", "A-001", 15, 4, 11),
    row("employee-2", "JL-A002", "이정비", "A-002", 15, 15, 0),
    row("employee-3", "JL-A003", "박기사", "A-003", 15, 5, 10),
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
    active: true,
  };
}

function renderConsole(gate: PolicyGate = LEAVE_RUNTIME_GATE) {
  return render(
    <WindowManagerProvider>
      <PolicyGateProvider gate={gate}>
        <LeaveConsole ledger={makeLedger()} />
      </PolicyGateProvider>
    </WindowManagerProvider>,
  );
}

describe("LeaveConsole (레인1 leave 카드 존)", () => {
  it("persona lens is deny-by-omission: a 본인-only gate hides queue/promotion/ledger (§4-25-⑦)", () => {
    const selfOnly = new Set<string>([
      LEAVE_ACTIONS.selfView,
      LEAVE_ACTIONS.requestCreate,
      LEAVE_ACTIONS.requestWithdraw,
    ]);
    renderConsole({ can: (action) => selfOnly.has(action) });

    expect(screen.getByRole("region", { name: S.self.title })).toBeVisible();
    expect(screen.queryByText(S.queue.title)).toBeNull();
    expect(screen.queryByText("사용촉진·사용계획서 알림")).toBeNull();
    expect(screen.queryByText("인원별 연차 원장")).toBeNull();
  });

  it("팀장 decide mutates the ledger and the drillable stats; SoD hides self-approval", () => {
    renderConsole();
    const queue = screen.getByRole("region", { name: S.queue.title });
    expect(within(queue).getByText(S.count(2))).toBeVisible();

    // Approving 박기사's 1-day request (AP-1202) burns a day: 잔여 21일 → 20일.
    expect(screen.getByText(dayText(21))).toBeVisible();
    fireEvent.click(
      within(queue).getByRole("button", { name: S.queue.decideAria(S.queue.approve, "AP-1202") }),
    );
    expect(screen.getByText(dayText(20))).toBeVisible();
    expect(within(queue).queryByText("AP-1202")).toBeNull();

    // SoD: my own pending request never shows decide buttons.
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.reasonLabel), {
      target: { value: "annual" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.startLabel), {
      target: { value: "2026-07-20" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.endLabel), {
      target: { value: "2026-07-20" },
    });
    fireEvent.submit(within(selfRegion).getByRole("form", { name: S.self.formAria }));
    expect(within(queue).getByText("AP-1211")).toBeVisible();
    expect(
      within(queue).queryByRole("button", { name: S.queue.decideAria(S.queue.approve, "AP-1211") }),
    ).toBeNull();
  });

  it("촉진 회차 FSM: 수령 확인 → 완료 → 2차 촉진 시작 → 2차 발송 대기 (§4.7-6 single CTA)", () => {
    renderConsole();
    const promotion = screen.getByRole("region", { name: "사용촉진·사용계획서 알림" });
    const rounds = within(promotion).getByRole("list", { name: S.promotion.listAria });

    // Round CTAs carry object-scoped accessible names (decideAria → "R-290 수령 확인").
    fireEvent.click(
      within(rounds).getByRole("button", { name: S.queue.decideAria(S.promotion.ack, "R-290") }),
    );
    expect(within(rounds).getByText(S.promotion.phase.done)).toBeVisible();

    fireEvent.click(
      within(rounds).getByRole("button", {
        name: S.queue.decideAria(S.promotion.startSecond, "R-290"),
      }),
    );
    expect(within(rounds).getByText(S.promotion.roundChip(2))).toBeVisible();
    expect(within(rounds).getByText(S.promotion.phase.send)).toBeVisible();
    expect(
      within(rounds).getByRole("button", {
        name: S.queue.decideAria(S.promotion.send(2), "R-301"),
      }),
    ).toBeVisible();
  });

  it("촉진 시작 creation path from the ledger row (§4-25-⑥) and round rows open the right pin", () => {
    renderConsole();
    // 박기사 is a 촉진 대상 with no open round → the ledger row offers 촉진 시작.
    fireEvent.click(screen.getByRole("button", { name: S.promotion.startAria("박기사") }));

    const promotion = screen.getByRole("region", { name: "사용촉진·사용계획서 알림" });
    const rounds = within(promotion).getByRole("list", { name: S.promotion.listAria });
    expect(within(rounds).getByText("박기사")).toBeVisible();
    expect(within(rounds).getByText(S.promotion.phase.send)).toBeVisible();
    // The creation path is single-shot: the row CTA disappears once a round is open.
    expect(screen.queryByRole("button", { name: S.promotion.startAria("박기사") })).toBeNull();

    const roundCode = within(rounds).getByRole("button", { name: S.openObject("R-301") });
    expect(roundCode).toHaveAttribute("draggable", "true");
    fireEvent.click(roundCode);
    const pin = screen.getByRole("region", { name: S.objects.roundTitle("박기사", 1) });
    expect(within(pin).getByText(S.promotion.deadline(30))).toBeVisible();
  });

  it("신청 row code opens the request ObjectCard as the right pin (§4.7-3)", () => {
    renderConsole();
    fireEvent.click(screen.getByRole("button", { name: S.openObject("AP-1201") }));
    const pin = screen.getByRole("region", { name: S.objects.requestTitle("이정비") });
    expect(within(pin).getByText(S.reasons.annual)).toBeVisible();
  });

  it("create-request is fail-closed on a missing enum 사유 (§4-19)", () => {
    renderConsole();
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    const queue = screen.getByRole("region", { name: S.queue.title });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.startLabel), {
      target: { value: "2026-07-20" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.endLabel), {
      target: { value: "2026-07-20" },
    });
    fireEvent.submit(within(selfRegion).getByRole("form", { name: S.self.formAria }));

    expect(within(selfRegion).getByRole("alert")).toHaveTextContent(S.self.required);
    expect(within(queue).queryByText("AP-1211")).toBeNull();
  });

  it("반차 is fail-closed to half a day and a submitted request can be 회수", () => {
    renderConsole();
    const selfRegion = screen.getByRole("region", { name: S.self.title });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.reasonLabel), {
      target: { value: "half_am" },
    });
    expect(within(selfRegion).getByLabelText(S.self.endLabel)).toBeDisabled();
    fireEvent.change(within(selfRegion).getByLabelText(S.self.startLabel), {
      target: { value: "2026-07-20" },
    });
    fireEvent.submit(within(selfRegion).getByRole("form", { name: S.self.formAria }));

    const myRequests = within(selfRegion).getByRole("list", { name: S.self.myRequests });
    expect(within(myRequests).getByText(dayText(0.5))).toBeVisible();

    fireEvent.click(
      within(myRequests).getByRole("button", { name: S.self.withdrawAria("AP-1211") }),
    );
    expect(within(selfRegion).queryByText("AP-1211")).toBeNull();
  });
});

function dayText(days: number): string {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(days)}일`;
}
