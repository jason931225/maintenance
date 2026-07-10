// 레인1 leave 카드 존 — 연차관리 deepened surface (design 다음 #1).
// Grammar: 1-row drillable stat bar (§4-11 no big-number cards), 내 연차
// self-service + 신청 생성 (§4-22 add-anything, §4-19 typed enum, fail-closed),
// 팀 결재함 (decide, SoD: no self-approval), 사용촉진 회차 (근로기준법 §61 FSM,
// single contextual CTA §4.7-6), 인원별 연차 원장. Every object row is an
// objDrag source and its code opens the ObjectCard as the right pin (§4.7-3).
// Personas (§4-25-⑦): 본인/팀장/HR 전담/관리자 — sections deny-by-omission via
// PolicyGated over LEAVE_ACTIONS.

import { useState, type CSSProperties, type ReactNode } from "react";

import { leaveManagementKo as legacy } from "../../i18n/hrWorkflows";
import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { objectCardWindowEntry, type ObjectCardDescriptor } from "../objectcard";
import { PolicyGated } from "../policy";
import "../tokens.css";
import { objDrag, useOptionalWindowManager } from "../window";
import {
  dayLabel,
  isHalfDay,
  isPromotionTarget,
  LEAVE_ACTIONS,
  LEAVE_REASONS,
  leaveStrings,
  ledgerDescriptor,
  ledgerStatus,
  nowStamp,
  requestDays,
  requestDescriptor,
  roundDescriptor,
  seedRequests,
  seedRounds,
  tenureStage,
  type LeaveLedgerRow,
  type LeaveReason,
  type LeaveRequest,
  type LedgerFilter,
  type PromotionRound,
} from "./model";

// ── Styles (tokens only, 8px grid via --sp-*, §4-25-⑧) ──────────────────────

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const sectionHeadStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

function statButtonStyle(pressed: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--sp-2)",
    minHeight: 44,
    padding: "0 var(--sp-4)",
    borderRadius: "var(--radius-pill)",
    border: `1px solid ${pressed ? "var(--signal)" : "var(--border)"}`,
    background: pressed ? "var(--accent-bg)" : "var(--surface)",
    color: "var(--ink)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--fw-strong)",
    cursor: "pointer",
  };
}

const statLabelStyle: CSSProperties = {
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
  background: "var(--surface)",
};

const codeButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  border: "0",
  background: "transparent",
  color: "var(--ink)",
  padding: "0 var(--sp-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: "1px solid var(--signal)",
  background: "var(--signal)",
};

const formStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  gap: "var(--sp-3)",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const inputStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
};

const linkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  textDecoration: "none",
};

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const thStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  textAlign: "left",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  verticalAlign: "middle",
};

const cellMetaStyle: CSSProperties = {
  margin: 0,
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
};

const cellNameStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

// ── Tones ────────────────────────────────────────────────────────────────────

const requestTone = {
  submitted: "warn",
  in_review: "info",
  approved: "ok",
  rejected: "danger",
} as const;

const phaseTone = { send: "warn", ack: "info", done: "ok" } as const;

// ── Surface ──────────────────────────────────────────────────────────────────

interface RequestForm {
  reason: LeaveReason | "";
  startDate: string;
  endDate: string;
}

const EMPTY_FORM: RequestForm = { reason: "", startDate: "", endDate: "" };

type SubmitEventLike = { preventDefault: () => void };

export function LeaveConsole({ ledger: ledgerSeed }: { ledger: LeaveLedgerRow[] }) {
  const S = leaveStrings();
  const windowManager = useOptionalWindowManager();
  const [ledger, setLedger] = useState(ledgerSeed);
  const [requests, setRequests] = useState<LeaveRequest[]>(() => seedRequests(ledgerSeed));
  const [rounds, setRounds] = useState<PromotionRound[]>(() => seedRounds(ledgerSeed));
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [seq, setSeq] = useState(1);
  const [form, setForm] = useState<RequestForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string>();

  // wire-pending: Phase C → 본인 식별은 세션 사용자↔직원 매핑으로 (지금은 첫 행)
  const self = ledger.at(0);

  function openCard(descriptor: ObjectCardDescriptor): void {
    // §4.7-3 default open gesture: detail opens as the right pin.
    windowManager?.open(objectCardWindowEntry(descriptor));
  }

  function ledgerOf(employeeId: string): LeaveLedgerRow | undefined {
    return ledger.find((row) => row.id === employeeId);
  }

  // ── Mutations (state-derived §4-25-⑥; wire-pending: Phase C → leave
  // mutation REST is MISSING — HANDOFF contract, see model.ts header) ────────

  function submitRequest(event: SubmitEventLike): void {
    event.preventDefault();
    if (!self) return;
    const { reason, startDate } = form;
    // §4-19 fail-closed: typed enum 사유 + 기간 are required.
    if (reason === "" || startDate === "" || (!isHalfDay(reason) && form.endDate === "")) {
      setFormError(S.self.required);
      return;
    }
    const endDate = isHalfDay(reason) ? startDate : form.endDate;
    if (endDate < startDate) {
      setFormError(S.self.invalidRange);
      return;
    }
    setRequests((prev) => [
      {
        id: `req-${String(1210 + seq)}`,
        code: `AP-${String(1210 + seq)}`,
        employeeId: self.id,
        employeeName: self.name,
        reason,
        startDate,
        endDate,
        days: requestDays(reason, startDate, endDate),
        state: "submitted",
        submittedAt: nowStamp(),
      },
      ...prev,
    ]);
    setSeq((n) => n + 1);
    setForm(EMPTY_FORM);
    setFormError(undefined);
  }

  function withdrawRequest(id: string): void {
    setRequests((prev) => prev.filter((request) => request.id !== id));
  }

  function decide(request: LeaveRequest, decision: "approved" | "rejected"): void {
    setRequests((prev) =>
      prev.map((item) =>
        item.id === request.id
          ? { ...item, state: decision, decidedBy: self?.name ?? "", decidedAt: nowStamp() }
          : item,
      ),
    );
    if (decision === "approved") {
      setLedger((prev) =>
        prev.map((row) =>
          row.id === request.employeeId
            ? {
                ...row,
                used: row.used + request.days,
                remaining: Math.max(0, row.remaining - request.days),
              }
            : row,
        ),
      );
    }
  }

  function startRound(employeeId: string, employeeName: string, roundNo: 1 | 2): void {
    setRounds((prev) => [
      ...prev,
      {
        id: `round-${String(300 + seq)}`,
        code: `R-${String(300 + seq)}`,
        employeeId,
        employeeName,
        round: roundNo,
        phase: "send",
        // ponytail: stub 법정기한 — §61 서면촉구 시한 산정은 Phase C 대상 산정 API에서.
        deadlineDays: roundNo === 1 ? 30 : 14,
        startedAt: nowStamp(),
      },
    ]);
    setSeq((n) => n + 1);
  }

  function advanceRound(id: string): void {
    setRounds((prev) =>
      prev.map((round) => {
        if (round.id !== id) return round;
        if (round.phase === "send") return { ...round, phase: "ack", sentAt: nowStamp() };
        return { ...round, phase: "done", ackedAt: nowStamp() };
      }),
    );
  }

  /** §4.7-6: exactly one contextual CTA per round state. */
  function roundCta(round: PromotionRound): { label: string; run: () => void } | undefined {
    if (round.phase === "send") {
      return { label: S.promotion.send(round.round), run: () => { advanceRound(round.id); } };
    }
    if (round.phase === "ack") {
      return { label: S.promotion.ack, run: () => { advanceRound(round.id); } };
    }
    if (
      round.round === 1 &&
      !rounds.some((item) => item.employeeId === round.employeeId && item.round === 2)
    ) {
      return {
        label: S.promotion.startSecond,
        run: () => { startRound(round.employeeId, round.employeeName, 2); },
      };
    }
    return undefined;
  }

  // ── Derived stats (drill = filter, §4-11) ──────────────────────────────────

  const activeRows = ledger.filter((row) => row.active);
  const accruedSum = activeRows.reduce((sum, row) => sum + row.accrued, 0);
  const usedSum = activeRows.reduce((sum, row) => sum + row.used, 0);
  const remainingSum = activeRows.reduce((sum, row) => sum + row.remaining, 0);
  const burnRate = accruedSum > 0 ? Math.round((usedSum / accruedSum) * 100) : 0;
  const promotionTargets = ledger.filter((row) => isPromotionTarget(row));

  const stats: { key: string; label: string; value: string; filter: LedgerFilter }[] = [
    { key: "headcount", label: S.stats.headcount, value: S.stats.people(activeRows.length), filter: "all" },
    { key: "remaining", label: S.stats.remaining, value: dayLabel(remainingSum), filter: "unspent" },
    { key: "burn", label: S.stats.burnRate, value: S.stats.percent(burnRate), filter: "unspent" },
    { key: "promotion", label: S.stats.promotionTargets, value: S.stats.people(promotionTargets.length), filter: "promotion" },
  ];

  const visibleLedger = ledger
    .filter((row) => {
      if (filter === "unspent") return row.active && row.remaining > 0;
      if (filter === "promotion") return isPromotionTarget(row);
      return true;
    })
    .slice(0, 80);

  const myRequests = self ? requests.filter((request) => request.employeeId === self.id) : [];
  const pendingRequests = requests.filter(
    (request) => request.state === "submitted" || request.state === "in_review",
  );

  function hasOpenRound(employeeId: string): boolean {
    return rounds.some((round) => round.employeeId === employeeId && round.phase !== "done");
  }

  // ── Row renderers ──────────────────────────────────────────────────────────

  function objectCodeButton(code: string, title: string, descriptor: () => ObjectCardDescriptor): ReactNode {
    return (
      <button
        type="button"
        {...objDrag(code, title)}
        aria-label={S.openObject(code)}
        title={ko.console.window.dragRefOf(title)}
        onClick={() => { openCard(descriptor()); }}
        style={codeButtonStyle}
      >
        {code}
      </button>
    );
  }

  function requestRow(request: LeaveRequest, cta: ReactNode): ReactNode {
    const title = S.objects.requestTitle(request.employeeName);
    const period =
      request.endDate === request.startDate
        ? request.startDate
        : `${request.startDate} ~ ${request.endDate}`;
    return (
      <li key={request.id} style={rowStyle}>
        {objectCodeButton(request.code, title, () =>
          requestDescriptor(request, ledgerOf(request.employeeId)),
        )}
        <span style={cellNameStyle}>{request.employeeName}</span>
        <span style={cellMetaStyle}>{period}</span>
        <StatusChip tone="neutral">{S.reasons[request.reason]}</StatusChip>
        <StatusChip tone="info">{dayLabel(request.days)}</StatusChip>
        <StatusChip tone={requestTone[request.state]}>{S.requestState[request.state]}</StatusChip>
        {cta}
      </li>
    );
  }

  return (
    <div className="console" data-console-module="leave" style={rootStyle}>
      {/* 연차 현황 — 1-row stat bar, every stat drills into the ledger filter */}
      <section aria-labelledby="leave-stats-title" style={cardStyle}>
        <h2 id="leave-stats-title" style={sectionTitleStyle}>{legacy.overview.title}</h2>
        <div role="group" aria-label={S.stats.aria} style={chipRowStyle}>
          {stats.map((stat) => (
            <button
              key={stat.key}
              type="button"
              aria-pressed={filter === stat.filter}
              aria-label={S.stats.drill(stat.label)}
              onClick={() => { setFilter(filter === stat.filter ? "all" : stat.filter); }}
              style={statButtonStyle(filter === stat.filter && stat.filter !== "all")}
            >
              <span style={statLabelStyle}>{stat.label}</span>
              <span>{stat.value}</span>
            </button>
          ))}
        </div>
      </section>

      {/* 본인 persona — own balance, own requests, 신청 생성 (§4-22) */}
      {self ? (
        <PolicyGated action={LEAVE_ACTIONS.selfView} resource={{ kind: "leave_self", id: self.id }}>
          <section aria-labelledby="leave-self-title" style={cardStyle}>
            <div style={sectionHeadStyle}>
              <h2 id="leave-self-title" style={sectionTitleStyle}>{S.self.title}</h2>
              <StatusChip tone="neutral">{self.name}</StatusChip>
              <StatusChip tone="info">{`${legacy.roster.columns.accrued} ${dayLabel(self.accrued)}`}</StatusChip>
              <StatusChip tone="neutral">{`${legacy.roster.columns.used} ${dayLabel(self.used)}`}</StatusChip>
              <StatusChip tone="ok">{`${legacy.roster.columns.remaining} ${dayLabel(self.remaining)}`}</StatusChip>
            </div>
            <PolicyGated action={LEAVE_ACTIONS.requestCreate} resource={{ kind: "leave_request" }}>
              <form aria-label={S.self.formAria} onSubmit={submitRequest} style={formStyle}>
                <label style={labelStyle}>
                  {S.self.reasonLabel}
                  <select
                    required
                    value={form.reason}
                    onChange={(event) => {
                      const reason = event.currentTarget.value as LeaveReason | "";
                      setForm((prev) => ({ ...prev, reason }));
                    }}
                    style={inputStyle}
                  >
                    <option value="" disabled>{S.self.reasonPlaceholder}</option>
                    {LEAVE_REASONS.map((reason) => (
                      <option key={reason} value={reason}>{S.reasons[reason]}</option>
                    ))}
                  </select>
                </label>
                <label style={labelStyle}>
                  {S.self.startLabel}
                  <input
                    type="date"
                    required
                    value={form.startDate}
                    onChange={(event) => {
                      const startDate = event.currentTarget.value;
                      setForm((prev) => ({ ...prev, startDate }));
                    }}
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  {S.self.endLabel}
                  <input
                    type="date"
                    required={!isHalfDay(form.reason)}
                    disabled={isHalfDay(form.reason)}
                    value={isHalfDay(form.reason) ? form.startDate : form.endDate}
                    onChange={(event) => {
                      const endDate = event.currentTarget.value;
                      setForm((prev) => ({ ...prev, endDate }));
                    }}
                    style={inputStyle}
                  />
                </label>
                <button type="submit" style={primaryButtonStyle}>{S.self.submit}</button>
                <a href="/approvals?template=annual-leave" style={linkStyle}>{S.self.formLink}</a>
                {formError !== undefined ? (
                  <StatusChip role="alert" tone="danger">{formError}</StatusChip>
                ) : null}
              </form>
            </PolicyGated>
            {myRequests.length === 0 ? (
              <StatusChip tone="neutral">{S.self.empty}</StatusChip>
            ) : (
              <ul aria-label={S.self.myRequests} style={listStyle}>
                {myRequests.map((request) =>
                  requestRow(
                    request,
                    request.state === "submitted" ? (
                      <PolicyGated
                        action={LEAVE_ACTIONS.requestWithdraw}
                        resource={{ kind: "leave_request", id: request.id }}
                      >
                        <button
                          type="button"
                          aria-label={S.self.withdrawAria(request.code)}
                          onClick={() => { withdrawRequest(request.id); }}
                          style={buttonStyle}
                        >
                          {S.self.withdraw}
                        </button>
                      </PolicyGated>
                    ) : null,
                  ),
                )}
              </ul>
            )}
          </section>
        </PolicyGated>
      ) : null}

      {/* 팀장 persona — pending queue + decide (SoD: 본인 신청은 결재 불가) */}
      <PolicyGated action={LEAVE_ACTIONS.queueView} resource={{ kind: "leave_queue" }}>
        <section aria-labelledby="leave-queue-title" style={cardStyle}>
          <div style={sectionHeadStyle}>
            <h2 id="leave-queue-title" style={sectionTitleStyle}>{S.queue.title}</h2>
            <StatusChip tone="warn">{S.count(pendingRequests.length)}</StatusChip>
          </div>
          {pendingRequests.length === 0 ? (
            <StatusChip tone="neutral">{S.queue.empty}</StatusChip>
          ) : (
            <ul aria-label={S.queue.aria} style={listStyle}>
              {pendingRequests.map((request) =>
                requestRow(
                  request,
                  // ponytail: SoD by omission — the decider's own request shows no
                  // decide buttons (approver ≠ requester, gov_approvals four-eyes).
                  request.employeeId === self?.id ? null : (
                    <PolicyGated
                      action={LEAVE_ACTIONS.requestDecide}
                      resource={{ kind: "leave_request", id: request.id }}
                    >
                      <span style={chipRowStyle}>
                        <button
                          type="button"
                          aria-label={S.queue.decideAria(S.queue.approve, request.code)}
                          onClick={() => { decide(request, "approved"); }}
                          style={primaryButtonStyle}
                        >
                          {S.queue.approve}
                        </button>
                        <button
                          type="button"
                          aria-label={S.queue.decideAria(S.queue.reject, request.code)}
                          onClick={() => { decide(request, "rejected"); }}
                          style={buttonStyle}
                        >
                          {S.queue.reject}
                        </button>
                      </span>
                    </PolicyGated>
                  ),
                ),
              )}
            </ul>
          )}
        </section>
      </PolicyGated>

      {/* HR 전담 persona — 사용촉진 회차 (근로기준법 §61) */}
      <PolicyGated action={LEAVE_ACTIONS.promotionView} resource={{ kind: "leave_promotion" }}>
        <section aria-labelledby="leave-promotion-title" style={cardStyle}>
          <div style={sectionHeadStyle}>
            <h2 id="leave-promotion-title" style={sectionTitleStyle}>{legacy.notice.title}</h2>
            <StatusChip tone="purple">{S.promotion.legalBasis}</StatusChip>
            <StatusChip tone="neutral">{S.count(rounds.length)}</StatusChip>
          </div>
          {rounds.length === 0 ? (
            <StatusChip tone="neutral">{S.promotion.empty}</StatusChip>
          ) : (
            <ul aria-label={S.promotion.listAria} style={listStyle}>
              {rounds.map((round) => {
                const cta = roundCta(round);
                return (
                  <li key={round.id} style={rowStyle}>
                    {objectCodeButton(
                      round.code,
                      S.objects.roundTitle(round.employeeName, round.round),
                      () => roundDescriptor(round, ledgerOf(round.employeeId)),
                    )}
                    <span style={cellNameStyle}>{round.employeeName}</span>
                    <StatusChip tone="info">{S.promotion.roundChip(round.round)}</StatusChip>
                    <StatusChip tone={phaseTone[round.phase]}>
                      {S.promotion.phase[round.phase]}
                    </StatusChip>
                    {round.phase !== "done" ? (
                      <StatusChip tone={round.deadlineDays <= 7 ? "danger" : "neutral"}>
                        {S.promotion.deadline(round.deadlineDays)}
                      </StatusChip>
                    ) : null}
                    {cta ? (
                      <PolicyGated
                        action={LEAVE_ACTIONS.promotionManage}
                        resource={{ kind: "leave_promotion_round", id: round.id }}
                      >
                        <button
                          type="button"
                          aria-label={S.queue.decideAria(cta.label, round.code)}
                          onClick={cta.run}
                          style={buttonStyle}
                        >
                          {cta.label}
                        </button>
                      </PolicyGated>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </PolicyGated>

      {/* 관리자/HR persona — 인원별 연차 원장 */}
      <PolicyGated action={LEAVE_ACTIONS.ledgerView} resource={{ kind: "leave_ledger" }}>
        <section aria-labelledby="leave-ledger-title" style={cardStyle}>
          <div style={sectionHeadStyle}>
            <h2 id="leave-ledger-title" style={sectionTitleStyle}>{legacy.roster.title}</h2>
            <StatusChip tone="neutral">{S.count(visibleLedger.length)}</StatusChip>
          </div>
          <div style={tableWrapStyle}>
            <table aria-label={S.ledger.listAria} style={tableStyle}>
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>{legacy.roster.columns.employee}</th>
                  <th scope="col" style={thStyle}>{legacy.roster.columns.department}</th>
                  <th scope="col" style={thStyle}>{legacy.roster.columns.tenure}</th>
                  <th scope="col" style={thStyle}>{legacy.roster.columns.accrued}</th>
                  <th scope="col" style={thStyle}>{legacy.roster.columns.used}</th>
                  <th scope="col" style={thStyle}>{legacy.roster.columns.remaining}</th>
                  <th scope="col" style={thStyle}>{legacy.roster.columns.status}</th>
                </tr>
              </thead>
              <tbody>
                {visibleLedger.map((row) => {
                  const status = ledgerStatus(row);
                  return (
                    <tr key={row.id}>
                      <td style={tdStyle}>
                        {objectCodeButton(row.code, S.objects.ledgerTitle(row.name), () =>
                          ledgerDescriptor(row, requests),
                        )}
                        <p style={cellNameStyle}>{row.name}</p>
                        <p style={cellMetaStyle}>{`${row.company} · ${row.employeeNumber}`}</p>
                      </td>
                      <td style={tdStyle}>{`${row.orgUnit} / ${row.position}`}</td>
                      <td style={tdStyle}>
                        <p style={cellNameStyle}>{tenureStage(row.hireDate)}</p>
                        <p style={cellMetaStyle}>{row.hireDate ?? "—"}</p>
                      </td>
                      <td style={tdStyle}>{dayLabel(row.accrued)}</td>
                      <td style={tdStyle}>{dayLabel(row.used)}</td>
                      <td style={tdStyle}>{dayLabel(row.remaining)}</td>
                      <td style={tdStyle}>
                        <span style={chipRowStyle}>
                          <StatusChip tone={status.tone}>{status.label}</StatusChip>
                          {isPromotionTarget(row) && !hasOpenRound(row.id) ? (
                            <PolicyGated
                              action={LEAVE_ACTIONS.promotionManage}
                              resource={{ kind: "leave_ledger", id: row.id }}
                            >
                              <button
                                type="button"
                                aria-label={S.promotion.startAria(row.name)}
                                onClick={() => { startRound(row.id, row.name, 1); }}
                                style={buttonStyle}
                              >
                                {S.promotion.start}
                              </button>
                            </PolicyGated>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </PolicyGated>
    </div>
  );
}
