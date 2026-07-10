// UI copy is injected, never inlined — check-ui-strings forbids Hangul here and
// this lane must not edit ko.ts (the serial wire-up applies the koManifest for
// ko.console.supportslo). All new SLO labels/aria route through this accessor.

import { ko } from "../../i18n/ko";
import type { SloEscalationTarget, SloPosture } from "./slo-settings";

export interface SupportSloStrings {
  /** Command-center heading (replaces the SLA-labelled sentence, §4-26/§4-12). */
  commandTitle: string;
  /** Stat tile: urgent priority or SLO breach. */
  urgentOrBreached: string;
  /** Ticket chips — the "SLO" prefix distinguishes from contractual SLA chips. */
  posture: Record<Exclude<SloPosture, "ok" | "none">, string>;
  alerts: {
    title: string;
    /** Row chip naming the internal escalation target — alert, never penalty. */
    escalateTo: (target: string) => string;
    rowAria: (title: string) => string;
  };
  settings: {
    title: string;
    /** Scope chip pinning this card as an internal target (SLO, not SLA). */
    scopeChip: string;
    version: (version: number) => string;
    category: string;
    threshold: string;
    window: string;
    escalation: string;
    breachColumn: string;
    breaches: (count: number) => string;
    edit: string;
    save: string;
    cancel: string;
    pending: (version: number) => string;
    stagedBy: (name: string) => string;
    keepActive: string;
    approve: string;
    withdraw: string;
    targets: Record<SloEscalationTarget, string>;
    fieldAria: (category: string, field: string) => string;
  };
}

// English defaults keep the page mountable standalone pre-wire-up (same
// pattern as the policycanvas lane); the real ko.ts keys win once they land.
const FALLBACK: SupportSloStrings = {
  commandTitle: "Support operations",
  urgentOrBreached: "Urgent / SLO breach",
  posture: {
    overdue: "SLO breached",
    dueSoon: "SLO due soon",
  },
  alerts: {
    title: "SLO breach alerts",
    escalateTo: (target) => `Escalate to ${target}`,
    rowAria: (title) => `Open SLO-breached ticket ${title}`,
  },
  settings: {
    title: "SLO settings",
    scopeChip: "SLO / internal target",
    version: (version) => `v${String(version)}`,
    category: "Ticket type",
    threshold: "Response target (h)",
    window: "Window (days)",
    escalation: "Escalation target",
    breachColumn: "Breaches in window",
    breaches: (count) => `${String(count)} breaches`,
    edit: "Edit",
    save: "Save",
    cancel: "Cancel",
    pending: (version) => `Pending revision v${String(version)}`,
    stagedBy: (name) => `Staged by ${name}`,
    keepActive: "Active kept",
    approve: "Approve",
    withdraw: "Withdraw",
    targets: {
      TEAM_LEAD: "Team lead",
      DEDICATED: "Dedicated",
      ADMIN: "Admin",
    },
    fieldAria: (category, field) => `${category} ${field}`,
  },
};

/**
 * ko.console.supportslo — typed accessor. wire-pending: i18n wire-up — the
 * serial wire-up adds this namespace from the lane's koManifest; until it
 * lands the English fallback keeps the page mountable (tests inject the
 * Korean mirror).
 */
export function supportSloStrings(): SupportSloStrings {
  return (
    (ko.console as unknown as { supportslo?: SupportSloStrings }).supportslo ??
    FALLBACK
  );
}
