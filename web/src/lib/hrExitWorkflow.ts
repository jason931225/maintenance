import type { EmployeeExitCaseStatus } from "../api/types";
import type { Tone } from "./semantic";

const EXIT_CASE_STATUS_TONES: Record<EmployeeExitCaseStatus, Tone> = {
  REPORTED: "warning",
  HR_CONFIRMED: "success",
  HQ_CONFIRMED: "success",
  SETTLEMENT_READY: "success",
  APPROVAL_DRAFTED: "info",
  SUBMITTED: "info",
  REJECTED: "danger",
  CANCELLED: "neutral",
};

export function exitCaseStatusLabel(
  status: EmployeeExitCaseStatus,
  labels: Readonly<Partial<Record<EmployeeExitCaseStatus, string>>>,
): string {
  return labels[status] ?? status;
}

export function exitCaseTone(status: EmployeeExitCaseStatus): Tone {
  return EXIT_CASE_STATUS_TONES[status];
}

export function exitWorkflowRoleLabel(
  role: string,
  labels: Readonly<Record<string, string>>,
): string {
  return labels[role] ?? role;
}
