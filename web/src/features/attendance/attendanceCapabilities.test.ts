import { describe, expect, it } from "vitest";

import {
  deriveAttendanceCapabilities,
  type AttendanceFeature,
} from "./attendanceCapabilities";

function gateOf(granted: AttendanceFeature[], expectedBranch?: string) {
  return {
    allows: ({
      feature,
      branch,
    }: {
      feature: AttendanceFeature;
      branch: string;
    }) => {
      if (expectedBranch !== undefined && branch !== expectedBranch)
        return false;
      return granted.includes(feature);
    },
  };
}

describe("deriveAttendanceCapabilities", () => {
  it("denies everything without grants", () => {
    expect(deriveAttendanceCapabilities(gateOf([]), "b1")).toEqual({
      canRead: false,
      canRaise: false,
      canResolve: false,
      canSubstitute: false,
      canClose: false,
      canAckW52: false,
    });
  });

  it("maps each backend feature onto its actions", () => {
    const all = deriveAttendanceCapabilities(
      gateOf([
        "employee_directory_read",
        "attendance_exception_manage",
        "attendance_substitution_manage",
        "period_lock_manage",
      ]),
      "b1",
    );
    expect(all).toEqual({
      canRead: true,
      canRaise: true,
      canResolve: true,
      canSubstitute: true,
      canClose: true,
      canAckW52: true,
    });
    const readOnly = deriveAttendanceCapabilities(
      gateOf(["employee_directory_read"]),
      "b1",
    );
    expect(readOnly.canRead).toBe(true);
    expect(readOnly.canResolve).toBe(false);
    expect(readOnly.canSubstitute).toBe(false);
    expect(readOnly.canClose).toBe(false);
  });

  it("queries the gate for the given branch", () => {
    const scoped = gateOf(["employee_directory_read"], "b1");
    expect(deriveAttendanceCapabilities(scoped, "b1").canRead).toBe(true);
    expect(deriveAttendanceCapabilities(scoped, "b2").canRead).toBe(false);
  });
});
