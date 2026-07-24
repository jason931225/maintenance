// Pure display mapping for the CP-/RG-/FW- module surface. No React, no
// fetch — row/status/ledger shaping only, so it is unit-testable without a
// DOM and reusable from both the module-surface adapter and its tests.
// labelKey fields below are dotted ko.ts paths (resolved later by the shared
// resolveText() in ../modules/typeRegistry.ts), never pre-resolved text.
import type { ModuleChipTone, ModuleLedgerValue, ModuleLinkChipValue, ModuleRow, ModuleSourceValue, ModuleStatusValue } from "../modules/types";
import type {
  ComplianceCatalogItem,
  ComplianceFramework,
  ComplianceObjectKind,
  ComplianceRiskLevel,
  FrameworkStatus,
  ObligationStatus,
  RegulationImpactStatus,
} from "./types";

const NS = "console.modules.compliance";

export const COMPLIANCE_ACTIONS = {
  read: "compliance_obligation_read",
  manage: "compliance_obligation_manage",
  regulationRead: "compliance_regulation_read",
  frameworkRead: "compliance_framework_read",
  frameworkManage: "compliance_framework_manage",
  evidenceLink: "compliance_evidence_link",
  audit: "audit_log_read",
} as const;

const KIND_CHIP: Record<ComplianceObjectKind, { code: string; labelKey: string; tone: ModuleChipTone; policyAction: string }> = {
  obligation: { code: "CP", labelKey: `${NS}.kinds.obligation`, tone: "info", policyAction: COMPLIANCE_ACTIONS.read },
  regulation: { code: "RG", labelKey: `${NS}.kinds.regulation`, tone: "accent", policyAction: COMPLIANCE_ACTIONS.regulationRead },
  framework: { code: "FW", labelKey: `${NS}.kinds.framework`, tone: "purple", policyAction: COMPLIANCE_ACTIONS.frameworkRead },
};

/** §4-11 typed 구분 chip — the "source" column variant renders {code} as a badge. */
export function kindChip(kind: ComplianceObjectKind, id: string): ModuleSourceValue {
  const chip = KIND_CHIP[kind];
  return { labelKey: chip.labelKey, tone: chip.tone, kind, id, code: chip.code, policyAction: chip.policyAction };
}

// Status tone/label tables — one entry per REAL backend state (mirrors
// mnt_compliance_domain::{ObligationStatus,RegulationImpactStatus,FrameworkStatus}
// as_db_str values exactly; keep in sync with backend/crates/compliance/domain).
const OBLIGATION_STATUS: Record<ObligationStatus, { labelKey: string; tone: ModuleChipTone }> = {
  DRAFT: { labelKey: `${NS}.statuses.draft`, tone: "neutral" },
  ACTIVE: { labelKey: `${NS}.statuses.active`, tone: "ok" },
  WAIVED: { labelKey: `${NS}.statuses.waived`, tone: "warn" },
  SUPERSEDED: { labelKey: `${NS}.statuses.superseded`, tone: "info" },
  ARCHIVED: { labelKey: `${NS}.statuses.archived`, tone: "neutral" },
};

const REGULATION_STATUS: Record<RegulationImpactStatus, { labelKey: string; tone: ModuleChipTone }> = {
  DRAFT: { labelKey: `${NS}.statuses.draft`, tone: "neutral" },
  ACTIVE: { labelKey: `${NS}.statuses.active`, tone: "ok" },
  SUPERSEDED: { labelKey: `${NS}.statuses.superseded`, tone: "info" },
  ARCHIVED: { labelKey: `${NS}.statuses.archived`, tone: "neutral" },
};

const FRAMEWORK_STATUS: Record<FrameworkStatus, { labelKey: string; tone: ModuleChipTone }> = {
  DRAFT: { labelKey: `${NS}.statuses.draft`, tone: "neutral" },
  ACTIVE: { labelKey: `${NS}.statuses.active`, tone: "ok" },
  RETIRED: { labelKey: `${NS}.statuses.retired`, tone: "warn" },
  ARCHIVED: { labelKey: `${NS}.statuses.archived`, tone: "neutral" },
};

const RISK_TONE: Record<ComplianceRiskLevel, ModuleChipTone> = {
  INFO: "neutral",
  LOW: "info",
  MEDIUM: "warn",
  HIGH: "danger",
  CRITICAL: "purple",
};

export function riskChipTone(level: ComplianceRiskLevel): ModuleChipTone {
  return RISK_TONE[level];
}

/**
 * Legal next states for a REAL FSM status — mirrors
 * validate_{obligation,regulation,framework}_status_transition in
 * backend/crates/compliance/domain/src/lib.rs one-for-one. Pure lookup so a
 * backend transition-table change surfaces here as a one-line diff, not a
 * silent drift.
 */
export function nextStates(kind: ComplianceObjectKind, status: string): ModuleStatusValue[] {
  const edges: Record<ComplianceObjectKind, Record<string, string[]>> = {
    obligation: {
      DRAFT: ["ACTIVE", "ARCHIVED"],
      ACTIVE: ["WAIVED", "SUPERSEDED", "ARCHIVED"],
      WAIVED: ["ACTIVE", "ARCHIVED"],
      SUPERSEDED: ["ARCHIVED"],
      ARCHIVED: [],
    },
    regulation: {
      DRAFT: ["ACTIVE", "ARCHIVED"],
      ACTIVE: ["SUPERSEDED", "ARCHIVED"],
      SUPERSEDED: ["ARCHIVED"],
      ARCHIVED: [],
    },
    framework: {
      DRAFT: ["ACTIVE", "ARCHIVED"],
      ACTIVE: ["RETIRED", "ARCHIVED"],
      RETIRED: ["ARCHIVED"],
      ARCHIVED: [],
    },
  };
  const table = statusTable(kind);
  return (edges[kind][status] ?? []).map((target) => table[target] ?? { labelKey: target, tone: "neutral" });
}

/** Widened to `Record<string, …>` so an unrecognized status degrades to a
 * neutral raw chip instead of returning `undefined` (real backend statuses
 * are exhaustive today, but this stays safe if that ever drifts). */
function statusTable(kind: ComplianceObjectKind): Record<string, ModuleStatusValue> {
  if (kind === "obligation") return OBLIGATION_STATUS;
  if (kind === "regulation") return REGULATION_STATUS;
  return FRAMEWORK_STATUS;
}

function statusValue(kind: ComplianceObjectKind, status: string): ModuleStatusValue {
  return statusTable(kind)[status] ?? { labelKey: status, tone: "neutral" };
}

function present(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function auditChip(kind: ComplianceObjectKind, id: string): ModuleLinkChipValue {
  return { key: "auditTrail", labelKey: `${NS}.links.audit`, tone: "neutral", kind, id, policyAction: COMPLIANCE_ACTIONS.audit };
}

const EVIDENCE_TONE: Record<string, ModuleChipTone> = {
  ACCEPTED: "ok",
  PROPOSED: "warn",
  REJECTED: "danger",
  EXPIRED: "danger",
  RETRACTED: "danger",
};

const EVIDENCE_TONE_SEVERITY: Record<ModuleChipTone, number> = {
  neutral: 0,
  info: 1,
  ok: 2,
  warn: 3,
  danger: 4,
  accent: 1,
  purple: 4,
};

function evidenceToneFor(bindings: ComplianceFramework["controls"][number]["evidenceBindings"]): ModuleChipTone {
  return bindings.reduce<ModuleChipTone>((current, binding) => {
    const candidate = EVIDENCE_TONE[binding.status] ?? "neutral";
    return EVIDENCE_TONE_SEVERITY[candidate] > EVIDENCE_TONE_SEVERITY[current] ? candidate : current;
  }, "neutral");
}

/** FW- control→evidence coverage matrix, reusing the ledger detail variant. */
export function controlEvidenceLedger(framework: ComplianceFramework): ModuleLedgerValue {
  const accepted = framework.controls.filter((control) => control.evidenceBindings.some((binding) => binding.status === "ACCEPTED")).length;
  return {
    total: `${String(accepted)}/${String(framework.controls.length)}`,
    entries: framework.controls.map((control) => ({
      id: control.id,
      label: `${control.controlKey} · ${control.title}`,
      amount: control.evidenceBindings.length,
      meta: control.objective,
      tone: evidenceToneFor(control.evidenceBindings),
    })),
  };
}

function toRow(item: ComplianceCatalogItem): ModuleRow {
  const status = statusValue(item.kind, item.status);
  const next = nextStates(item.kind, item.status);
  const cells: ModuleRow["cells"] = {
    kind: KIND_CHIP[item.kind].code,
    title: item.title,
    updatedAt: item.updatedAt.slice(0, 10),
  };
  const detail: NonNullable<ModuleRow["detail"]> = {
    description: undefined,
    nextStates: next.length > 0 ? next.map((s) => s.labelKey).join(" · ") : `${NS}.detail.terminalState`,
  };
  const linkChips: ModuleLinkChipValue[] = [auditChip(item.kind, item.id)];

  if (item.kind === "obligation") {
    cells.risk = item.severity;
    cells.effectiveFrom = present(item.effectiveFrom);
    cells.owner = present(item.ownerName);
    detail.description = item.description;
    detail.obligationType = item.obligationType;
    detail.scopeKind = item.scopeKind;
    detail.reviewCadence = item.reviewCadence;
    detail.nextReviewOn = item.nextReviewOn;
  } else if (item.kind === "regulation") {
    cells.risk = item.riskLevel;
    cells.effectiveFrom = present(item.effectiveFrom);
    cells.owner = present(item.ownerName);
    detail.description = item.impactSummary;
    detail.jurisdiction = item.jurisdiction;
    detail.regulator = present(item.regulator);
    detail.citation = item.citation;
    detail.impactArea = item.impactArea;
    detail.reviewDueOn = present(item.reviewDueOn);
  } else {
    cells.effectiveFrom = present(item.effectiveFrom);
    cells.owner = present(item.ownerName);
    detail.description = `${item.frameworkKind} · v${item.versionLabel}`;
    detail.frameworkKind = item.frameworkKind;
    detail.versionLabel = item.versionLabel;
    detail.controlEvidenceMatrix = controlEvidenceLedger(item);
  }

  return {
    id: item.id,
    code: item.code,
    title: item.title,
    status,
    source: kindChip(item.kind, item.id),
    cells,
    detail,
    linkChips,
    sourceRecord: item,
  };
}

export function toRows(items: ComplianceCatalogItem[]): ModuleRow[] {
  return items.map(toRow);
}

const SEARCHABLE_CELL_KEYS = ["title", "risk", "owner"] as const;

export function filterRows(rows: ModuleRow[], query: string): ModuleRow[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return rows;
  return rows.filter((row) => {
    const haystack = [row.code, row.title, ...SEARCHABLE_CELL_KEYS.map((key) => row.cells[key])]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    return haystack.includes(trimmed);
  });
}

function needsAttention(item: ComplianceCatalogItem): boolean {
  if (item.kind === "obligation") return item.status === "WAIVED" || item.severity === "CRITICAL";
  if (item.kind === "regulation") return item.riskLevel === "CRITICAL";
  return false;
}

export function catalogStats(items: ComplianceCatalogItem[]): { active: number; attention: number; frameworks: number } {
  return {
    active: items.filter((item) => item.status === "ACTIVE").length,
    attention: items.filter(needsAttention).length,
    frameworks: items.filter((item): item is ComplianceFramework => item.kind === "framework").length,
  };
}
