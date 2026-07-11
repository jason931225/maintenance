// Console screen model for 지원 센터 — reuses the REAL support-desk data
// model (buildSupportStats/Drill, exported from SupportPage.tsx for exactly
// this reuse, §4-18) and the REAL formatting/SLO logic from
// features/support/*. This file adds only the console-pure presentation glue
// (StatusChip tone mapping) the legacy shadcn page didn't need.
import {
  buildSupportStats,
  type Drill,
  type SupportStats,
} from "../../../pages/SupportPage";
import type {
  SupportTicketPriority,
  SupportTicketStatus,
} from "../../../api/types";
import { ko } from "../../../i18n/ko";
import type { SloPosture } from "../../../features/support/slo-settings";
import { supportSloStrings } from "../../../features/support/supportslo-strings";

export { buildSupportStats };
export type { Drill, SupportStats };

export type StatusChipTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

export function statusTone(status: SupportTicketStatus): StatusChipTone {
  switch (status) {
    case "OPEN":
      return "info";
    case "IN_PROGRESS":
      return "accent";
    case "ON_HOLD":
      return "warn";
    case "RESOLVED":
      return "ok";
    case "CLOSED":
      return "neutral";
  }
}

export function priorityTone(priority: SupportTicketPriority): StatusChipTone {
  switch (priority) {
    case "URGENT":
      return "danger";
    case "HIGH":
      return "warn";
    case "MEDIUM":
    case "LOW":
      return "neutral";
  }
}

export function sloTone(posture: SloPosture): StatusChipTone {
  switch (posture) {
    case "overdue":
      return "danger";
    case "dueSoon":
      return "warn";
    case "ok":
    case "none":
      return "neutral";
  }
}

/** Same four real drills SupportCommandCenter renders — reused labels, not new copy. */
export function drillItems(
  stats: SupportStats,
): { key: Drill; label: string; value: number }[] {
  return [
    { key: "open", label: ko.support.command.open, value: stats.open },
    {
      key: "urgent",
      label: supportSloStrings().urgentOrBreached,
      value: stats.urgentOrBreached,
    },
    { key: "unassigned", label: ko.support.command.unassigned, value: stats.unassigned },
    {
      key: "resolved",
      label: ko.support.command.resolvedHistory,
      value: stats.resolvedHistory,
    },
  ];
}

// Deny-by-omission is enforced server-side regardless; these mirror the same
// role literals SupportPage.tsx checks (components/shell/nav's hasAnyRole is
// banned under console/**, §check-console-purity) so hiding a control here is
// UX only, never the authority boundary.
export function canAssignTickets(roles: readonly string[] | undefined): boolean {
  return (roles ?? []).some((r) => r === "ADMIN" || r === "SUPER_ADMIN");
}

export function canCommentOnTickets(roles: readonly string[] | undefined): boolean {
  return (roles ?? []).some(
    (r) => r === "MECHANIC" || r === "ADMIN" || r === "SUPER_ADMIN",
  );
}
