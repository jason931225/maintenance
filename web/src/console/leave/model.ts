// 레인1 leave 카드 존 — 연차관리 ontology model (design §4 grammar).
// Objects: 연차 신청(AP-), 연차 원장(JL-), 사용촉진 회차(R-, 근로기준법 §61).
// wire-pending: Phase C — reads come from GET /api/v1/hr/leave-balances (exists,
// read-only today); every mutation below (신청 생성/회수, 결재, 촉진 발송/수령확인)
// has NO backend endpoint yet → HANDOFF contract: leave mutations per
// be-ontology-engine-arch.md §5 action execution (POST /ontology/actions/*).

import { leaveManagementKo as legacy } from "../../i18n/hrWorkflows";
import { ko } from "../../i18n/ko";
import type {
  ObjectCardDescriptor,
  ObjectCardLifecycleStep,
  ObjectCardRelation,
  ObjectCardRevision,
  ObjectLifecycleState,
} from "../objectcard";
import type { PolicyGate } from "../policy";

// ── i18n (namespace: ko.console.leave) ───────────────────────────────────────

/**
 * ko.console.leave — wired by the serial i18n wire-up; ko.ts is the single
 * source. The alias keeps the lane's test imports (KO_CONSOLE_LEAVE) intact.
 */
export const KO_CONSOLE_LEAVE = ko.console.leave;

export type LeaveStrings = typeof KO_CONSOLE_LEAVE;

export function leaveStrings(): LeaveStrings {
  return KO_CONSOLE_LEAVE;
}

// ── PBAC actions (deny-by-omission via PolicyGated, §4-25-⑦ persona lens) ────

export const LEAVE_ACTIONS = {
  /** 본인: own balance + requests + 신청 생성. */
  selfView: "console.leave.self.view",
  requestCreate: "console.leave.request.create",
  requestWithdraw: "console.leave.request.withdraw",
  /** 팀장: pending queue + decide. */
  queueView: "console.leave.queue.view",
  requestDecide: "console.leave.request.decide",
  /** HR 전담: 촉진 회차 관리 (근로기준법 §61). */
  promotionView: "console.leave.promotion.view",
  promotionManage: "console.leave.promotion.manage",
  /** 관리자/HR: 인원별 원장. */
  ledgerView: "console.leave.ledger.view",
  objectRead: "console.leave.object.read",
} as const;

const ALLOWED_ACTIONS = new Set<string>(Object.values(LEAVE_ACTIONS));

// wire-pending: Phase C — Cedar authorize() decisions replace this allow-list
// stub (same pattern as AutomatePage's AUTOMATE_RUNTIME_GATE).
export const LEAVE_RUNTIME_GATE: PolicyGate = {
  can: (action) => ALLOWED_ACTIONS.has(action),
};

// ── Model ────────────────────────────────────────────────────────────────────

export type LeaveReason = keyof LeaveStrings["reasons"];
export type LeaveRequestState = keyof LeaveStrings["requestState"];
export type PromotionPhase = keyof LeaveStrings["promotion"]["phase"];
export type LedgerFilter = "all" | "unspent" | "promotion";

export const LEAVE_REASONS: readonly LeaveReason[] = [
  "annual",
  "half_am",
  "half_pm",
  "family_event",
  "sick",
];

/** One 연차 원장 row — seeded from GET /api/v1/hr/leave-balances (+ directory). */
export interface LeaveLedgerRow {
  id: string;
  /** Object code (JL-) carried in drag payloads / ObjectCard. */
  code: string;
  name: string;
  company: string;
  employeeNumber: string;
  orgUnit: string;
  position: string;
  hireDate?: string;
  accrued: number;
  used: number;
  remaining: number;
  active: boolean;
}

/** 연차 신청 object (AP-) — lifecycle 신청→결재→승인/반려. */
export interface LeaveRequest {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  reason: LeaveReason;
  startDate: string;
  endDate: string;
  days: number;
  state: LeaveRequestState;
  submittedAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

/** 사용촉진 회차 object (R-) — 1차/2차 발송 → 수령확인 대기 → 완료. */
export interface PromotionRound {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  round: 1 | 2;
  phase: PromotionPhase;
  deadlineDays: number;
  startedAt: string;
  sentAt?: string;
  ackedAt?: string;
}

export function isHalfDay(reason: LeaveReason | ""): boolean {
  return reason === "half_am" || reason === "half_pm";
}

export function isPromotionTarget(row: LeaveLedgerRow): boolean {
  // ponytail: stub predicate (활성 + 잔여가 발생의 절반 이상) — 실제 대상 산정은
  // 근로기준법 §61 촉진 기간(회계연도 종료 6개월/2개월 전) 기준. Phase C 산정 API로 교체.
  return row.active && row.remaining > 0 && row.remaining >= row.accrued / 2;
}

export function formatDays(value: number): string {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
}

export function dayLabel(value: number): string {
  return legacy.units.days(formatDays(value));
}

export function requestDays(reason: LeaveReason, startDate: string, endDate: string): number {
  if (isHalfDay(reason)) return 0.5;
  // ponytail: calendar-day count — 근무일 캘린더(휴일 제외)는 Phase C 근무표 연동에서.
  const span = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
  return Math.floor(span) + 1;
}

export function tenureStage(hireDate: string | undefined): string {
  if (hireDate === undefined) return legacy.tenure.missing;
  const start = Date.parse(hireDate);
  if (!Number.isFinite(start)) return legacy.tenure.missing;
  const years = Math.max(0, Date.now() - start) / (365.2425 * 24 * 60 * 60 * 1000);
  if (years < 1) return legacy.tenure.underOneYear;
  const yearLabel = String(Math.floor(years) + 1);
  if (years < 3) return legacy.tenure.baseYear(yearLabel);
  return legacy.tenure.additionalYear(yearLabel);
}

export function ledgerStatus(row: LeaveLedgerRow): {
  label: string;
  tone: "neutral" | "ok" | "warn";
} {
  if (row.hireDate === undefined) return { label: legacy.status.hireDateMissing, tone: "warn" };
  if (!row.active) return { label: legacy.status.exited, tone: "neutral" };
  if (row.remaining <= 0) return { label: legacy.status.exhausted, tone: "ok" };
  // Single predicate per concept: the promotion chip mirrors the 촉진 대상
  // stat/filter (isPromotionTarget), never a bare remaining > 0.
  if (isPromotionTarget(row)) return { label: legacy.status.promotion, tone: "warn" };
  return { label: KO_CONSOLE_LEAVE.stats.headcount, tone: "ok" };
}

// ── Seeds (§4-25-⑥: state-derived from the server-backed ledger, and every ──
// collection is mutable through a UI path — create/withdraw/decide/발송/수령확인)

function isoDatePlus(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function nowStamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

// wire-pending: Phase C → GET 연차 신청 목록 (leave-request REST MISSING — HANDOFF)
export function seedRequests(ledger: readonly LeaveLedgerRow[]): LeaveRequest[] {
  return ledger
    .slice(1, 3)
    .filter((row) => row.active)
    .map((row, index) => ({
      id: `req-seed-${row.id}`,
      code: `AP-${String(1201 + index)}`,
      employeeId: row.id,
      employeeName: row.name,
      reason: "annual" as const,
      startDate: isoDatePlus(7 + index),
      endDate: isoDatePlus(7 + index),
      days: 1,
      state: index === 0 ? ("in_review" as const) : ("submitted" as const),
      submittedAt: nowStamp(),
    }));
}

// wire-pending: Phase C → GET 촉진 회차 목록 (promotion REST MISSING — HANDOFF)
export function seedRounds(ledger: readonly LeaveLedgerRow[]): PromotionRound[] {
  return ledger
    .filter((row) => isPromotionTarget(row))
    .slice(0, 1)
    .map((row) => ({
      id: `round-seed-${row.id}`,
      code: "R-290",
      employeeId: row.id,
      employeeName: row.name,
      round: 1 as const,
      phase: "ack" as const,
      deadlineDays: 14,
      startedAt: nowStamp(),
    }));
}

// ── ObjectCard descriptors (§4.7-3 right pin; shapes per be-ontology-engine) ─

const REQUEST_LIFECYCLE: Record<LeaveRequestState, ObjectLifecycleState> = {
  submitted: "draft",
  in_review: "draft",
  approved: "active",
  rejected: "archived",
};

function lifecycleSteps(state: ObjectLifecycleState): ObjectCardLifecycleStep[] {
  return [
    { state: "draft", reached: true, current: state === "draft" },
    { state: "active", reached: state === "active", current: state === "active" },
    ...(state === "archived"
      ? [{ state: "archived" as const, reached: true, current: true }]
      : []),
  ];
}

export function requestDescriptor(
  request: LeaveRequest,
  ledgerRow: LeaveLedgerRow | undefined,
): ObjectCardDescriptor {
  const S = leaveStrings();
  const state = REQUEST_LIFECYCLE[request.state];
  const period =
    request.endDate === request.startDate
      ? request.startDate
      : `${request.startDate} ~ ${request.endDate}`;
  // hashVerified: false — client-local revisions; the verified badge only comes
  // from the L20 chain via GET /api/v1/ontology/instances/{id}/history (Phase C).
  const history: ObjectCardRevision[] = [
    {
      version: 1,
      at: request.submittedAt,
      actor: request.employeeName,
      hashVerified: false,
      action: "leave_request.submit",
    },
  ];
  if (request.decidedAt !== undefined && request.decidedBy !== undefined) {
    history.push({
      version: 2,
      at: request.decidedAt,
      actor: request.decidedBy,
      hashVerified: false,
      action: "leave_request.decide",
    });
  }
  // wire-pending: Phase C → GET /api/v1/ontology/instances/{id}/traverse
  // (be-ontology-engine-arch.md §API surface) supplies the 근무표 link; only the
  // state-derived ledger relation renders until then — no fabricated codes.
  const relations: ObjectCardRelation[] = [];
  if (ledgerRow) {
    relations.push({
      linkId: `${request.id}-ledger`,
      linkType: S.objects.linkLedger,
      direction: "to",
      cardinality: "one_one",
      code: ledgerRow.code,
      title: S.objects.ledgerTitle(ledgerRow.name),
    });
  }
  return {
    id: request.id,
    code: request.code,
    title: S.objects.requestTitle(request.employeeName),
    objectType: { key: "leave_request", title: S.objects.requestType },
    lifecycleState: state,
    properties: [
      { key: "period", title: S.objects.props.period, type: "date_range", value: period },
      { key: "days", title: S.objects.props.days, type: "number", value: dayLabel(request.days) },
      { key: "reason", title: S.objects.props.reason, type: "choice", value: S.reasons[request.reason] },
      { key: "requester", title: S.objects.props.requester, type: "user", value: request.employeeName },
    ],
    relations,
    lifecycle: lifecycleSteps(state),
    history,
    approvals: [
      {
        id: `${request.id}-approval`,
        kind: S.objects.approvalKind,
        requestedBy: request.employeeName,
        approver: request.decidedBy,
        decision:
          request.state === "approved"
            ? "approved"
            : request.state === "rejected"
              ? "rejected"
              : "pending",
        at: request.decidedAt,
      },
    ],
    actions: [],
  };
}

export function ledgerDescriptor(
  row: LeaveLedgerRow,
  requests: readonly LeaveRequest[],
): ObjectCardDescriptor {
  const S = leaveStrings();
  const state: ObjectLifecycleState = row.active ? "active" : "archived";
  return {
    id: row.id,
    code: row.code,
    title: S.objects.ledgerTitle(row.name),
    objectType: { key: "leave_ledger", title: S.objects.ledgerType },
    lifecycleState: state,
    properties: [
      { key: "accrued", title: S.objects.props.accrued, type: "number", value: dayLabel(row.accrued) },
      { key: "used", title: S.objects.props.used, type: "number", value: dayLabel(row.used) },
      { key: "remaining", title: S.objects.props.remaining, type: "number", value: dayLabel(row.remaining) },
      { key: "hire_date", title: S.objects.props.hireDate, type: "date", value: row.hireDate ?? "—" },
    ],
    relations: requests
      .filter((request) => request.employeeId === row.id)
      .map((request) => ({
        linkId: `${row.id}-${request.id}`,
        linkType: S.objects.linkRequest,
        direction: "from" as const,
        cardinality: "one_many" as const,
        code: request.code,
        title: S.objects.requestTitle(request.employeeName),
      })),
    lifecycle: lifecycleSteps(state),
    // wire-pending: Phase C → hash-verified import-run revisions from
    // GET /api/v1/ontology/instances/{id}/history; no client-fabricated entries.
    history: [],
    actions: [],
  };
}

const ROUND_LIFECYCLE: Record<PromotionPhase, ObjectLifecycleState> = {
  send: "draft",
  ack: "active",
  done: "archived",
};

export function roundDescriptor(
  round: PromotionRound,
  ledgerRow: LeaveLedgerRow | undefined,
): ObjectCardDescriptor {
  const S = leaveStrings();
  const state = ROUND_LIFECYCLE[round.phase];
  return {
    id: round.id,
    code: round.code,
    title: S.objects.roundTitle(round.employeeName, round.round),
    objectType: { key: "leave_promotion_round", title: S.objects.roundType },
    lifecycleState: state,
    properties: [
      { key: "employee", title: S.objects.props.employee, type: "user", value: round.employeeName },
      { key: "round", title: S.objects.props.round, type: "choice", value: S.promotion.roundChip(round.round) },
      { key: "phase", title: S.objects.props.phase, type: "choice", value: S.promotion.phase[round.phase] },
      { key: "deadline", title: S.objects.props.deadline, type: "text", value: S.promotion.deadline(round.deadlineDays) },
    ],
    relations: ledgerRow
      ? [
          {
            linkId: `${round.id}-ledger`,
            linkType: S.objects.linkLedger,
            direction: "to",
            cardinality: "one_one",
            code: ledgerRow.code,
            title: S.objects.ledgerTitle(ledgerRow.name),
          },
        ]
      : [],
    lifecycle: lifecycleSteps(state),
    history: [
      {
        version: 1,
        at: round.startedAt,
        actor: S.objects.hrActor,
        // Client-local revision — only Phase C history wiring may claim L20 verification.
        hashVerified: false,
        action: "leave_promotion.start",
      },
    ],
    actions: [],
  };
}
