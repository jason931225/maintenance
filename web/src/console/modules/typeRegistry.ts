// §18 ontology-registry mirror (be-ontology-engine-arch.md §2) — the single
// frontend source module surfaces consume for field / label / choice / link /
// action schema. Object type = schema, property = column, link type =
// relationship, action type = the verb, analytic = derived property.
// wire-pending: Phase C → GET /api/v1/ontology/object-types (arch §2 REST);
// this constant becomes the fetch result, the shapes already line up.
import { ko } from "../../i18n/ko";
import type { ObjectCardDescriptor, ObjectCardProperty } from "../objectcard";
import type {
  ModuleChipTone,
  ModuleColumnVariant,
  ModuleDetailFieldVariant,
  ModuleRow,
  ModuleStatusValue,
} from "./types";

/** Resolve a dotted ko key; unknown keys fall back to the key literal. */
export function resolveText(key: string): string {
  const value = key.split(".").reduce<unknown>((cursor, part) => {
    if (cursor && typeof cursor === "object") {
      return (cursor as Record<string, unknown>)[part];
    }
    return undefined;
  }, ko);
  return typeof value === "string" ? value : key;
}

/** Choice sub-entity ({id,name,…} — arch §2: choices are IDed, not bare strings). */
export interface OntChoice {
  id: string;
  nameKey: string;
  tone: ModuleChipTone;
}

interface OntPropertyBase {
  /** ont_property_defs.key */
  id: string;
  /** Registry-supplied display name (ko key). */
  nameKey: string;
  required?: boolean;
  /** ≤1 property policy per prop — deny-by-omission read gate (arch §5b). */
  inPropertyPolicy?: boolean;
}

/**
 * Field schema — discriminated union {id,name,type,config} (arch §2 / §3c).
 * The tag set grows server-side with zero migration; readers must degrade to
 * plain text on tags they do not know and never crash.
 */
export type OntProperty =
  | (OntPropertyBase & { type: "choice"; config: { choices: OntChoice[] } })
  | (OntPropertyBase & { type: "currency"; config: { unit: "KRW" } })
  | (OntPropertyBase & {
      type: "code" | "text" | "user" | "date" | "datetime" | "link" | "timeline" | "graph" | "ledger";
      config?: undefined;
    });

/** ont_link_types row: [rel, to, cardinality, rev]. */
export interface OntLinkType {
  rel: string;
  nameKey: string;
  /** Target object-type stable key. */
  to: string;
  cardinality: "one_one" | "one_many" | "many_many";
  /** Reverse rel stable key. */
  rev?: string;
}

/** ont_action_types row (PBAC-gated verb — deny-by-omission). */
export interface OntActionType {
  key: string;
  nameKey: string;
  policyAction: string;
  requiresReason?: boolean;
}

/** ont_analytics row — derived property (display mirror of formula). */
export interface OntAnalytic {
  key: string;
  nameKey: string;
  formula: string;
  resultType: string;
}

export interface OntObjectType {
  /** ont_object_types.stable_key */
  key: string;
  /** OT- code — type chip / drag token. */
  code: string;
  nameKey: string;
  /** Instance code prefix (VC- / FL- / …). */
  codePrefix: string;
  propSchema: OntProperty[];
  linkTypes: OntLinkType[];
  actions: OntActionType[];
  analytics: OntAnalytic[];
}

const F = "console.modules.finance";
const A = "console.modules.asset";
const X = "console.modules.types";

const financeStatusChoices: OntChoice[] = [
  { id: "draft", nameKey: `${F}.statuses.draft`, tone: "neutral" },
  { id: "review", nameKey: `${F}.statuses.review`, tone: "warn" },
  { id: "active", nameKey: `${F}.statuses.active`, tone: "ok" },
  { id: "posted", nameKey: `${F}.statuses.posted`, tone: "ok" },
  { id: "revision", nameKey: `${F}.statuses.revision`, tone: "info" },
  { id: "archived", nameKey: `${F}.statuses.archived`, tone: "neutral" },
  { id: "disposed", nameKey: `${F}.statuses.disposed`, tone: "danger" },
  { id: "invalid", nameKey: `${F}.statuses.invalid`, tone: "danger" },
];

const equipmentStatusChoices: OntChoice[] = [
  { id: "rented", nameKey: `${A}.statuses.rented`, tone: "ok" },
  { id: "spare", nameKey: `${A}.statuses.spare`, tone: "info" },
  { id: "disposed", nameKey: `${A}.statuses.disposed`, tone: "neutral" },
  { id: "replacement", nameKey: `${A}.statuses.replacement`, tone: "warn" },
  { id: "sold", nameKey: `${A}.statuses.sold`, tone: "purple" },
];

export const ONT_TYPES: Readonly<Record<string, OntObjectType>> = {
  finance_voucher: {
    key: "finance_voucher",
    code: "OT-FINANCE",
    nameKey: `${F}.objectName`,
    codePrefix: "VC-",
    propSchema: [
      { id: "code", nameKey: `${F}.columns.code`, type: "code", required: true },
      { id: "status", nameKey: `${F}.columns.status`, type: "choice", config: { choices: financeStatusChoices } },
      { id: "source", nameKey: `${F}.columns.source`, type: "link" },
      { id: "title", nameKey: `${F}.columns.title`, type: "text", required: true },
      { id: "amount", nameKey: `${F}.columns.amount`, type: "currency", config: { unit: "KRW" } },
      { id: "gl", nameKey: `${F}.columns.gl`, type: "text" },
      { id: "links", nameKey: `${F}.columns.links`, type: "link" },
      { id: "postedAt", nameKey: `${F}.columns.postedAt`, type: "datetime" },
      { id: "lifecyclePhase", nameKey: `${F}.detail.lifecycle`, type: "text" },
      { id: "lifecycleVersion", nameKey: `${F}.detail.version`, type: "text" },
      { id: "postingStatus", nameKey: `${F}.detail.postingStatus`, type: "text" },
      { id: "period", nameKey: `${F}.detail.period`, type: "text" },
      { id: "voucherDate", nameKey: `${F}.detail.voucherDate`, type: "date" },
      { id: "totalDebitWon", nameKey: `${F}.detail.totalDebit`, type: "currency", config: { unit: "KRW" } },
      { id: "totalCreditWon", nameKey: `${F}.detail.totalCredit`, type: "currency", config: { unit: "KRW" } },
      { id: "sourceKind", nameKey: `${F}.detail.sourceKind`, type: "text" },
      { id: "sourceCode", nameKey: `${F}.detail.sourceCode`, type: "code" },
      { id: "glAccountSummary", nameKey: `${F}.detail.glAccountSummary`, type: "text" },
      { id: "orgScope", nameKey: `${F}.detail.orgScope`, type: "text" },
      { id: "branchScope", nameKey: `${F}.detail.branchScope`, type: "text" },
      { id: "createdBy", nameKey: `${F}.detail.createdBy`, type: "user" },
      { id: "auditTraceId", nameKey: `${F}.detail.auditTrace`, type: "code" },
    ],
    linkTypes: [
      { rel: "voucher_source", nameKey: `${F}.links.approval`, to: "approval", cardinality: "one_one", rev: "approval_voucher" },
      { rel: "voucher_cost", nameKey: `${F}.links.costLedger`, to: "equipment", cardinality: "one_many", rev: "equipment_cost" },
    ],
    actions: [
      { key: "createVoucher", nameKey: `${F}.actions.createVoucher`, policyAction: "finance_voucher_create" },
      { key: "postVoucher", nameKey: `${F}.actions.postVoucher`, policyAction: "finance_voucher_post" },
    ],
    analytics: [
      { key: "balance", nameKey: `${X}.finance.analytics.balance`, formula: "totalDebitWon - totalCreditWon", resultType: "currency" },
    ],
  },
  equipment: {
    key: "equipment",
    code: "OT-EQUIPMENT",
    nameKey: `${A}.objectName`,
    codePrefix: "FL-",
    propSchema: [
      { id: "code", nameKey: `${A}.columns.code`, type: "code", required: true },
      { id: "managementNo", nameKey: `${A}.columns.managementNo`, type: "code" },
      { id: "status", nameKey: `${A}.columns.status`, type: "choice", config: { choices: equipmentStatusChoices } },
      { id: "model", nameKey: `${A}.columns.model`, type: "text" },
      { id: "maker", nameKey: `${A}.columns.maker`, type: "text" },
      { id: "customerSite", nameKey: `${A}.columns.customerSite`, type: "text" },
      { id: "owner", nameKey: `${A}.columns.owner`, type: "text" },
      { id: "links", nameKey: `${A}.columns.links`, type: "link" },
      { id: "updatedAt", nameKey: `${A}.columns.updatedAt`, type: "datetime" },
      { id: "specification", nameKey: `${A}.detail.specification`, type: "text" },
      { id: "tonText", nameKey: `${A}.detail.tonText`, type: "text" },
      { id: "customerName", nameKey: `${A}.detail.customerName`, type: "text" },
      { id: "siteName", nameKey: `${A}.detail.siteName`, type: "text" },
      { id: "assetOwner", nameKey: `${A}.detail.assetOwner`, type: "text" },
      { id: "vin", nameKey: `${A}.detail.vin`, type: "code" },
      { id: "version", nameKey: `${A}.detail.version`, type: "text" },
      { id: "rollback", nameKey: `${A}.detail.rollback`, type: "text" },
      { id: "timeline", nameKey: `${A}.detail.timeline`, type: "timeline" },
      { id: "graph", nameKey: `${A}.detail.graph`, type: "graph" },
      { id: "costLedger", nameKey: `${A}.detail.costLedger`, type: "ledger", inPropertyPolicy: true },
    ],
    linkTypes: [
      { rel: "equipment_cost", nameKey: `${A}.links.costLedger`, to: "finance_voucher", cardinality: "one_many", rev: "voucher_cost" },
      { rel: "equipment_ticket", nameKey: `${X}.ticket.links.equipment`, to: "support_ticket", cardinality: "one_many", rev: "ticket_equipment" },
    ],
    actions: [
      { key: "createEquipment", nameKey: `${A}.actions.createEquipment`, policyAction: "equipment_manage" },
      { key: "updateProfile", nameKey: `${A}.actions.updateProfile`, policyAction: "equipment_manage" },
      { key: "appendManualCost", nameKey: `${A}.actions.appendManualCost`, policyAction: "equipment_cost_ledger_write", requiresReason: true },
    ],
    analytics: [
      { key: "tco", nameKey: `${A}.links.lifecycleCost`, formula: "acquisition + maintenance + manual - residual", resultType: "currency" },
    ],
  },
  employee: {
    key: "employee",
    code: "OT-EMPLOYEE",
    nameKey: `${X}.employee.name`,
    codePrefix: "HR-",
    propSchema: [
      { id: "code", nameKey: `${X}.employee.props.code`, type: "code", required: true },
      { id: "name", nameKey: `${X}.employee.props.name`, type: "text", required: true, inPropertyPolicy: true },
      { id: "department", nameKey: `${X}.employee.props.department`, type: "text" },
      { id: "grade", nameKey: `${X}.employee.props.grade`, type: "text" },
      {
        id: "status",
        nameKey: `${X}.employee.props.status`,
        type: "choice",
        config: {
          choices: [
            { id: "active", nameKey: `${X}.employee.statuses.active`, tone: "ok" },
            { id: "leave", nameKey: `${X}.employee.statuses.leave`, tone: "warn" },
            { id: "retired", nameKey: `${X}.employee.statuses.retired`, tone: "neutral" },
          ],
        },
      },
      { id: "hiredAt", nameKey: `${X}.employee.props.hiredAt`, type: "date" },
    ],
    linkTypes: [
      { rel: "employee_drafts", nameKey: `${X}.employee.links.approvals`, to: "approval", cardinality: "one_many", rev: "approval_drafter" },
    ],
    actions: [
      { key: "update", nameKey: `${X}.employee.actions.update`, policyAction: "employee_manage", requiresReason: true },
    ],
    analytics: [],
  },
  approval: {
    key: "approval",
    code: "OT-APPROVAL",
    nameKey: `${X}.approval.name`,
    codePrefix: "AP-",
    propSchema: [
      { id: "code", nameKey: `${X}.approval.props.code`, type: "code", required: true },
      { id: "title", nameKey: `${X}.approval.props.title`, type: "text", required: true },
      { id: "drafter", nameKey: `${X}.approval.props.drafter`, type: "user" },
      {
        id: "status",
        nameKey: `${X}.approval.props.status`,
        type: "choice",
        config: {
          choices: [
            { id: "pending", nameKey: `${X}.approval.statuses.pending`, tone: "warn" },
            { id: "approved", nameKey: `${X}.approval.statuses.approved`, tone: "ok" },
            { id: "rejected", nameKey: `${X}.approval.statuses.rejected`, tone: "danger" },
          ],
        },
      },
      { id: "dueAt", nameKey: `${X}.approval.props.dueAt`, type: "datetime" },
    ],
    linkTypes: [
      { rel: "approval_voucher", nameKey: `${X}.approval.links.voucher`, to: "finance_voucher", cardinality: "one_one", rev: "voucher_source" },
    ],
    actions: [
      { key: "decide", nameKey: `${X}.approval.actions.decide`, policyAction: "workflow_task_decide", requiresReason: true },
    ],
    analytics: [],
  },
  support_ticket: {
    key: "support_ticket",
    code: "OT-TICKET",
    nameKey: `${X}.ticket.name`,
    codePrefix: "TK-",
    propSchema: [
      { id: "code", nameKey: `${X}.ticket.props.code`, type: "code", required: true },
      { id: "title", nameKey: `${X}.ticket.props.title`, type: "text", required: true },
      {
        id: "status",
        nameKey: `${X}.ticket.props.status`,
        type: "choice",
        config: {
          choices: [
            { id: "open", nameKey: `${X}.ticket.statuses.open`, tone: "info" },
            { id: "inProgress", nameKey: `${X}.ticket.statuses.inProgress`, tone: "warn" },
            { id: "resolved", nameKey: `${X}.ticket.statuses.resolved`, tone: "ok" },
          ],
        },
      },
      {
        id: "priority",
        nameKey: `${X}.ticket.props.priority`,
        type: "choice",
        config: {
          choices: [
            { id: "p1", nameKey: `${X}.ticket.priorities.p1`, tone: "danger" },
            { id: "p2", nameKey: `${X}.ticket.priorities.p2`, tone: "warn" },
            { id: "p3", nameKey: `${X}.ticket.priorities.p3`, tone: "neutral" },
          ],
        },
      },
      // §4-26: support-ticket target is an SLO (internal ops target → alert),
      // not an SLA (contractual → penalty); the label says SLO, never SLA.
      { id: "sloDueAt", nameKey: `${X}.ticket.props.sloDueAt`, type: "datetime" },
    ],
    linkTypes: [
      { rel: "ticket_equipment", nameKey: `${X}.ticket.links.equipment`, to: "equipment", cardinality: "one_many", rev: "equipment_ticket" },
    ],
    actions: [
      { key: "resolve", nameKey: `${X}.ticket.actions.resolve`, policyAction: "support_ticket_manage", requiresReason: true },
    ],
    analytics: [
      { key: "sloRemaining", nameKey: `${X}.ticket.analytics.sloRemaining`, formula: "sloDueAt - now", resultType: "duration" },
    ],
  },
};

export function getObjectType(key: string | undefined): OntObjectType | undefined {
  return key ? ONT_TYPES[key] : undefined;
}

export function getProperty(type: OntObjectType | undefined, propId: string): OntProperty | undefined {
  return type?.propSchema.find((prop) => prop.id === propId);
}

export function propChoices(prop: OntProperty | undefined): OntChoice[] {
  return prop?.type === "choice" ? prop.config.choices : [];
}

/** Choice value → status chip; unknown values degrade to a neutral raw chip. */
export function choiceStatus(typeKey: string, propId: string, value: string): ModuleStatusValue {
  const choice = propChoices(getProperty(getObjectType(typeKey), propId)).find((entry) => entry.id === value);
  return choice ? { labelKey: choice.nameKey, tone: choice.tone } : { labelKey: value, tone: "neutral" };
}

/** Derive the list-column render variant from the field type; unknown → text. */
export function columnVariantFor(prop: OntProperty | undefined): ModuleColumnVariant {
  switch (prop?.type) {
    case "code":
      return "mono";
    case "choice":
      return "status";
    case "link":
      return "linkChips";
    default:
      return "text";
  }
}

/** Derive the detail-field render variant from the field type; unknown → text. */
export function detailVariantFor(prop: OntProperty | undefined): ModuleDetailFieldVariant {
  switch (prop?.type) {
    case "code":
      return "mono";
    case "timeline":
    case "graph":
    case "ledger":
      return prop.type;
    default:
      return "text";
  }
}

/** The object TYPE itself as an ObjectCard — the surface↔type round-trip. */
export function typeCardDescriptor(type: OntObjectType): ObjectCardDescriptor {
  const schemaProps: ObjectCardProperty[] = type.propSchema.map((prop) => ({
    key: prop.id,
    title: resolveText(prop.nameKey),
    type: prop.type,
    value:
      prop.type === "choice"
        ? prop.config.choices.map((choice) => resolveText(choice.nameKey)).join(" · ")
        : prop.type,
    required: prop.required,
    inPropertyPolicy: prop.inPropertyPolicy,
  }));
  const analyticProps: ObjectCardProperty[] = type.analytics.map((analytic) => ({
    key: analytic.key,
    title: resolveText(analytic.nameKey),
    type: "analytic",
    value: analytic.formula,
  }));
  return {
    id: `object-type:${type.key}`,
    code: type.code,
    title: resolveText(type.nameKey),
    objectType: { key: "object_type", title: resolveText("console.modules.common.typeObjectName") },
    // Registry lifecycle is "published" (arch §3a); shown as the active card state.
    lifecycleState: "active",
    schemaVersion: 1,
    properties: [...schemaProps, ...analyticProps],
    relations: type.linkTypes.map((link) => ({
      linkId: link.rel,
      linkType: resolveText(link.nameKey),
      direction: "to" as const,
      cardinality: link.cardinality,
      code: getObjectType(link.to)?.code ?? link.to,
      title: resolveText(getObjectType(link.to)?.nameKey ?? link.to),
    })),
    lifecycle: [],
    history: [],
    actions: type.actions.map((action) => ({
      key: action.key,
      title: resolveText(action.nameKey),
      requiresReason: action.requiresReason,
    })),
  };
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/**
 * A module row as an ObjectCard payload (§4.7-3 right-pin open gesture).
 * Absent properties are omitted, never faked.
 * wire-pending: Phase C → GET /api/v1/ontology/instances/{id} replaces this
 * snapshot (real lifecycle_state, hash-verified history, executable actions).
 */
export function rowCardDescriptor(type: OntObjectType | undefined, row: ModuleRow): ObjectCardDescriptor {
  const properties: ObjectCardProperty[] = [];
  for (const prop of type?.propSchema ?? []) {
    const value =
      prop.id === "code"
        ? row.code
        : scalar(row.cells[prop.id]) ??
          scalar(row.detail?.[prop.id]) ??
          (prop.id === "status" && row.status ? resolveText(row.status.labelKey) : undefined);
    if (value === undefined) continue;
    properties.push({
      key: prop.id,
      title: resolveText(prop.nameKey),
      type: prop.type,
      value,
      required: prop.required,
      inPropertyPolicy: prop.inPropertyPolicy,
    });
  }
  return {
    id: row.id,
    code: row.code,
    title: row.title ?? row.code,
    objectType: {
      key: type?.key ?? "object",
      title: resolveText(type?.nameKey ?? "console.modules.common.typeObjectName"),
    },
    lifecycleState: "active",
    properties,
    relations: (row.linkChips ?? []).map((chip) => ({
      linkId: chip.key,
      linkType: resolveText(chip.labelKey),
      direction: "to" as const,
      cardinality: "one_many" as const,
      code: chip.code ?? chip.id,
      title: resolveText(chip.labelKey),
    })),
    lifecycle: [],
    history: [],
    // ponytail: module surface owns row actions today; card actions arrive
    // with the instances API (see wire-pending above).
    actions: [],
  };
}
