/** Narrow, selector-free employee attendance port. Auth comes from the caller. */
export type OwnExceptionKind = "LATE" | "NO_SHOW" | "UNAPPROVED_OVERTIME" | "EARLY_LEAVE";
export type OwnExceptionStatus = "OPEN" | "RESOLVED";
export interface OwnAttendanceException { id: string; code: string; kind: OwnExceptionKind; status: OwnExceptionStatus; work_date: string; occurred_at: string; detail: string; resolved_at?: string | null; }
export interface OwnAttendanceExceptionPage { items: OwnAttendanceException[]; total: number; limit: number; offset: number; }
/** No branch, employee, actor, or manager selector is legal on this endpoint. */
export interface OwnAttendanceExceptionQuery { month: string; status?: OwnExceptionStatus; limit: number; offset: number; }
export interface OwnAttendanceWeek52Projection { week_start: string; current_hours: number; projected_hours: number; limit_hours: number; tone: "OK" | "WARN" | "DANGER"; }
/** The status envelope prevents absent linkage from masquerading as zero hours. */
export type OwnAttendanceWeek52 =
  | { status: "available"; projection: OwnAttendanceWeek52Projection }
  | { status: "not_available"; projection?: never };
export interface SelfServiceAttendanceApi {
  listOwnExceptions(query: OwnAttendanceExceptionQuery, signal?: AbortSignal): Promise<OwnAttendanceExceptionPage>;
  getOwnWeek52(signal?: AbortSignal): Promise<OwnAttendanceWeek52>;
}
/** Reject malformed envelopes rather than invent a projection. */
export function isValidOwnWeek52(value: unknown): value is OwnAttendanceWeek52 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "not_available") return candidate.projection === undefined;
  if (candidate.status !== "available" || !candidate.projection || typeof candidate.projection !== "object") return false;
  const p = candidate.projection as Record<string, unknown>;
  return typeof p.week_start === "string" && typeof p.current_hours === "number" && typeof p.projected_hours === "number" && typeof p.limit_hours === "number" && (p.tone === "OK" || p.tone === "WARN" || p.tone === "DANGER");
}
