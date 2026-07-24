// Attendance is a bounded feature port. Shared integration owns the generated
// OpenAPI client and router adapter; this private leaf owns only the explicit
// production contract that its screen requires. There is deliberately no raw
// string-path client escape hatch or fallback transport here.
import type { components } from "@maintenance/api-client-ts";

export type EmployeeAttendanceRecord =
  components["schemas"]["EmployeeAttendanceRecord"];
export type AttendanceSummaryItem =
  components["schemas"]["AttendanceSummaryItem"];

export type ExceptionKind =
  "LATE" | "NO_SHOW" | "UNAPPROVED_OVERTIME" | "EARLY_LEAVE";
export type ExceptionStatus = "OPEN" | "RESOLVED";
export type ResolutionAction = "CONFIRM" | "APPROVE_OVERTIME";
export type SubstitutionReasonKind =
  "NO_SHOW" | "APPROVED_LEAVE" | "HALF_DAY" | "LONG_TERM" | "OTHER";
export type SubstitutionStatus = "ASSIGNED" | "CANCELLED";
export type Week52Tone = "OK" | "WARN" | "DANGER";

export interface AttendanceEvidence {
  name: string;
  size?: string | null;
}

export interface AttendanceObjectLink {
  kind: string;
  label: string;
  ref?: string | null;
}

export interface ExceptionResolution {
  action: ResolutionAction;
  reason: string;
  linked_work_ref?: string | null;
  ot_hours?: number | null;
  actor: string;
  resolved_at: string;
}

export interface AttendanceException {
  id: string;
  code: string;
  kind: ExceptionKind;
  status: ExceptionStatus;
  employee_id: string;
  employee_name: string;
  team?: string | null;
  branch_id?: string | null;
  work_date: string;
  occurred_at: string;
  detail: string;
  evidence: AttendanceEvidence[];
  links: AttendanceObjectLink[];
  resolution?: ExceptionResolution | null;
  created_at: string;
}

export interface Substitution {
  id: string;
  site: string;
  branch_id?: string | null;
  role: string;
  cover_date: string;
  from_minutes: number;
  to_minutes: number;
  covered_employee_id?: string | null;
  covered_name: string;
  reason_kind: SubstitutionReasonKind;
  reason_detail?: string | null;
  worker_employee_id?: string | null;
  worker_name: string;
  worker_type: string;
  worker_rate?: string | null;
  status: SubstitutionStatus;
  approval_ref?: string | null;
  contract_ref?: string | null;
  exception_id?: string | null;
  created_by: string;
  created_at: string;
}

export interface CreateSubstitution {
  site: string;
  branch_id?: string | null;
  role: string;
  cover_date: string;
  from_minutes: number;
  to_minutes: number;
  covered_employee_id?: string | null;
  covered_name: string;
  reason_kind: SubstitutionReasonKind;
  reason_detail?: string | null;
  worker_employee_id?: string | null;
  worker_name: string;
  worker_type: string;
  worker_rate?: string | null;
  exception_id?: string | null;
}

export interface CloseCheck {
  key: string;
  ok: boolean;
  warn?: boolean;
  note?: string | null;
}

export interface CloseAmendment {
  id: string;
  reason: string;
  actor: string;
  created_at: string;
}

export interface MonthClose {
  id: string;
  month: string;
  branch_scope: string;
  checks: CloseCheck[];
  attested_by: string;
  attested_at: string;
  period_lock_id?: string | null;
  closed_at: string;
  amendments: CloseAmendment[];
}

export interface MonthCloseItem {
  branch_scope: string;
  closed: boolean;
  close?: MonthClose | null;
  open_exceptions: number;
  pending_leave: number;
}

export interface MonthCloseBoard {
  month: string;
  items: MonthCloseItem[];
}

export interface ClosePreflight {
  month: string;
  branch_scope: string;
  checks: CloseCheck[];
  can_close: boolean;
}

export interface Week52Row {
  employee_id: string;
  name: string;
  team?: string | null;
  week_start: string;
  current_hours: number;
  projected_hours: number;
  tone: Week52Tone;
  acked: boolean;
  acked_at?: string | null;
}

export interface Week52Board {
  week_start: string;
  items: Week52Row[];
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** A typed failure surfaced by the production transport adapter. */
export class AttendanceTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "AttendanceTransportError";
  }
}

export interface ExceptionQuery {
  work_date?: string;
  month?: string;
  status?: ExceptionStatus;
  employee_id?: string;
  limit?: number;
  offset?: number;
}

/** Full selected month through seven days after its final operational day. */
export interface SubstitutionQuery {
  from_date: string;
  to_date: string;
  site?: string;
}

export interface ResolveException {
  reason: string;
  linked_work_ref?: string;
  ot_hours?: number;
}

/**
 * Required, authenticated Attendance production port.
 *
 * The shared generated-client/router owner must implement this port from the
 * authoritative `/api/v1/attendance` OpenAPI contract. The private screen
 * never fabricates a client when that contract is absent; it receives this
 * dependency explicitly and transport failures are rendered as failures.
 */
export interface AttendanceTransport {
  listExceptions(
    query: ExceptionQuery,
    signal?: AbortSignal,
  ): Promise<Page<AttendanceException>>;
  resolveException(
    id: string,
    input: ResolveException,
    signal?: AbortSignal,
  ): Promise<AttendanceException>;
  listSubstitutions(
    query: SubstitutionQuery,
    signal?: AbortSignal,
  ): Promise<Page<Substitution>>;
  createSubstitution(
    input: CreateSubstitution,
    signal?: AbortSignal,
  ): Promise<Substitution>;
  cancelSubstitution(
    id: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<Substitution>;
  listCloses(month: string, signal?: AbortSignal): Promise<MonthCloseBoard>;
  preflightClose(
    month: string,
    branchScope: string,
    signal?: AbortSignal,
  ): Promise<ClosePreflight>;
  confirmClose(
    month: string,
    branchScope: string,
    signal?: AbortSignal,
  ): Promise<MonthClose>;
  listWeek52(weekStart: string, signal?: AbortSignal): Promise<Week52Board>;
  ackWeek52(
    employeeId: string,
    weekStart: string,
    signal?: AbortSignal,
  ): Promise<Week52Row>;
  listAttendanceRecords(
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ items: EmployeeAttendanceRecord[] }>;
  listAttendanceSummary(
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ items: AttendanceSummaryItem[] }>;
}
