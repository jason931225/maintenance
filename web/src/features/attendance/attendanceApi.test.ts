import { describe, expect, it } from "vitest";

import {
  AttendanceTransportError,
  type AttendanceTransport,
} from "./attendanceApi";

describe("AttendanceTransport", () => {
  it("keeps the private screen boundary typed and surfaces status-coded failures", () => {
    const error = new AttendanceTransportError("forbidden", 403, {
      error: { message: "forbidden" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(403);
    expect(error.body).toEqual({ error: { message: "forbidden" } });
  });

  it("requires every screen operation on the production transport port", () => {
    const requiredOperations: Array<keyof AttendanceTransport> = [
      "listExceptions",
      "createException",
      "resolveException",
      "listSubstitutions",
      "createSubstitution",
      "cancelSubstitution",
      "listCloses",
      "preflightClose",
      "confirmClose",
      "addCloseAmendment",
      "listWeek52",
      "ackWeek52",
      "listAttendanceRecords",
      "listAttendanceSummary",
    ];
    expect(requiredOperations).toHaveLength(14);
  });
});
