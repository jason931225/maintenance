// Carbon-copy lifecycle engine — pure state model (charter §3 P0.5).
//
// The generic object lifecycle FSM lives server-side (BE-LC, #211): its allowed
// transitions are seeded in `lifecycle_transition_rules` and the REST surface
// (GET/POST /api/v1/lifecycles/{objectType}/{objectId}[/transition|/hold])
// validates every move against that table. The one seeded object type today is
// `document`: draft → submitted → approved → active → revised → archived →
// disposed (migration 0107).
//
// This module is the UI mirror of that FSM as a data-driven config so the
// single LifecycleCard renders the 5-step stepper (§4-18: one card, config not
// forks) without hardcoding per-screen state graphs. It is PURE and i18n-free —
// steps carry a `labelKey`, the view resolves the Korean string.
//
// ponytail: the API returns the current state and history but NOT the set of
// legal next transitions, so we mirror the seeded forward edges here. If BE-LC
// later exposes the allowed-transition set on the GET payload, delete
// `transitions` below and read it from the record. New object types slot in as
// new `LifecycleChain` configs, never new components.

import type { Lifecycle } from "./types";

export type StepStatus = "done" | "current" | "pending";

/** One visual stepper stage; may fold several backend states (e.g. review). */
export interface LifecycleStep {
  key: string;
  /** Backend `currentState` values that land the stepper on this stage. */
  states: string[];
  /** Key under `ko.console.lifecycle.stage`. */
  labelKey: string;
}

export interface LifecycleChain {
  objectType: string;
  steps: LifecycleStep[];
  /** Forward edges [from, to], mirroring the seeded rule table. */
  transitions: [string, string][];
}

/** The seeded `document` chain (migration 0107). 5 visual steps over 7 states. */
export const DOCUMENT_CHAIN: LifecycleChain = {
  objectType: "document",
  steps: [
    { key: "draft", states: ["draft"], labelKey: "draft" },
    { key: "review", states: ["submitted", "approved"], labelKey: "review" },
    { key: "active", states: ["active", "revised"], labelKey: "active" },
    { key: "archived", states: ["archived"], labelKey: "archived" },
    { key: "disposed", states: ["disposed"], labelKey: "disposed" },
  ],
  transitions: [
    ["draft", "submitted"],
    ["submitted", "approved"],
    ["approved", "active"],
    ["active", "revised"],
    ["revised", "archived"],
    ["archived", "disposed"],
  ],
};

/** Registry of the chains the console knows. Only `document` has a live FSM. */
export const LIFECYCLE_CHAINS: Record<string, LifecycleChain> = {
  document: DOCUMENT_CHAIN,
};

export function chainFor(objectType: string): LifecycleChain | undefined {
  return LIFECYCLE_CHAINS[objectType];
}

export interface RenderedStep {
  key: string;
  labelKey: string;
  status: StepStatus;
}

/**
 * Map the record's `currentState` onto the chain's visual steps. Steps before
 * the current stage are `done`, the containing stage is `current`, the rest are
 * `pending`. An unknown state (no stage contains it) yields all-pending.
 */
export function computeStepper(chain: LifecycleChain, currentState: string): RenderedStep[] {
  const idx = chain.steps.findIndex((s) => s.states.includes(currentState));
  return chain.steps.map((s, i) => ({
    key: s.key,
    labelKey: s.labelKey,
    status: idx < 0 ? "pending" : i < idx ? "done" : i === idx ? "current" : "pending",
  }));
}

/** The legal next states from `currentState`, per the seeded forward edges. */
export function allowedTransitions(chain: LifecycleChain, currentState: string): string[] {
  return chain.transitions.filter(([from]) => from === currentState).map(([, to]) => to);
}

/** The terminal state gated by legal hold / retention (mirrors DISPOSED_STATE). */
export const DISPOSED_STATE = "disposed";

export type DisposeBlock = "legalHold" | "retention" | null;

/**
 * Why a dispose transition is refused, mirroring the server's fail-closed gate
 * (`lifecycle::transition_lifecycle`): legal hold set, or a retention deadline
 * still in the future. `today` and `retentionUntil` are ISO `YYYY-MM-DD`, whose
 * lexicographic order matches chronological order.
 */
export function disposeBlock(record: Lifecycle, today: string): DisposeBlock {
  if (record.legalHold) return "legalHold";
  if (record.retentionUntil && record.retentionUntil > today) return "retention";
  return null;
}
