// Pure plan-vs-actual derivations for the attendance board. Every number here
// is computed from real backend rows (HR attendance records, attendance
// exceptions, substitutions) — no schedule registry exists yet, so nothing is
// synthesized beyond what those rows state.
import type {
  AttendanceException,
  EmployeeAttendanceRecord,
  Substitution,
} from "./attendanceApi";

export interface DaySegment {
  kind: "work" | "away";
  fromMin: number;
  toMin: number;
  /** Still running at `nowMin` (no closing event yet). */
  open: boolean;
}

export interface EmployeeDayRow {
  type: "employee";
  employeeId: string;
  name: string;
  segments: DaySegment[];
  exceptions: AttendanceException[];
  cover?: Substitution;
}

export interface SubFillInRow {
  type: "sub";
  sub: Substitution;
}

export interface GapRow {
  type: "gap";
  exception: AttendanceException;
}

export type DayBoardRow = EmployeeDayRow | SubFillInRow | GapRow;

// The console is a KST business surface: clock math is pinned to Asia/Seoul so
// a differently-zoned browser still renders the operational (Korean) day.
const KST_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});
const KST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" });

export function minutesOfDay(iso: string): number {
  const parts = KST_TIME.formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? "0",
  );
  return (hour % 24) * 60 + minute;
}

/**
 * Fold one employee's records for a day into 24h track segments.
 * CLOCK_IN/RETURNED open a work span; OUT_FOR_WORK/BUSINESS_TRIP switch to an
 * away span; CLOCK_OUT closes. An unclosed span extends to `nowMin`.
 */
export function daySegments(
  records: EmployeeAttendanceRecord[],
  nowMin: number,
): DaySegment[] {
  const ordered = [...records].sort((a, b) =>
    a.occurred_at.localeCompare(b.occurred_at),
  );
  const segments: DaySegment[] = [];
  let openKind: "work" | "away" | undefined;
  let openFrom = 0;
  const closeAt = (min: number) => {
    if (openKind && min > openFrom) {
      segments.push({
        kind: openKind,
        fromMin: openFrom,
        toMin: min,
        open: false,
      });
    }
    openKind = undefined;
  };
  for (const record of ordered) {
    const min = minutesOfDay(record.occurred_at);
    switch (record.kind) {
      case "CLOCK_IN":
      case "RETURNED":
        closeAt(min);
        openKind = "work";
        openFrom = min;
        break;
      case "OUT_FOR_WORK":
      case "BUSINESS_TRIP":
        closeAt(min);
        openKind = "away";
        openFrom = min;
        break;
      case "CLOCK_OUT":
        closeAt(min);
        break;
    }
  }
  if (openKind && nowMin > openFrom) {
    segments.push({
      kind: openKind,
      fromMin: openFrom,
      toMin: nowMin,
      open: true,
    });
  }
  return segments;
}

function substitutionCoversException(
  substitution: Substitution,
  exception: AttendanceException,
): boolean {
  if (substitution.status !== "ASSIGNED") return false;
  if (substitution.exception_id) {
    return substitution.exception_id === exception.id;
  }
  return (
    substitution.covered_employee_id === exception.employee_id &&
    substitution.cover_date === exception.work_date
  );
}

function coverForException(
  exception: AttendanceException,
  substitutions: Substitution[],
): Substitution | undefined {
  return substitutions.find((substitution) =>
    substitutionCoversException(substitution, exception),
  );
}

function coverForEmployeeNoShow(
  exceptions: AttendanceException[],
  substitutions: Substitution[],
): Substitution | undefined {
  return substitutions.find((substitution) =>
    exceptions.some((exception) =>
      substitutionCoversException(substitution, exception),
    ),
  );
}

/**
 * Today's board rows: employees with real clock activity, substitute fill-in
 * rows, then uncovered NO_SHOW gaps that still need a substitute.
 */
export function dayBoardRows(
  records: EmployeeAttendanceRecord[],
  exceptions: AttendanceException[],
  substitutions: Substitution[],
  workDate: string,
  nowMin: number,
): DayBoardRow[] {
  const todayRecords = records.filter(
    (record) => record.work_date === workDate,
  );
  const todayExceptions = exceptions.filter(
    (exception) => exception.work_date === workDate,
  );
  const todaySubs = substitutions.filter(
    (sub) => sub.cover_date === workDate && sub.status === "ASSIGNED",
  );

  const byEmployee = new Map<
    string,
    { name: string; records: EmployeeAttendanceRecord[] }
  >();
  for (const record of todayRecords) {
    const entry = byEmployee.get(record.employee_id) ?? {
      name: record.employee_display_name,
      records: [],
    };
    entry.records.push(record);
    byEmployee.set(record.employee_id, entry);
  }

  const employeeRows: EmployeeDayRow[] = [...byEmployee.entries()].map(
    ([employeeId, entry]) => {
      const employeeExceptions = todayExceptions.filter(
        (exception) => exception.employee_id === employeeId,
      );
      return {
        type: "employee",
        employeeId,
        name: entry.name,
        segments: daySegments(entry.records, nowMin),
        exceptions: employeeExceptions,
        cover: coverForEmployeeNoShow(
          employeeExceptions.filter(
            (exception) => exception.kind === "NO_SHOW",
          ),
          todaySubs,
        ),
      };
    },
  );
  employeeRows.sort((a, b) => a.name.localeCompare(b.name, "ko"));

  const subRows: SubFillInRow[] = todaySubs.map((sub) => ({
    type: "sub",
    sub,
  }));

  const gapRows: GapRow[] = todayExceptions
    .filter(
      (exception) =>
        exception.kind === "NO_SHOW" &&
        exception.status === "OPEN" &&
        !coverForException(exception, todaySubs),
    )
    .map((exception) => ({ type: "gap", exception }));

  return [...employeeRows, ...subRows, ...gapRows];
}

export type MonthCellKind =
  "late" | "absent" | "covered" | "ot" | "holiday" | "future" | "none";

export interface MonthCell {
  day: number;
  kind: MonthCellKind;
}

export interface MonthSheetRow {
  employeeId: string;
  name: string;
  team?: string | null;
  late: number;
  absent: number;
  otHours: number;
  cells: MonthCell[];
}

export function daysInMonth(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  if (!year || !monthIndex) return 0;
  return new Date(year, monthIndex, 0).getDate();
}

function isWeekend(month: string, day: number): boolean {
  const [year, monthIndex] = month.split("-").map(Number);
  if (!year || !monthIndex) return false;
  const weekday = new Date(year, monthIndex - 1, day).getDay();
  return weekday === 0 || weekday === 6;
}

/**
 * Month sheet derived from the month's exception + substitution rows. Cells
 * mark exception/cover days only; attendance-rate columns need the schedule
 * registry (deferred owner) and are deliberately absent.
 */
export function monthSheetRows(
  exceptions: AttendanceException[],
  substitutions: Substitution[],
  month: string,
  todayDate: string,
): MonthSheetRow[] {
  const inMonth = exceptions.filter((exception) =>
    exception.work_date.startsWith(month),
  );
  const monthSubs = substitutions.filter(
    (sub) => sub.cover_date.startsWith(month) && sub.status === "ASSIGNED",
  );
  const total = daysInMonth(month);

  const byEmployee = new Map<
    string,
    { name: string; team?: string | null; items: AttendanceException[] }
  >();
  for (const exception of inMonth) {
    const entry = byEmployee.get(exception.employee_id) ?? {
      name: exception.employee_name,
      team: exception.team,
      items: [],
    };
    entry.items.push(exception);
    byEmployee.set(exception.employee_id, entry);
  }

  const rows: MonthSheetRow[] = [...byEmployee.entries()].map(
    ([employeeId, entry]) => {
      const cells: MonthCell[] = [];
      for (let day = 1; day <= total; day += 1) {
        const date = `${month}-${String(day).padStart(2, "0")}`;
        const dayExceptions = entry.items.filter(
          (exception) => exception.work_date === date,
        );
        const noShows = dayExceptions.filter(
          (exception) => exception.kind === "NO_SHOW",
        );
        const late = dayExceptions.find(
          (exception) => exception.kind === "LATE",
        );
        const overtime = dayExceptions.find(
          (exception) =>
            exception.kind === "UNAPPROVED_OVERTIME" &&
            exception.resolution?.action === "APPROVE_OVERTIME",
        );
        const covered =
          noShows.length > 0 &&
          noShows.every((noShow) =>
            monthSubs.some((sub) => substitutionCoversException(sub, noShow)),
          );
        let kind: MonthCellKind = "none";
        if (noShows.length > 0) kind = covered ? "covered" : "absent";
        else if (late) kind = "late";
        else if (overtime) kind = "ot";
        else if (date > todayDate) kind = "future";
        else if (isWeekend(month, day)) kind = "holiday";
        cells.push({ day, kind });
      }
      return {
        employeeId,
        name: entry.name,
        team: entry.team,
        late: entry.items.filter((exception) => exception.kind === "LATE")
          .length,
        absent: entry.items.filter((exception) => exception.kind === "NO_SHOW")
          .length,
        otHours: entry.items.reduce(
          (sum, exception) => sum + (exception.resolution?.ot_hours ?? 0),
          0,
        ),
        cells,
      };
    },
  );
  rows.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return rows;
}

export interface CoverPlanRow {
  key: string;
  assigned: boolean;
  who: string;
  team?: string | null;
  date: string;
  detail: string;
  exception?: AttendanceException;
  sub?: Substitution;
}

/** Cover planner queue: uncovered open NO_SHOW gaps first, then assigned covers. */
export function coverPlanRows(
  exceptions: AttendanceException[],
  substitutions: Substitution[],
): CoverPlanRow[] {
  const assigned = substitutions.filter((sub) => sub.status === "ASSIGNED");
  const gaps: CoverPlanRow[] = exceptions
    .filter(
      (exception) =>
        exception.kind === "NO_SHOW" &&
        exception.status === "OPEN" &&
        !coverForException(exception, assigned),
    )
    .map((exception) => ({
      key: `gap-${exception.id}`,
      assigned: false,
      who: exception.employee_name,
      team: exception.team,
      date: exception.work_date,
      detail: exception.detail,
      exception,
    }));
  const covers: CoverPlanRow[] = assigned.map((sub) => ({
    key: `sub-${sub.id}`,
    assigned: true,
    who: sub.covered_name,
    team: sub.site,
    date: sub.cover_date,
    detail: `${sub.role} · ${formatWindow(sub.from_minutes, sub.to_minutes)} → ${sub.worker_name}`,
    sub,
  }));
  return [...gaps, ...covers];
}

export function formatWindow(fromMinutes: number, toMinutes: number): string {
  const hhmm = (min: number) =>
    `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  return `${hhmm(fromMinutes)}–${hhmm(toMinutes)}`;
}

/** Distinct employees with a CLOCK_IN today — the truthful "checked in" count. */
export function checkedInCount(
  records: EmployeeAttendanceRecord[],
  workDate: string,
): number {
  const ids = new Set(
    records
      .filter(
        (record) => record.work_date === workDate && record.kind === "CLOCK_IN",
      )
      .map((record) => record.employee_id),
  );
  return ids.size;
}

/** The KST calendar date of an instant, as YYYY-MM-DD. */
export function isoDate(at: Date): string {
  return KST_DATE.format(at);
}

export function isoMonth(at: Date): string {
  return isoDate(at).slice(0, 7);
}

/**
 * Attendance coverage must include every day in the selected month and the
 * seven following operational days. This prevents an older covered NO_SHOW
 * from being presented as an assignable gap when the month board is viewed.
 */
export function monthOperationalRange(month: string): {
  from_date: string;
  to_date: string;
} {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new RangeError(`Invalid attendance month: ${month}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const lastOperationalDay = new Date(Date.UTC(year, monthIndex + 1, 7));
  const to_date = `${String(lastOperationalDay.getUTCFullYear())}-${String(
    lastOperationalDay.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(lastOperationalDay.getUTCDate()).padStart(2, "0")}`;
  return { from_date: `${month}-01`, to_date };
}

/** Monday of the KST week containing `at` (Korean labor-week convention). */
export function weekStart(at: Date): string {
  const [year, month, day] = isoDate(at).split("-").map(Number);
  if (!year || !month || !day) return isoDate(at);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const offset = (noonUtc.getUTCDay() + 6) % 7;
  noonUtc.setUTCDate(noonUtc.getUTCDate() - offset);
  return `${String(noonUtc.getUTCFullYear())}-${String(noonUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(noonUtc.getUTCDate()).padStart(2, "0")}`;
}
