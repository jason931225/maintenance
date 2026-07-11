// 레인1 leave 카드 존 — 연차관리 ontology model (design §4 grammar).
// Objects: 연차 원장(JL-, projected from the employee leave columns). The team
// decision queue and §61 촉진 push are REAL-wired to the leave engine
// (backend/crates/leave — GET/POST /api/v1/leave/*); see LeaveConsole.tsx.
//
// BE contract (verified against backend/crates/leave/rest/src/lib.rs +
// openapi.yaml, both read directly — no REST is speculated):
//   • POST /api/v1/leave/requests (operationId createLeaveRequest) now exists —
//     built + mnt_rt-tested in this lane (see rest::create_request +
//     resolve_self_filing_context; fragment wave-mc-fragments/people.yaml). The
//     본인 신청 form is REAL-submitting and fail-closed (§4-19): subject_employee_id
//     + branch_id are resolved server-side from the caller, `days` derived
//     server-side, never trusted from the client (leave/api.ts). Until
//     consolidation regenerates @maintenance/api-client-ts from the fragment,
//     leave/api.ts is the one localized boundary that types `api.POST`.
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

/**
 * One 연차 원장 row — GET /api/v1/leave/balances (`LeaveRosterEntry`: id, name,
 * team, grant/used/left, tone — no company/employee-number/position/hire-date
 * join). Those richer HR-directory fields aren't in this endpoint's response,
 * so they're optional here rather than fabricated; the table renders "—" when
 * absent (§4-25-⑥).
 */
export interface LeaveLedgerRow {
  id: string;
  /** Client-derived drag/object-card code — see `rosterToLedgerRow` header. */
  code: string;
  name: string;
  company?: string;
  employeeNumber?: string;
  orgUnit?: string;
  position?: string;
  hireDate?: string;
  accrued: number;
  used: number;
  remaining: number;
  /** Backend-computed §61 bucket — never re-derived client-side. */
  tone: LeaveRosterTone;
  active: boolean;
}

/**
 * `LeaveRosterEntry` (GET /api/v1/leave/balances) → `LeaveLedgerRow`. The
 * roster is a projected type with no backend-issued object code yet (no
 * `leaveLedger` kind registered in composer/objectKinds.ts — that shared
 * registry + its ko.ts label are wire-pending, since this lane cannot edit
 * ko.ts). `LV-` is a stable client-derived short id (same pattern as
 * console/forecast/series.ts's `FC-` codes for another projected type) —
 * real data, not a fabricated business fact; it just won't resolve via
 * `kindFromCode` until the registration lands (deny-by-omission, not broken).
 * `active` defaults true: the endpoint only returns the current employee
 * ledger and carries no separate exit flag.
 */
// Short reference token from an employee UUID. Native ids share a long all-zero
// prefix (00000000-0000-0000-0000-000000ee0001), so a plain leading slice
// collapsed EVERY roster row's code to "LV-000000" (verdict R10: identical codes
// down the roster). Drop dashes + leading-zero padding first, then take the
// distinguishing head — same idiom as explore/ObjectExplorerModel.ts `shortId`.
function shortEmployeeRef(id: string): string {
  const hex = id.replace(/-/g, "");
  return (hex.replace(/^0+/, "") || hex).slice(0, 6).toUpperCase();
}

export function rosterToLedgerRow(entry: LeaveRosterEntry): LeaveLedgerRow {
  return {
    id: entry.employee_id,
    code: `LV-${shortEmployeeRef(entry.employee_id)}`,
    name: entry.name,
    orgUnit: entry.team ?? undefined,
    accrued: entry.grant,
    used: entry.used,
    remaining: entry.left,
    tone: entry.tone,
    active: true,
  };
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

/** used/accrued as a rounded percent — same arithmetic as the header's burnRate stat, per-row (§4-11 density). */
export function rowBurnRate(row: LeaveLedgerRow): number {
  return row.accrued > 0 ? Math.round((row.used / row.accrued) * 100) : 0;
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
