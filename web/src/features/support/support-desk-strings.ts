// UI copy is injected, never inlined — check-ui-strings forbids Hangul here and
// this lane must not edit ko.ts (the serial wire-up applies the koManifest for
// ko.console.supportdesk). Stat-strip / SUP-code / SLO-timer / escalation copy
// routes through this accessor (same pattern as supportslo-strings.ts).

import { ko } from "../../i18n/ko";

export interface SupportDeskStrings {
  /** Stat strip group aria (§4-11 compact drillable strip). */
  statsAria: string;
  /** Stat drill button aria — the stat filters the list, never a dead number. */
  drill: (label: string) => string;
  /** SLO timer chip: time left until the ACTIVE-setting deadline. */
  sloRemaining: (time: string) => string;
  /** SLO timer chip: time past the deadline (internal alert, §4-26). */
  sloOverdueBy: (time: string) => string;
  /** Compact hours+minutes duration for the SLO timer chip. */
  duration: (hours: number, minutes: number) => string;
  /** Internal-note body posted by the escalation action (audited via REST). */
  escalationNote: (target: string) => string;
  escalateFailed: string;
}

// English defaults keep the page mountable standalone pre-wire-up; the real
// ko.ts keys win once the serial i18n wire-up lands the koManifest.
const FALLBACK: SupportDeskStrings = {
  statsAria: "Ticket stats",
  drill: (label) => `Filter list by ${label}`,
  sloRemaining: (time) => `SLO ${time} left`,
  sloOverdueBy: (time) => `SLO ${time} over`,
  duration: (hours, minutes) => `${String(hours)}h ${String(minutes)}m`,
  escalationNote: (target) => `Escalated to ${target} — SLO review requested`,
  escalateFailed: "Escalation could not be posted.",
};

/**
 * ko.console.supportdesk — typed accessor. wire-pending: i18n wire-up — the
 * serial wire-up adds this namespace from the lane's koManifest; until it
 * lands the English fallback keeps the page mountable (tests inject the
 * Korean mirror).
 */
export function supportDeskStrings(): SupportDeskStrings {
  return (
    (ko.console as unknown as { supportdesk?: SupportDeskStrings })
      .supportdesk ?? FALLBACK
  );
}
