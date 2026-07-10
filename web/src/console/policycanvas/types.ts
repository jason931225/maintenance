// No-code Cedar policy canvas — model types. The authored payload is the real
// REST contract (api/policyCedar.ts, generated from the OpenAPI): one effect,
// one action, one resource type, and AND-ed conditions. The canvas only adds
// presentation state on top; it never invents fields the backend cannot store.

import type { PolicyNoCodeBlocks } from "../../api/policyCedar";

export type PolicyEffect = "permit" | "forbid";

/** Actions the backend authoring schema declares (strict-validated). */
export const POLICY_ACTIONS = [
  "view",
  "edit",
  "read_field",
  "console:configure",
  "console:deploy",
] as const;

export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Resource attrs the authoring schema whitelists on a condition's left side. */
export const RESOURCE_CONDITION_ATTRS = [
  "resource_type",
  "owner",
  "branch",
  "legal_hold",
] as const;

/** Principal set attrs usable with `contains` (roles are attributes, never policy). */
export const SUBJECT_SET_ATTRS = ["roles", "clearance_keys"] as const;

/** Subject attrs referenceable on a condition's right side (`principal.<attr>`). */
export const SUBJECT_ATTRS = [
  "org",
  "user_id",
  "roles",
  "clearance_keys",
] as const;

/**
 * The policy being edited on the canvas. `draftId` is null until the first
 * save creates the server draft; `catalogId` links a staged revision of an
 * existing catalog policy (pendingRev §3.9.0 — sourced from the API states).
 */
export interface PolicyWorkingDoc {
  draftId: string | null;
  catalogId: string | null;
  draftKey: string;
  title: string;
  blocks: PolicyNoCodeBlocks;
}

/**
 * Presentation category of a §5c decision: deny with determining policies =
 * forbid won; allow = permit matched; deny with none = deny-by-omission.
 */
export type SimulationReason = "forbid" | "permit" | "omission";

/** Canvas block ids — one fixed P→R→A→E sequence per policy. */
export const POLICY_BLOCK_IDS = {
  principal: "blk-principal",
  resource: "blk-resource",
  action: "blk-action",
  effect: "blk-effect",
} as const;

export type PolicyBlockId =
  (typeof POLICY_BLOCK_IDS)[keyof typeof POLICY_BLOCK_IDS];

/** PBAC affordance keys — deny-by-omission via the shared PolicyGated. */
export const POLICY_CANVAS_ACTIONS = {
  author: "policy.author",
  approve: "policy.approve",
} as const;
