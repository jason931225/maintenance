// 레인1 leave 카드 존 — 연차관리 ontology model (design §4 grammar).
// Objects: 연차 원장(JL-, projected from the employee leave columns). The team
// decision queue and §61 촉진 push are REAL-wired to the leave engine
// (backend/crates/leave — GET/POST /api/v1/leave/*); see LeaveConsole.tsx.
//
// BE gap (verified against backend/crates/leave/rest/src/lib.rs +
// openapi.yaml, both read directly — no REST is speculated):
//   • No POST create-request endpoint exists anywhere (fragment or client).
//     `CreateLeaveRequestCommand` is a crate-internal write port only, fed by
//     the 기안/engine compose flow (not yet public). 신청 생성 stays a
//     validated, fail-closed, NON-submitting form (§4-19) until that lands.
//   • No employee→account(user_id) lookup REST exists, so a §61 push target
//     can only be resolved from a REAL LeaveRequestView the employee is
//     already attached to (requester_user_id + subject_employee_id together,
//     as filed) — never guessed. The backend's own
//     `verify_statutory_push_target` re-validates that pairing before any
//     notice is delivered, so a stale/wrong pairing 404s instead of
//     misdelivering a statutory notice.

import { leaveManagementKo as legacy } from "../../i18n/hrWorkflows";
import { ko } from "../../i18n/ko";
import type { LeaveRosterEntry } from "../../api/types";
import type { ObjectCardDescriptor } from "../objectcard";
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
  /** 본인: own request history (server-filtered by requester_user_id). */
  selfView: "console.leave.self.view",
  requestCreate: "console.leave.request.create",
  /** 팀장: pending queue + decide. */
  queueView: "console.leave.queue.view",
  requestDecide: "console.leave.request.decide",
  /** HR 전담: 촉진 발송 (근로기준법 §61). */
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
export type LedgerFilter = "all" | "unspent" | "promotion";
export type LeaveRosterTone = LeaveRosterEntry["tone"];

export const LEAVE_REASONS: readonly LeaveReason[] = [
  "annual",
  "half_am",
  "half_pm",
  "family_event",
  "sick",
];

/** One 연차 원장 row — GET /api/v1/leave/balances, merged with the employee directory. */
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
  /** Backend-computed §61 bucket — never re-derived client-side. */
  tone: LeaveRosterTone;
  active: boolean;
}

export function isHalfDay(reason: LeaveReason | ""): boolean {
  return reason === "half_am" || reason === "half_pm";
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
  const S = leaveStrings();
  if (row.hireDate === undefined) return { label: S.status.hireDateMissing, tone: "warn" };
  if (!row.active) return { label: S.status.exited, tone: "neutral" };
  if (row.tone === "promote") return { label: S.status.promote, tone: "warn" };
  if (row.tone === "low") return { label: S.status.low, tone: "warn" };
  return { label: S.status.ok, tone: "ok" };
}

// ── ObjectCard descriptor (§4.7-3 right pin) — projected type, real fields ──

export function ledgerDescriptor(row: LeaveLedgerRow): ObjectCardDescriptor {
  const S = leaveStrings();
  const state = row.active ? "active" : "archived";
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
    // wire-pending: Phase C → GET /api/v1/ontology/instances/{id}/traverse
    // supplies the 연차 신청 link once requests carry a registered object
    // prefix (today's LeaveRequestView has no code/type binding — no
    // fabricated relation is rendered in the meantime).
    relations: [],
    lifecycle: [
      { state: "draft", reached: true, current: false },
      { state: "active", reached: state === "active", current: state === "active" },
      ...(state === "archived"
        ? [{ state: "archived" as const, reached: true, current: true }]
        : []),
    ],
    // wire-pending: Phase C → hash-verified import-run revisions from
    // GET /api/v1/ontology/instances/{id}/history; no client-fabricated entries.
    history: [],
    actions: [],
  };
}
