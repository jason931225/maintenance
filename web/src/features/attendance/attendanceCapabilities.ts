export type AttendanceFeature =
  | "employee_directory_read"
  | "attendance_exception_manage"
  | "attendance_substitution_manage"
  | "period_lock_manage";

/** Canonical policy gate exposes typed feature, permission, and branch queries. */
export interface AttendancePolicyGate {
  allows: (query: {
    feature: AttendanceFeature;
    branch: string;
    minPermission: "allow";
  }) => boolean;
}

export interface AttendanceCapabilities {
  canRead: boolean;
  canRaise: boolean;
  canResolve: boolean;
  canSubstitute: boolean;
  canClose: boolean;
  canAckW52: boolean;
}

/** Pure projection adapter matching the attendance backend feature gates. */
export function deriveAttendanceCapabilities(
  gate: AttendancePolicyGate,
  branchId: string,
): AttendanceCapabilities {
  const allows = (feature: AttendanceFeature) =>
    gate.allows({ feature, branch: branchId, minPermission: "allow" });
  const canRead = allows("employee_directory_read");
  const canManageExceptions = allows("attendance_exception_manage");
  return {
    canRead,
    canRaise: canManageExceptions,
    canResolve: canManageExceptions,
    canSubstitute: allows("attendance_substitution_manage"),
    canClose: allows("period_lock_manage"),
    canAckW52: canManageExceptions,
  };
}
