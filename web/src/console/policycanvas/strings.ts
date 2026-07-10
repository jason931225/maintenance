// UI copy is injected, never inlined — check-ui-strings forbids Hangul here and
// this lane must not edit ko.ts (serial wire-up applies the koManifest). The
// consumer passes ko.console.policycanvas; these English defaults keep the
// screen mountable + testable standalone. All aria-labels route through here.
//
// koManifest (new optional strings the serial wire-up should add to
// ko.console.policycanvas): `conditionFields` and everything under `wire`.
// Label maps are keyed by API values and fall back to the raw key, so new
// backend actions/statuses render honestly before their labels land.

import type { PolicyEffect, SimulationReason } from "./types";

export interface PolicyCanvasWireStrings {
  loading: string;
  loadFailed: string;
  retry: string;
  emptyCatalog: string;
  newPolicyHint: string;
  validate: string;
  validationOk: string;
  validationErrorsLabel: string;
  reviewApprove: string;
  reviewReject: string;
  /** review_status → chip label (draft/review_pending/rejected/approved_for_promotion). */
  reviewStatus: Partial<Record<string, string>>;
  /** catalog status → chip label (enforced/shadow/draft/review_pending/rejected/retired). */
  catalogStatus: Partial<Record<string, string>>;
  pendingRevBanner: string;
  startRevision: string;
  run: string;
  subjectUserId: string;
  subjectRoles: string;
  resourceOwner: string;
  resourceBranch: string;
  legalHold: string;
  simReason: string;
  simErrorsLabel: string;
  draftKeyLabel: string;
}

export interface PolicyCanvasStrings {
  title: string;
  addPolicy: string;
  catalogLabel: string;
  canvasLabel: string;
  configLabel: string;
  blocks: {
    principal: string;
    resource: string;
    action: string;
    effect: string;
  };
  any: string;
  principalFields: {
    role: string;
    department: string;
    grade: string;
    employment: string;
    tenureYears: string;
  };
  /** Flat id → label map for registry choices; unmapped ids render as-is. */
  choiceLabels: Record<string, string>;
  /** API action key → label; unmapped actions render the raw key. */
  actionLabels: Partial<Record<string, string>>;
  effectLabels: Record<PolicyEffect, string>;
  objectTypeLabel: string;
  categoryLabel: string;
  conditionLabel: string;
  status: {
    draft: string;
    active: (version: number) => string;
    pendingRev: (version: number) => string;
  };
  policyAria: (name: string) => string;
  newPolicyName: string;
  nameLabel: string;
  ruleLineLabel: string;
  nlRule: (rule: {
    who: string;
    what: string;
    actions: string;
    conditionCount: number;
    effect: PolicyEffect;
  }) => string;
  listSeparator: string;
  forbidWinsChip: string;
  denyDefaultChip: string;
  simulator: {
    label: string;
    principalLabel: string;
    actionLabel: string;
    allow: string;
    deny: string;
    reasons: Record<SimulationReason, string>;
    matchedPolicy: string;
    noMatchedPolicy: string;
    auditPreviewLabel: string;
    auditActor: string;
    auditAction: string;
    auditResource: string;
    auditDecision: string;
    auditPolicy: string;
  };
  saveDraft: string;
  draftSaved: string;
  pendingRev: {
    banner: (version: number) => string;
    keepCurrent: (version: number) => string;
    approve: string;
    approveRequested: string;
    withdraw: string;
  };
  samples: {
    policies: Record<string, string>;
    principals: Record<string, string>;
  };
  /** Condition attr key → label (resource_type/owner/branch/legal_hold/roles/clearance_keys). */
  conditionFields?: Partial<Record<string, string>>;
  /** Wired-surface copy (Phase C). Optional until the koManifest lands. */
  wire?: Partial<PolicyCanvasWireStrings>;
}

/** English defaults for the wired-surface copy (merged under `strings.wire`). */
export const DEFAULT_POLICYCANVAS_WIRE_STRINGS: PolicyCanvasWireStrings = {
  loading: "Loading policies…",
  loadFailed: "Could not load the policy catalog.",
  retry: "Retry",
  emptyCatalog: "No policies yet.",
  newPolicyHint: "Unsaved",
  validate: "Validate",
  validationOk: "Validation passed",
  validationErrorsLabel: "Validation errors",
  reviewApprove: "Approve revision",
  reviewReject: "Reject revision",
  reviewStatus: {
    draft: "Draft",
    review_pending: "Review pending",
    rejected: "Rejected",
    approved_for_promotion: "Approved for promotion",
  },
  catalogStatus: {
    enforced: "Enforced",
    shadow: "Shadow",
    draft: "Draft",
    review_pending: "Review pending",
    rejected: "Rejected",
    retired: "Retired",
  },
  pendingRevBanner: "Revision staged",
  startRevision: "Stage revision",
  run: "Run simulation",
  subjectUserId: "User id",
  subjectRoles: "Roles (comma-separated)",
  resourceOwner: "Owner",
  resourceBranch: "Branch",
  legalHold: "Legal hold",
  simReason: "Reason",
  simErrorsLabel: "Evaluation errors",
  draftKeyLabel: "Policy key",
};

export const DEFAULT_CONDITION_FIELD_LABELS: Partial<Record<string, string>> = {
  resource_type: "Resource type",
  owner: "Owner",
  branch: "Branch",
  legal_hold: "Legal hold",
  roles: "Roles",
  clearance_keys: "Clearance keys",
};

/** English fallback. Non-Hangul so check-ui-strings passes; wire-up overrides. */
export const DEFAULT_POLICYCANVAS_STRINGS: PolicyCanvasStrings = {
  title: "Policy canvas",
  addPolicy: "Add policy",
  catalogLabel: "Policy catalog",
  canvasLabel: "Policy blocks",
  configLabel: "Block settings",
  blocks: {
    principal: "Principal",
    resource: "Resource",
    action: "Action",
    effect: "Effect",
  },
  any: "Any",
  principalFields: {
    role: "Role",
    department: "Department",
    grade: "Grade",
    employment: "Employment",
    tenureYears: "Tenure (years)",
  },
  choiceLabels: {},
  actionLabels: {
    view: "View",
    edit: "Edit",
    read_field: "Read field",
  },
  effectLabels: {
    permit: "Permit",
    forbid: "Forbid",
  },
  objectTypeLabel: "Resource type",
  categoryLabel: "Category",
  conditionLabel: "Conditions",
  status: {
    draft: "Draft",
    active: (version) => `Active v${String(version)}`,
    pendingRev: (version) => `Revision pending v${String(version)}`,
  },
  policyAria: (name) => `Open policy ${name}`,
  newPolicyName: "New policy",
  nameLabel: "Policy name",
  ruleLineLabel: "Rule",
  nlRule: ({ who, what, actions, conditionCount, effect }) =>
    `${who} → ${what} · ${actions} ${effect === "permit" ? "permitted" : "forbidden"}${
      conditionCount > 0 ? ` (${String(conditionCount)} conditions)` : ""
    }`,
  listSeparator: " · ",
  forbidWinsChip: "Forbid wins",
  denyDefaultChip: "Deny by default",
  simulator: {
    label: "Simulator",
    principalLabel: "Sample principal",
    actionLabel: "Simulated action",
    allow: "Allow",
    deny: "Deny",
    reasons: {
      forbid: "Forbid policy matched",
      permit: "Permit policy matched",
      omission: "No policy matched",
    },
    matchedPolicy: "Matched policy",
    noMatchedPolicy: "None",
    auditPreviewLabel: "Audit preview",
    auditActor: "Actor",
    auditAction: "Action",
    auditResource: "Resource",
    auditDecision: "Decision",
    auditPolicy: "Policy",
  },
  saveDraft: "Save draft",
  draftSaved: "Draft saved",
  pendingRev: {
    banner: (version) => `Revision pending v${String(version)}`,
    keepCurrent: (version) => `Current v${String(version)} stays enforced`,
    approve: "Request apply approval",
    approveRequested: "Approval requested",
    withdraw: "Withdraw",
  },
  samples: {
    policies: {},
    principals: {},
  },
  conditionFields: DEFAULT_CONDITION_FIELD_LABELS,
  wire: DEFAULT_POLICYCANVAS_WIRE_STRINGS,
};
