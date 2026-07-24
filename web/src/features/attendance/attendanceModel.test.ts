import { describe, expect, it } from "vitest";

import type {
  AttendanceException,
  EmployeeAttendanceRecord,
  Substitution,
} from "./attendanceApi";
import {
  checkedInCount,
  coverPlanRows,
  dayBoardRows,
  daySegments,
  daysInMonth,
  formatWindow,
  isoDate,
  isoMonth,
  monthSheetRows,
  monthOperationalRange,
  weekStart,
} from "./attendanceModel";

const TODAY = "2026-07-23";

function record(
  overrides: Partial<EmployeeAttendanceRecord> & {
    kind: EmployeeAttendanceRecord["kind"];
    occurred_at: string;
  },
): EmployeeAttendanceRecord {
  return {
    id: `rec-${overrides.occurred_at}`,
    employee_id: "emp-1",
    employee_display_name: "김성호",
    work_date: TODAY,
    state_after: "CLOCKED_IN",
    payroll_material_ref_id: "mat-1",
    payroll_link_status: "LINKED",
    duplicate: false,
    ...overrides,
  };
}

function exception(
  overrides: Partial<AttendanceException>,
): AttendanceException {
  return {
    id: "ex-1",
    code: "AT-0723-01",
    kind: "LATE",
    status: "OPEN",
    employee_id: "emp-1",
    employee_name: "김성호",
    team: "정비사업팀",
    work_date: TODAY,
    occurred_at: "2026-07-23T09:34:00+09:00",
    detail: "표준 출근 09:00 — 34분 지각",
    evidence: [],
    links: [],
    created_at: "2026-07-23T09:34:10+09:00",
    ...overrides,
  };
}

function substitution(overrides: Partial<Substitution>): Substitution {
  return {
    id: "sub-1",
    site: "대원강업 상주",
    role: "경비",
    cover_date: TODAY,
    from_minutes: 690,
    to_minutes: 1080,
    covered_employee_id: "emp-2",
    covered_name: "최민석",
    reason_kind: "NO_SHOW",
    worker_name: "박대근",
    worker_type: "EMPLOYEE",
    status: "ASSIGNED",
    created_by: "actor-1",
    created_at: "2026-07-23T11:00:00+09:00",
    ...overrides,
  };
}

describe("monthOperationalRange", () => {
  it("covers every selected-month date plus the following seven operational days", () => {
    expect(monthOperationalRange("2026-07")).toEqual({
      from_date: "2026-07-01",
      to_date: "2026-08-07",
    });
    expect(monthOperationalRange("2026-12")).toEqual({
      from_date: "2026-12-01",
      to_date: "2027-01-07",
    });
  });

  it("rejects a malformed selected month rather than querying an invented window", () => {
    expect(() => monthOperationalRange("2026-13")).toThrow(RangeError);
  });
});

describe("daySegments", () => {
  it("folds the clock FSM into work/away spans and keeps the open span running to now", () => {
    const segments = daySegments(
      [
        record({ kind: "CLOCK_IN", occurred_at: "2026-07-23T09:00:00+09:00" }),
        record({
          kind: "OUT_FOR_WORK",
          occurred_at: "2026-07-23T11:00:00+09:00",
        }),
        record({ kind: "RETURNED", occurred_at: "2026-07-23T13:00:00+09:00" }),
      ],
      14 * 60,
    );
    // Minutes are pinned to the Asia/Seoul business clock regardless of env TZ.
    expect(segments).toEqual([
      { kind: "work", fromMin: 9 * 60, toMin: 11 * 60, open: false },
      { kind: "away", fromMin: 11 * 60, toMin: 13 * 60, open: false },
      { kind: "work", fromMin: 13 * 60, toMin: 14 * 60, open: true },
    ]);
  });

  it("closes at CLOCK_OUT and produces no open span", () => {
    const segments = daySegments(
      [
        record({ kind: "CLOCK_IN", occurred_at: "2026-07-23T09:00:00+09:00" }),
        record({ kind: "CLOCK_OUT", occurred_at: "2026-07-23T18:00:00+09:00" }),
      ],
      20 * 60,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].open).toBe(false);
  });
});

describe("dayBoardRows", () => {
  it("returns employee rows, substitute fill-ins, and uncovered no-show gaps", () => {
    const rows = dayBoardRows(
      [record({ kind: "CLOCK_IN", occurred_at: "2026-07-23T09:00:00+09:00" })],
      [
        exception({}),
        exception({
          id: "ex-2",
          kind: "NO_SHOW",
          employee_id: "emp-2",
          employee_name: "최민석",
        }),
        exception({
          id: "ex-3",
          kind: "NO_SHOW",
          employee_id: "emp-3",
          employee_name: "이영희",
        }),
      ],
      [substitution({ exception_id: "ex-2" })],
      TODAY,
      600,
    );
    const types = rows.map((row) => row.type);
    expect(types).toEqual(["employee", "sub", "gap"]);
    const gap = rows.find((row) => row.type === "gap");
    expect(gap?.type === "gap" && gap.exception.id).toBe("ex-3");
    const employee = rows.find((row) => row.type === "employee");
    expect(employee?.type === "employee" && employee.exceptions).toHaveLength(
      1,
    );
  });

  it("marks a covered employee with its substitution", () => {
    const rows = dayBoardRows(
      [
        record({
          kind: "CLOCK_IN",
          occurred_at: "2026-07-23T06:00:00+09:00",
          employee_id: "emp-2",
          employee_display_name: "최민석",
        }),
      ],
      [],
      [substitution({})],
      TODAY,
      600,
    );
    const employee = rows.find((row) => row.type === "employee");
    expect(employee?.type === "employee" && employee.cover?.worker_name).toBe(
      "박대근",
    );
  });
});

describe("monthSheetRows", () => {
  it("aggregates late/absent counts and approved overtime hours per employee", () => {
    const rows = monthSheetRows(
      [
        exception({ work_date: "2026-07-02" }),
        exception({ id: "ex-2", kind: "NO_SHOW", work_date: "2026-07-03" }),
        exception({
          id: "ex-3",
          kind: "UNAPPROVED_OVERTIME",
          status: "RESOLVED",
          work_date: "2026-07-04",
          resolution: {
            action: "APPROVE_OVERTIME",
            reason: "생산 마감 대응",
            linked_work_ref: "WO-2638",
            ot_hours: 2.1,
            actor: "actor-1",
            resolved_at: "2026-07-05T10:00:00+09:00",
          },
        }),
      ],
      [],
      "2026-07",
      TODAY,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].late).toBe(1);
    expect(rows[0].absent).toBe(1);
    expect(rows[0].otHours).toBeCloseTo(2.1);
    expect(rows[0].cells).toHaveLength(31);
    expect(rows[0].cells[1].kind).toBe("late");
    expect(rows[0].cells[2].kind).toBe("absent");
    expect(rows[0].cells[3].kind).toBe("ot");
    expect(rows[0].cells[30].kind).toBe("future");
  });

  it("marks a covered no-show day with the cover dot kind", () => {
    const rows = monthSheetRows(
      [exception({ kind: "NO_SHOW", work_date: "2026-07-03" })],
      [substitution({ exception_id: "ex-1", cover_date: "2026-07-03" })],
      "2026-07",
      TODAY,
    );
    expect(rows[0].cells[2].kind).toBe("covered");
  });
});

describe("coverPlanRows", () => {
  it("does not cover a second no-show for the same employee on another date", () => {
    const rows = coverPlanRows(
      [
        exception({
          id: "ex-early",
          kind: "NO_SHOW",
          employee_id: "emp-9",
          employee_name: "이영희",
          work_date: "2026-07-10",
        }),
        exception({
          id: "ex-later",
          kind: "NO_SHOW",
          employee_id: "emp-9",
          employee_name: "이영희",
          work_date: "2026-07-11",
        }),
      ],
      [
        substitution({
          covered_employee_id: "emp-9",
          cover_date: "2026-07-10",
          exception_id: undefined,
        }),
      ],
    );

    expect(rows.filter((row) => !row.assigned).map((row) => row.key)).toEqual([
      "gap-ex-later",
    ]);
  });

  it("lists uncovered open no-shows before assigned covers", () => {
    const rows = coverPlanRows(
      [
        exception({
          id: "ex-2",
          kind: "NO_SHOW",
          employee_id: "emp-9",
          employee_name: "이영희",
        }),
        exception({ id: "ex-9", kind: "LATE" }),
      ],
      [substitution({})],
    );
    expect(rows.map((row) => row.assigned)).toEqual([false, true]);
    expect(rows[0].who).toBe("이영희");
    expect(rows[1].detail).toContain("11:30–18:00");
  });
});

describe("calendar helpers", () => {
  it("formats minute windows and month arithmetic", () => {
    expect(formatWindow(690, 1080)).toBe("11:30–18:00");
    expect(daysInMonth("2026-02")).toBe(28);
    expect(isoDate(new Date("2026-07-23T10:30:00+09:00"))).toBe(TODAY);
    expect(isoMonth(new Date("2026-07-23T10:30:00+09:00"))).toBe("2026-07");
    // 2026-07-23 is a Thursday in KST; the labor week starts Monday 2026-07-20.
    expect(weekStart(new Date("2026-07-23T10:30:00+09:00"))).toBe("2026-07-20");
  });

  it("counts distinct clocked-in employees for the day only", () => {
    expect(
      checkedInCount(
        [
          record({
            kind: "CLOCK_IN",
            occurred_at: "2026-07-23T09:00:00+09:00",
          }),
          record({
            kind: "CLOCK_IN",
            occurred_at: "2026-07-23T09:10:00+09:00",
          }),
          record({
            kind: "CLOCK_IN",
            occurred_at: "2026-07-22T09:00:00+09:00",
            work_date: "2026-07-22",
            employee_id: "emp-2",
          }),
        ],
        TODAY,
      ),
    ).toBe(1);
  });
});
