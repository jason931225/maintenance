export type OwnExceptionKind = "LATE" | "NO_SHOW" | "UNAPPROVED_OVERTIME" | "EARLY_LEAVE";
export type OwnExceptionStatus = "OPEN" | "RESOLVED";

export interface OwnAttendanceEvidence { name: string; size?: string | null; }
export interface OwnAttendanceResolution { action: string; reason: string; ot_hours?: string | null; resolved_at: string; }
/** Exact reduced self-service DTO; its ID is a React key, never presentation. */
export interface OwnAttendanceException {
  id: string;
  code: string;
  kind: OwnExceptionKind;
  status: OwnExceptionStatus;
  work_date: string;
  occurred_at: string;
  detail: string;
  evidence: OwnAttendanceEvidence[];
  resolution?: OwnAttendanceResolution;
  created_at: string;
}
export interface OwnAttendanceExceptionPage { items: OwnAttendanceException[]; total: number; limit: number; offset: number; }
/** Authority derives from the authenticated principal. No selector is legal. */
export interface OwnAttendanceExceptionQuery { month: string; status: OwnExceptionStatus; limit: number; offset: number; }
export interface OwnAttendanceWeek52Projection { week_start: string; current_hours: number; projected_hours: number; tone: "OK" | "WARN" | "DANGER"; acknowledged_at?: string | null; }
export type OwnAttendanceWeek52 = { status: "available"; projection: OwnAttendanceWeek52Projection } | { status: "not_available"; projection?: undefined };
export interface SelfServiceAttendanceApi {
  listOwnExceptions(query: OwnAttendanceExceptionQuery, signal?: AbortSignal): Promise<OwnAttendanceExceptionPage>;
  getOwnWeek52(weekStart: string, signal?: AbortSignal): Promise<OwnAttendanceWeek52>;
}
export class SelfServiceAttendanceTransportError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "SelfServiceAttendanceTransportError"; }
}
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isMonday(value: unknown): value is string {
  return isCalendarDate(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1;
}

function isRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = match;
  const [year, month, day, hour, minute, second] = [rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond].map(Number);
  const rawOffsetHour = match.at(8);
  const rawOffsetMinute = match.at(9);
  const offsetHour = rawOffsetHour === undefined ? undefined : Number(rawOffsetHour);
  const offsetMinute = rawOffsetMinute === undefined ? undefined : Number(rawOffsetMinute);
  if (!isCalendarDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour !== undefined && (offsetHour > 23 || offsetMinute === undefined || offsetMinute > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function validHours(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
/** Available requires a complete valid Monday projection; unavailable requires its absence. */
export function isValidOwnWeek52(value: unknown): value is OwnAttendanceWeek52 {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.status === "not_available") return envelope.projection === undefined;
  if (envelope.status !== "available" || !envelope.projection || typeof envelope.projection !== "object") return false;
  const p = envelope.projection as Record<string, unknown>;
  return isMonday(p.week_start) && validHours(p.current_hours) && validHours(p.projected_hours) && (p.tone === "OK" || p.tone === "WARN" || p.tone === "DANGER") && (p.acknowledged_at === undefined || p.acknowledged_at === null || isRfc3339DateTime(p.acknowledged_at));
}
