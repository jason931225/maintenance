/** Public, module-owned mount contract for the shared console registry. */
export interface AttendanceRouteContract {
  branchId: string;
}

/** Fixture is structural only: it deliberately contains no business records. */
export const ATTENDANCE_ROUTE_CONTRACT_FIXTURE: AttendanceRouteContract = {
  branchId: "00000000-0000-4000-8000-000000000000",
};
