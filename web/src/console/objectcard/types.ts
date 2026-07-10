// §4-14 / §4.7-3 ObjectCard — the single object-detail surface. The descriptor
// shape mirrors the BE ontology engine (be-ontology-engine-arch.md §2:
// ont_object_types / property_defs / link_types / action_types / instance
// revisions + §3 lifecycle + governance). Phase C swaps the stub feed for the
// real GET /ontology/instances/{id} payload — the shapes already line up.

export type StatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "purple";

/** Instance lifecycle FSM (arch §3b): draft → active → (locked) → archived → disposed. */
export type ObjectLifecycleState = "draft" | "active" | "locked" | "archived" | "disposed";

/** ont_link_types.cardinality. */
export type LinkCardinality = "one_one" | "one_many" | "many_many";

/** A typed property (ont_property_defs + the instance's value for it). */
export interface ObjectCardProperty {
  /** ont_property_defs.key */
  key: string;
  /** Localized property title (registry-supplied). */
  title: string;
  /** Field-schema discriminated-union tag (arch §3c, ~35 types). Reader degrades on unknown. */
  type: string;
  /** Display value; null ⇒ property-policy denied server-side (arch §5b) → omitted. */
  value: string | null;
  /** ont_property_defs.in_property_policy — client also gates read (deny-by-omission). */
  inPropertyPolicy?: boolean;
  required?: boolean;
}

/** A typed relation edge (ont_link_types + one ont_links row). */
export interface ObjectCardRelation {
  /** ont_links.id — the handle for removal. */
  linkId: string;
  /** ont_link_types.title / stable_key. */
  linkType: string;
  /** Edge direction relative to this object. */
  direction: "from" | "to";
  cardinality: LinkCardinality;
  /** Far-end object code (drag token) + title. */
  code: string;
  title: string;
}

/** One step of the lifecycle stepper. */
export interface ObjectCardLifecycleStep {
  state: ObjectLifecycleState;
  reached: boolean;
  current: boolean;
}

/** ont_instance_revisions row — hash-verified history (arch §1b fixity chain). */
export interface ObjectCardRevision {
  version: number;
  at: string;
  actor: string;
  reason?: string;
  /** row_hash chain verified against the L20 canonicalizer. */
  hashVerified: boolean;
  /** action_type stable_key that produced the revision. */
  action?: string;
}

/** gov_approvals four-eyes line (arch §3b; approver ≠ requester). */
export interface ObjectCardApproval {
  id: string;
  kind: string;
  requestedBy: string;
  approver?: string;
  decision: "pending" | "approved" | "rejected";
  at?: string;
}

/** Acting automation / policy / series chip (dynamic layer). */
export interface ObjectCardActingChip {
  id: string;
  label: string;
  kind: "automation" | "policy" | "series";
}

/** Invokable action (ont_action_types → POST /ontology/actions/{key}/execute). */
export interface ObjectCardAction {
  /** ont_action_types.stable_key. */
  key: string;
  title: string;
  tone?: StatusTone;
  /** Action gates a reason at submit (§16 control-point). */
  requiresReason?: boolean;
}

/** The full object-card payload (arch §2 registry + instance). */
export interface ObjectCardDescriptor {
  /** ont_instances.id */
  id: string;
  /** Object code carried in drag payloads / window tray (e.g. "WO-2643"). */
  code: string;
  title: string;
  /** id = ont_object_types version id (required by the governed action/lifecycle REST). */
  objectType: { key: string; title: string; id?: string };
  lifecycleState: ObjectLifecycleState;
  schemaVersion?: number;
  properties: ObjectCardProperty[];
  relations: ObjectCardRelation[];
  lifecycle: ObjectCardLifecycleStep[];
  history: ObjectCardRevision[];
  approvals?: ObjectCardApproval[];
  acting?: ObjectCardActingChip[];
  actions: ObjectCardAction[];
}

/** Reference passed back when a relation edge is drawn (matches window/objDrag ObjectRef). */
export interface ObjectCardRelationDraft {
  code: string;
  title: string;
  linkType: string;
}

// Action invocation, override, and lifecycle preflight are wired to the real
// REST by GovernedObjectCard (wired.tsx); these callbacks remain the host seam
// for the semantic layer and for the not-yet-existing endpoints noted below.
export interface ObjectCardHandlers {
  /** Invoke an action (POST /ontology/actions/{key}/execute). ctx.reason set when required. */
  onAction?: (action: ObjectCardAction, ctx: { reason?: string }) => void;
  /** Draw a new edge (POST /ontology/instances/{id}/links) — audited, removable. */
  onRelationAdd?: (draft: ObjectCardRelationDraft) => void;
  /** Remove an edge by ont_links.id (audited). */
  onRelationRemove?: (linkId: string) => void;
  /** Lifecycle transition (POST /ontology/instances/{id}/lifecycle). */
  onLifecycleTransition?: (to: ObjectLifecycleState) => void;
  /** Commit an edit. mode="direct" for draft, "override" (reason + four-eyes) for non-draft (§20). */
  onEdit?: (ctx: { mode: "direct" | "override"; reason?: string }) => void;
}

// PBAC actions (deny-by-omission via PolicyGated / usePolicyGate — Cedar field·op·value).
export const OBJECT_CARD_ACTIONS = {
  propertyRead: "ontology.property.read",
  edit: "ontology.instance.edit",
  actionExecute: "ontology.action.execute",
  linkCreate: "ontology.link.create",
  linkDelete: "ontology.link.delete",
  lifecycleTransition: "ontology.instance.lifecycle",
  overrideOpen: "governance.override.open",
  approvalDecide: "governance.approval.decide",
} as const;
