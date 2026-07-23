// CP-/RG-/FW- module surface (ontology-coverage-matrix.md item 6: "zero web
// UI" for compliance obligation/regulation/framework FSMs). Registered into
// ../modules/moduleScreens.ts MOD_SCREENS so it renders through the shared
// GenericModuleScreen — same list/right-pin/policy-gate idiom as finance and
// asset (§4-18 reuse; no bespoke screen component).
import { readComplianceCatalog, readFrameworkDetail } from "./complianceApi";
import { catalogStats, COMPLIANCE_ACTIONS, filterRows, toRows } from "./complianceModel";
import type { ModuleDataAdapter, ModuleScreenConfig } from "../modules/types";
import type { ComplianceFramework } from "./types";

const NS = "console.modules.compliance";

function isFrameworkCatalogItem(item: unknown): item is ComplianceFramework {
  return typeof item === "object" && item !== null && (item as { kind?: unknown }).kind === "framework";
}


const complianceDataAdapter: ModuleDataAdapter = {
  async loadRows({ api, query, hasPolicy }) {
    if (!hasPolicy(COMPLIANCE_ACTIONS.read)) return { rows: [] };
    const items = await readComplianceCatalog(api, query, {
      obligations: hasPolicy(COMPLIANCE_ACTIONS.read),
      regulations: hasPolicy(COMPLIANCE_ACTIONS.regulationRead),
      frameworks: hasPolicy(COMPLIANCE_ACTIONS.frameworkRead),
    });
    const rows = filterRows(toRows(items), query);
    const stats = catalogStats(items);
    return {
      rows,
      stats: { active: stats.active, attention: stats.attention, frameworks: stats.frameworks },
      selectedRowId: rows[0]?.id,
    };
  },
  async loadDetail({ api, row }) {
    const item = row.sourceRecord;
    if (!isFrameworkCatalogItem(item)) return { row };
    const hydrated = await readFrameworkDetail(api, item);
    return { row: toRows([hydrated])[0] };
  },
};

export const complianceModuleScreen: ModuleScreenConfig = {
  id: "compliance",
  screen: "compliance",
  route: "/modules?screen=compliance",
  navLabelKey: `${NS}.nav`,
  titleKey: `${NS}.title`,
  objectNameKey: `${NS}.objectName`,
  objectKind: "compliance_catalog_item",
  typeKey: "compliance_catalog_item",
  codePrefix: "CP-",
  emptyMode: "live",
  policy: {
    read: COMPLIANCE_ACTIONS.read,
    audit: COMPLIANCE_ACTIONS.audit,
  },
  data: { list: "/api/v1/compliance/obligations" },
  dataAdapter: complianceDataAdapter,
  statbar: [
    { key: "active", labelKey: `${NS}.stats.active`, tone: "ok", source: "compliance catalog status=ACTIVE", requiresBackend: true },
    { key: "attention", labelKey: `${NS}.stats.attention`, tone: "danger", source: "compliance catalog WAIVED|CRITICAL", requiresBackend: true },
    { key: "frameworks", labelKey: `${NS}.stats.frameworks`, tone: "purple", source: "compliance catalog kind=framework", requiresBackend: true },
  ],
  search: {
    labelKey: `${NS}.search.label`,
    placeholderKey: `${NS}.search.placeholder`,
    fields: ["title", "risk", "owner"],
  },
  list: {
    keyboard: ["J", "K", "Enter"],
    sharedTrack: "complianceCatalogTrack",
    columns: [
      { key: "kind", labelKey: `${NS}.columns.kind`, variant: "source" },
      { key: "code", labelKey: `${NS}.columns.code`, variant: "mono" },
      { key: "title", labelKey: `${NS}.columns.title`, variant: "text" },
      { key: "status", labelKey: `${NS}.columns.status`, variant: "status" },
      { key: "risk", labelKey: `${NS}.columns.risk`, variant: "text" },
      { key: "owner", labelKey: `${NS}.columns.owner`, variant: "text" },
      { key: "effectiveFrom", labelKey: `${NS}.columns.effectiveFrom`, variant: "text" },
      { key: "updatedAt", labelKey: `${NS}.columns.updatedAt`, variant: "text" },
    ],
  },
  detail: {
    fields: [
      { key: "description", labelKey: `${NS}.detail.description`, variant: "text" },
      { key: "nextStates", labelKey: `${NS}.detail.nextStates`, variant: "text" },
      { key: "obligationType", labelKey: `${NS}.detail.obligationType`, variant: "text" },
      { key: "scopeKind", labelKey: `${NS}.detail.scopeKind`, variant: "text" },
      { key: "reviewCadence", labelKey: `${NS}.detail.reviewCadence`, variant: "text" },
      { key: "nextReviewOn", labelKey: `${NS}.detail.nextReviewOn`, variant: "text" },
      { key: "jurisdiction", labelKey: `${NS}.detail.jurisdiction`, variant: "text" },
      { key: "regulator", labelKey: `${NS}.detail.regulator`, variant: "text" },
      { key: "citation", labelKey: `${NS}.detail.citation`, variant: "text" },
      { key: "impactArea", labelKey: `${NS}.detail.impactArea`, variant: "text" },
      { key: "reviewDueOn", labelKey: `${NS}.detail.reviewDueOn`, variant: "text" },
      { key: "frameworkKind", labelKey: `${NS}.detail.frameworkKind`, variant: "text" },
      { key: "versionLabel", labelKey: `${NS}.detail.versionLabel`, variant: "text" },
      { key: "controlEvidenceMatrix", labelKey: `${NS}.detail.controlEvidenceMatrix`, variant: "ledger" },
    ],
    linkChips: [{ key: "auditTrail", labelKey: `${NS}.links.audit`, policyAction: COMPLIANCE_ACTIONS.audit, resourceKind: "compliance_catalog_item" }],
    actions: [],
  },
  rows: [],
};
