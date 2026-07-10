// UI copy is injected, never inlined — check-ui-strings forbids Hangul here and
// this lane must not edit ko.ts (the serial wire-up applies the koManifest for
// ko.console.supportslo). All new SLO labels/aria route through this accessor.

import { ko } from "../../i18n/ko";
import type {
  EngineSloWindow,
  EngineTicketType,
  SloEscalationTarget,
  SloPosture,
} from "./slo-settings";

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
  /**
   * SLO settings CARD → real support_slo_setting engine instances (3
   * ticket_type buckets — coarser than the SupportTicketCategory badges
   * above; be2-config-objects seed.rs is the authoritative schema). Optional
   * + merged with an English fallback (below): ko.console.supportslo is
   * already wired for the fields above, but this lane must not edit ko.ts
   * directly — the serial wire-up promotes ENGINE_FALLBACK into
   * ko.console.supportslo.engine once landed.
   */
  engine?: EngineSloStrings;
}

export interface EngineSloStrings {
  title: string;
  ticketTypes: Record<EngineTicketType, string>;
  thresholdMinutes: string;
  windowLabel: string;
  windows: Record<EngineSloWindow, string>;
  escalationLabel: string;
  revisionColumn: string;
  lastRevision: (version: number) => string;
  notSaved: string;
  loading: string;
  error: string;
  commit: string;
  fieldAria: (ticketType: string, field: string) => string;
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

/** English default for the new `engine` block, pending ko.ts wire-up. */
const ENGINE_FALLBACK: EngineSloStrings = {
  title: "SLO settings (engine)",
  ticketTypes: { incident: "Incident", request: "Request", change: "Change" },
  thresholdMinutes: "Response target (min)",
  windowLabel: "Window",
  windows: { business_hours: "Business hours", calendar: "24x7" },
  escalationLabel: "Escalation target",
  revisionColumn: "Last revision",
  lastRevision: (version) => `Revision v${String(version)}`,
  notSaved: "Not saved yet",
  loading: "Loading SLO settings…",
  error: "SLO settings unavailable",
  commit: "Approve — commit revision",
  fieldAria: (ticketType, field) => `${ticketType} ${field}`,
};

/**
 * ko.console.supportslo — typed accessor. wire-pending: i18n wire-up — the
 * serial wire-up adds this namespace from the lane's koManifest; until it
 * lands the English fallback keeps the page mountable (tests inject the
 * Korean mirror).
 */
function baseSupportSloStrings(): SupportSloStrings {
  return (
    (ko.console as unknown as { supportslo?: SupportSloStrings }).supportslo ??
    FALLBACK
  );
}

export function supportSloStrings(): SupportSloStrings {
  return baseSupportSloStrings();
}

/** Read-time merge with ENGINE_FALLBACK — always returns a filled `engine`. */
export function supportSloStringsFilled(): SupportSloStrings & { engine: EngineSloStrings } {
  const base = baseSupportSloStrings();
  return { ...base, engine: base.engine ?? ENGINE_FALLBACK };
}
