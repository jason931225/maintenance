import type {
  AssetLifecycleCostSummary,
  CostLedgerEntrySummary,
  EquipmentGraphEdge,
  EquipmentGraphNode,
  EquipmentLifecycleEvent,
  EquipmentListItem,
  EquipmentTimelineGraph,
  ObjectActionCatalogResponse,
} from "../../api/types";
import { createElement } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { complianceModuleScreen } from "../compliance";
import { registeredObjectType } from "../ontology/typeRegistrySource";
import { VoucherComposeForm } from "../finance/VoucherComposeForm";
import { FINANCE_MODULE_ACTIONS, makeFinanceDataAdapter } from "../finance/financeModel";
import { choiceStatus, getObjectType } from "./typeRegistry";
import type {
  ModuleChipTone,
  ModuleDataAdapter,
  ModuleGraphValue,
  ModuleLedgerValue,
  ModuleLinkChipValue,
  ModuleRow,
  ModuleScreenConfig,
  ModuleStatValue,
  ModuleTimelineValue,
} from "./types";

// Re-exported for existing callers of the finance policy-action map; owned in
// financeModel.ts to avoid a config↔domain import cycle.
export { FINANCE_MODULE_ACTIONS };

export const ASSET_MODULE_ACTIONS = {
  read: "work_order_read_all",
  manage: "equipment_manage",
  costRead: "equipment_cost_ledger_read",
  costWrite: "equipment_cost_ledger_write",
  graph: "object.view",
  audit: "audit_log_read",
} as const;

const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short" });

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function joinPresent(parts: Array<string | null | undefined>): string | undefined {
  const values = parts.map(present).filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" / ") : undefined;
}

function formatDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.format(date);
}

function formatCurrency(value: number | null | undefined): ModuleStatValue | undefined {
  return typeof value === "number" ? currencyFormatter.format(value) : undefined;
}

function equipmentRow(item: EquipmentListItem): ModuleRow {
  const customerSite = joinPresent([item.customer_name, item.site_name]);
  return {
    id: item.equipment_id,
    code: item.equipment_no,
    title: present(item.model),
    // Status label/tone come from the registry choice schema (ONT_TYPES).
    status: choiceStatus("equipment", "status", item.status),
    cells: {
      managementNo: present(item.management_no),
      model: present(item.model),
      maker: present(item.maker),
      customerSite,
      owner: present(item.asset_owner),
      updatedAt: formatDate(item.updated_at) ?? item.updated_at,
    },
    detail: {
      code: item.equipment_no,
      managementNo: present(item.management_no),
      model: present(item.model),
      maker: present(item.maker),
      specification: item.specification,
      tonText: item.ton_text,
      customerName: item.customer_name,
      siteName: item.site_name,
      assetOwner: present(item.asset_owner),
      vin: present(item.vin),
      updatedAt: formatDate(item.updated_at) ?? item.updated_at,
      version: undefined,
      rollback: undefined,
      timeline: { events: [] },
      graph: { nodes: [], edges: [] },
      costLedger: { entries: [] },
    },
    linkChips: [],
    actions: [],
  };
}

function timelineValue(events: EquipmentLifecycleEvent[]): ModuleTimelineValue {
  return {
    events: events.map((event) => ({
      id: event.id,
      label: event.label,
      kind: event.kind,
      description: present(event.description),
      occurredAt: formatDate(event.occurred_at ?? event.event_date),
      href: present(event.href),
      tone: event.href ? "info" : "neutral",
    })),
  };
}

function graphValue(
  nodes: EquipmentGraphNode[] | undefined,
  edges: EquipmentGraphEdge[] | undefined,
): ModuleGraphValue {
  return {
    nodes: (nodes ?? []).map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.node_type,
      subtitle: present(node.subtitle),
      href: present(node.href),
      current: node.current,
    })),
    edges: (edges ?? []).map((edge) => ({
      id: `${edge.from}:${edge.kind}:${edge.to}`,
      label: edge.label,
    })),
  };
}

function ledgerValue(
  entries: CostLedgerEntrySummary[] | undefined,
  lifecycleCost: AssetLifecycleCostSummary | undefined,
  timelineGraph: EquipmentTimelineGraph | undefined,
): ModuleLedgerValue {
  return {
    total: formatCurrency(lifecycleCost?.tco_won ?? timelineGraph?.cost_ledger_total_won),
    entries: (entries ?? lifecycleCost?.timeline ?? []).map((entry) => ({
      id: entry.id,
      label: entry.memo || entry.id,
      amount: formatCurrency(entry.amount_won),
      meta: formatDate(entry.entry_at),
      sourceLabelKey: `console.modules.asset.costSources.${entry.source}`,
      tone: "neutral",
    })),
  };
}

function linkChip(
  key: string,
  labelKey: string,
  policyAction: string,
  id: string,
  code: string,
  tone: ModuleChipTone = "info",
  resourceKind = "equipment",
  href?: string,
): ModuleLinkChipValue {
  return {
    key,
    labelKey,
    tone,
    kind: resourceKind,
    id,
    code,
    policyAction,
    href,
  };
}

async function readTimeline(api: ConsoleApiClient, id: string) {
  const response = await api
    .GET("/api/v1/equipment/{id}/timeline-graph", { params: { path: { id } } })
    .catch(() => undefined);
  return response?.data;
}

async function readCostLedger(api: ConsoleApiClient, id: string) {
  const response = await api
    .GET("/api/v1/financial/equipment/{equipmentId}/cost-ledger", { params: { path: { equipmentId: id } } })
    .catch(() => undefined);
  return response?.data;
}

async function readLifecycleCost(api: ConsoleApiClient, id: string) {
  const response = await api
    .GET("/api/v1/financial/equipment/{equipmentId}/lifecycle-cost", { params: { path: { equipmentId: id } } })
    .catch(() => undefined);
  return response?.data;
}

async function readActionCatalog(api: ConsoleApiClient, id: string) {
  const response = await api
    .GET("/api/v1/object-actions/catalog", {
      params: { query: { object_type: "equipment", object_id: id } },
    })
    .catch(() => undefined);
  return response?.data;
}

const assetDataAdapter: ModuleDataAdapter = {
  async loadRows({ api, query }) {
    const trimmed = query.trim();
    const response = await api.GET("/api/v1/equipment/list", {
      params: {
        query: {
          limit: 50,
          offset: 0,
          sort: "equipment_no",
          ...(trimmed ? { q: trimmed } : {}),
        },
      },
    });
    if (!response.data) throw new Error("equipment list response missing data");
    return {
      rows: response.data.items.map(equipmentRow),
      stats: { total: response.data.total },
      selectedRowId: response.data.items[0]?.equipment_id,
    };
  },

  async loadDetail({ api, row, hasPolicy }) {
    const detailResponse = await api
      .GET("/api/v1/equipment/{id}", { params: { path: { id: row.id } } })
      .catch(() => undefined);
    const baseRow = detailResponse?.data ? equipmentRow(detailResponse.data) : row;
    const canReadCost = hasPolicy(ASSET_MODULE_ACTIONS.costRead, { kind: "equipment", id: row.id });
    const canManage = hasPolicy(ASSET_MODULE_ACTIONS.manage, { kind: "equipment", id: row.id });
    const canViewGraph = hasPolicy(ASSET_MODULE_ACTIONS.graph, { kind: "equipment", id: row.id });
    const [timelineGraph, costLedger, lifecycleCost, actionCatalog] = await Promise.all([
      readTimeline(api, row.id),
      canReadCost ? readCostLedger(api, row.id) : Promise.resolve(undefined),
      canReadCost ? readLifecycleCost(api, row.id) : Promise.resolve(undefined),
      canManage ? readActionCatalog(api, row.id) : Promise.resolve<ObjectActionCatalogResponse | undefined>(undefined),
    ]);
    const graph = canViewGraph
      ? graphValue(timelineGraph?.graph.nodes, timelineGraph?.graph.edges)
      : { nodes: [], edges: [] };
    const ledger = ledgerValue(costLedger, lifecycleCost, timelineGraph);
    const chips: ModuleLinkChipValue[] = [];
    if (timelineGraph) {
      chips.push(
        linkChip(
          "timeline",
          "console.modules.asset.links.timeline",
          ASSET_MODULE_ACTIONS.read,
          row.id,
          String(timelineGraph.lifecycle_events.length),
        ),
      );
      if (canViewGraph) {
        timelineGraph.graph.nodes
          .filter((node) => !node.current && Boolean(present(node.href)))
          .forEach((node) => {
            chips.push(
              linkChip(
                `graph:${node.id}`,
                "console.modules.asset.links.graph",
                ASSET_MODULE_ACTIONS.graph,
                node.id,
                node.label,
                "info",
                node.node_type,
                present(node.href),
              ),
            );
          });
      }
    }
    if (canReadCost && costLedger) {
      chips.push(
        linkChip(
          "costLedger",
          "console.modules.asset.links.costLedger",
          ASSET_MODULE_ACTIONS.costRead,
          row.id,
          String(costLedger.length),
          "accent",
        ),
      );
    }
    if (canReadCost && lifecycleCost) {
      chips.push(
        linkChip(
          "lifecycleCost",
          "console.modules.asset.links.lifecycleCost",
          ASSET_MODULE_ACTIONS.costRead,
          row.id,
          String(formatCurrency(lifecycleCost.tco_won) ?? "0"),
          "accent",
        ),
      );
    }
    const hasUpdateProfile = actionCatalog?.actions.some(
      (action) => action.action_id === "equipment.update_profile",
    );
    return {
      row: {
        ...baseRow,
        detail: {
          ...baseRow.detail,
          timeline: timelineValue(timelineGraph?.lifecycle_events ?? []),
          graph,
          costLedger: ledger,
        },
        linkChips: chips,
        actions: hasUpdateProfile
          ? [
              {
                key: "updateProfile",
                labelKey: "console.modules.asset.actions.updateProfile",
                policyAction: ASSET_MODULE_ACTIONS.manage,
                resourceKind: "equipment",
                href: `/equipment/${row.id}`,
              },
            ]
          : [],
      },
      stats: {
        workOrders: timelineGraph?.work_order_count,
        costLedger: canReadCost ? formatCurrency(timelineGraph?.cost_ledger_total_won) : undefined,
      },
    };
  },
};

const financeDataAdapter = makeFinanceDataAdapter((context) => createElement(VoucherComposeForm, context));

export const financeModuleScreen: ModuleScreenConfig = {
  id: "finance",
  screen: "finance",
  route: "/modules",
  navLabelKey: "console.modules.finance.nav",
  titleKey: "console.modules.finance.title",
  objectNameKey: "console.modules.finance.objectName",
  objectKind: "finance_voucher",
  typeKey: "finance_voucher",
  codePrefix: "VC-",
  emptyMode: "live",
  emptyLiveHintKey: "console.modules.finance.emptyLiveHint",
  policy: FINANCE_MODULE_ACTIONS,
  dataAdapter: financeDataAdapter,
  data: {
    list: "/api/v1/finance/vouchers",
    detail: "/api/v1/finance/vouchers/{voucherId}",
    create: "/api/v1/finance/vouchers",
    post: "/api/v1/finance/vouchers/{voucherId}/post",
    reverse: "/api/v1/finance/vouchers/{voucherId}/reverse",
    lifecycle: "/api/v1/lifecycles/finance_voucher/{voucherId}",
    objectResolve: "/api/objects/{kind}/{id}",
    graph: "/api/objects/{kind}/{id}/graph",
    links: "/api/v1/object-links",
  },
  statbar: [
    {
      key: "review",
      labelKey: "console.modules.finance.stats.review",
      tone: "warn",
      source: "finance_voucher.lifecycle_phase in draft|review",
      requiresBackend: true,
    },
    {
      key: "posted",
      labelKey: "console.modules.finance.stats.posted",
      tone: "ok",
      source: "finance_voucher.posting_status=posted current_period",
      requiresBackend: true,
    },
    {
      key: "linked",
      labelKey: "console.modules.finance.stats.linked",
      tone: "info",
      source: "object_links source_kind=finance_voucher target_kind in DX|AP|PS|PayrollRun|purchase_request|contract",
      requiresBackend: true,
      policyAction: FINANCE_MODULE_ACTIONS.link,
    },
    {
      key: "exceptions",
      labelKey: "console.modules.finance.stats.exceptions",
      tone: "danger",
      source: "finance_voucher.validation_status in unbalanced|invalid_gl_account|source_missing",
      requiresBackend: true,
    },
  ],
  search: {
    labelKey: "console.modules.finance.search.label",
    placeholderKey: "console.modules.finance.search.placeholder",
    fields: [
      "code",
      "title",
      "memo",
      "status",
      "posting_status",
      "period",
      "source_code",
      "source_kind",
      "gl_account_code",
      "gl_account_name",
      "amount_won",
      "counterparty",
      "actor_name",
      "linked_object_codes",
    ],
    requiresRows: true,
  },
  list: {
    keyboard: ["J", "K", "Enter"],
    sharedTrack: "financeVoucherTrack",
    laneGroupBy: "status",
    // Labels/variants derive from ONT_TYPES.finance_voucher.propSchema; only
    // surface-specific overrides (source render, alignment) stay in config.
    columns: [
      { key: "code" },
      { key: "status" },
      { key: "source", variant: "source" },
      { key: "title" },
      { key: "amount", align: "end" },
      { key: "gl" },
      { key: "links" },
      { key: "postedAt" },
    ],
  },
  detail: {
    fields: [
      { key: "code" },
      { key: "title" },
      { key: "lifecyclePhase" },
      { key: "lifecycleVersion" },
      { key: "postingStatus" },
      { key: "period" },
      { key: "voucherDate" },
      // Detail wants "전기 시각" while the registry prop is the column label — override.
      { key: "postedAt", labelKey: "console.modules.finance.detail.postedAt" },
      { key: "documentFlow" },
      { key: "balanceCheck" },
      { key: "totalDebitWon" },
      { key: "totalCreditWon" },
      { key: "sourceKind" },
      { key: "sourceCode" },
      { key: "glAccountSummary" },
      { key: "orgScope" },
      { key: "branchScope" },
      { key: "createdBy" },
      { key: "auditTraceId" },
    ],
    linkChips: [
      { key: "lifecycle", labelKey: "console.modules.finance.links.lifecycle", policyAction: FINANCE_MODULE_ACTIONS.lifecycle, resourceKind: "finance_voucher" },
      { key: "objectGraph", labelKey: "console.modules.finance.links.graph", policyAction: FINANCE_MODULE_ACTIONS.graph, resourceKind: "finance_voucher" },
      { key: "auditTrail", labelKey: "console.modules.finance.links.audit", policyAction: FINANCE_MODULE_ACTIONS.audit, resourceKind: "finance_voucher" },
      { key: "sourceDx", labelKey: "console.modules.finance.links.dx", policyAction: "dx_ingest_read", resourceKind: "dx_ingest" },
      { key: "sourceAp", labelKey: "console.modules.finance.links.approval", policyAction: "workflow_task_read", resourceKind: "approval" },
      { key: "sourcePayroll", labelKey: "console.modules.finance.links.payroll", policyAction: "payroll_read", resourceKind: "payroll_run" },
      { key: "sourcePurchase", labelKey: "console.modules.finance.links.purchase", policyAction: "purchase_request_read", resourceKind: "purchase_request" },
      { key: "sourceContract", labelKey: "console.modules.finance.links.contract", policyAction: "contract_read", resourceKind: "contract" },
      { key: "glAccount", labelKey: "console.modules.finance.links.glAccount", policyAction: FINANCE_MODULE_ACTIONS.read, resourceKind: "gl_account" },
      { key: "costLedger", labelKey: "console.modules.finance.links.costLedger", policyAction: "equipment_cost_ledger_read", resourceKind: "cost_ledger" },
    ],
    // Real per-row actions (post/reverse, eligibility-gated) come from
    // financeDataAdapter.loadDetail's row.actions — same precedent as
    // assetModuleScreen. This static template is the no-adapter fallback.
    actions: [],
  },
  primaryAction: {
    key: "createVoucher",
    labelKey: "console.modules.finance.actions.createVoucher",
    policyAction: FINANCE_MODULE_ACTIONS.create,
    resourceKind: "finance_voucher",
  },
  rows: [],
};

export const assetModuleScreen: ModuleScreenConfig = {
  id: "asset",
  screen: "asset",
  route: "/modules?screen=asset",
  navLabelKey: "console.modules.asset.nav",
  titleKey: "console.modules.asset.title",
  objectNameKey: "console.modules.asset.objectName",
  objectKind: "equipment",
  typeKey: "equipment",
  codePrefix: "FL-",
  emptyMode: "live",
  policy: ASSET_MODULE_ACTIONS,
  data: {
    list: "/api/v1/equipment/list",
    detail: "/api/v1/equipment/{id}",
    update: "/api/v1/equipment/{id}",
    delete: "/api/v1/equipment/{id}",
    timeline: "/api/v1/equipment/{id}/timeline-graph",
    costLedger: "/api/v1/financial/equipment/{equipmentId}/cost-ledger",
    lifecycleCost: "/api/v1/financial/equipment/{equipmentId}/lifecycle-cost",
    manualCost: "/api/v1/financial/equipment/{equipmentId}/cost-ledger/manual",
    actionCatalog: "/api/v1/object-actions/catalog?object_type=equipment&object_id={id}",
    actionExecute: "/api/v1/object-actions/execute",
    objectResolve: "/api/objects/{kind}/{id}",
    graph: "/api/objects/{kind}/{id}/graph",
    links: "/api/v1/object-links",
    substitutions: "/api/v1/equipment-substitutions",
    ownershipTransfers: "/api/v1/equipment/{id}/ownership-transfer-requests",
    ownershipTransferDecision: "/api/v1/equipment/ownership-transfer-requests/{id}/decisions",
  },
  dataAdapter: assetDataAdapter,
  statbar: [
    {
      key: "total",
      labelKey: "console.modules.asset.stats.total",
      tone: "neutral",
      source: "EquipmentListPage.total",
      requiresBackend: true,
    },
    {
      key: "workOrders",
      labelKey: "console.modules.asset.stats.workOrders",
      tone: "info",
      source: "EquipmentTimelineGraph.work_order_count selected equipment",
      requiresBackend: true,
    },
    {
      key: "costLedger",
      labelKey: "console.modules.asset.stats.costLedger",
      tone: "accent",
      source: "EquipmentTimelineGraph.cost_ledger_total_won selected equipment",
      requiresBackend: true,
      policyAction: ASSET_MODULE_ACTIONS.costRead,
    },
  ],
  search: {
    labelKey: "console.modules.asset.search.label",
    placeholderKey: "console.modules.asset.search.placeholder",
    fields: [
      "equipment_no",
      "management_no",
      "model",
      "maker",
      "customer_name",
      "site_name",
      "vin",
      "asset_owner",
      "status",
      "specification",
      "ton_text",
    ],
  },
  list: {
    keyboard: ["J", "K", "Enter"],
    sharedTrack: "equipmentAssetTrack",
    laneGroupBy: "status",
    // Labels/variants derive from ONT_TYPES.equipment.propSchema.
    columns: [
      { key: "code" },
      { key: "managementNo" },
      { key: "status" },
      { key: "model" },
      { key: "maker" },
      { key: "customerSite" },
      { key: "owner" },
      { key: "links" },
      { key: "updatedAt" },
    ],
  },
  detail: {
    fields: [
      { key: "code" },
      { key: "managementNo" },
      { key: "model" },
      { key: "maker" },
      { key: "specification" },
      { key: "tonText" },
      { key: "customerName" },
      { key: "siteName" },
      { key: "assetOwner" },
      { key: "vin" },
      { key: "updatedAt" },
      { key: "version" },
      { key: "rollback" },
      { key: "timeline" },
      { key: "graph" },
      { key: "costLedger" },
    ],
    linkChips: [
      { key: "timeline", labelKey: "console.modules.asset.links.timeline", policyAction: ASSET_MODULE_ACTIONS.read, resourceKind: "equipment" },
      { key: "objectGraph", labelKey: "console.modules.asset.links.graph", policyAction: ASSET_MODULE_ACTIONS.graph, resourceKind: "equipment" },
      { key: "costLedger", labelKey: "console.modules.asset.links.costLedger", policyAction: ASSET_MODULE_ACTIONS.costRead, resourceKind: "cost_ledger" },
      { key: "lifecycleCost", labelKey: "console.modules.asset.links.lifecycleCost", policyAction: ASSET_MODULE_ACTIONS.costRead, resourceKind: "cost_ledger" },
      { key: "auditTrail", labelKey: "console.modules.asset.links.audit", policyAction: ASSET_MODULE_ACTIONS.audit, resourceKind: "equipment" },
    ],
    actions: [],
  },
  primaryAction: {
    key: "createEquipment",
    labelKey: "console.modules.asset.actions.createEquipment",
    policyAction: ASSET_MODULE_ACTIONS.manage,
    resourceKind: "equipment",
    href: "/equipment/manage",
  },
  rows: [],
};

export const MOD_SCREENS = {
  finance: financeModuleScreen,
  asset: assetModuleScreen,
  compliance: complianceModuleScreen,
} as const;

export type ModuleScreenId = keyof typeof MOD_SCREENS;

/**
 * A registered-but-not-hand-authored kind as a generic module surface: it opens
 * and renders (frame, stat strip, empty state) with NO config edit. Columns and
 * detail fields derive from the (generic) ONT_TYPES def; there is no list
 * endpoint for an arbitrary kind yet, so it stays blocked-until-backend (empty
 * state per §4-10, never fabricated rows). Read is gated by the generic
 * `object.view` action (deny-by-omission).
 * wire-pending: W1-be-ontology GET /api/v1/ontology/instances?type= for
 * arbitrary registered kinds → real rows + statbar counts.
 */
function genericModuleScreen(kind: string): ModuleScreenConfig {
  const type = getObjectType(kind);
  const registered = registeredObjectType(kind);
  const columns = (type?.propSchema ?? []).map((prop) => ({ key: prop.id }));
  return {
    id: kind,
    screen: kind,
    route: `/modules?screen=${kind}`,
    navLabelKey: type?.nameKey ?? kind,
    titleKey: type?.nameKey ?? kind,
    objectNameKey: type?.nameKey ?? kind,
    objectKind: kind,
    typeKey: type?.key,
    codePrefix: registered?.codePrefix ?? type?.codePrefix ?? "",
    emptyMode: "blocked-until-backend",
    blockedChipKey: "console.modules.generic.emptyBlockedChip",
    policy: { read: "object.view" },
    data: {},
    statbar: [
      {
        key: "instances",
        labelKey: "console.modules.generic.stats.instances",
        tone: "neutral",
        source: "object-types.active_count",
        requiresBackend: true,
      },
    ],
    list: {
      keyboard: ["J", "K", "Enter"],
      sharedTrack: `${kind}Track`,
      columns,
    },
    detail: {
      fields: (type?.propSchema ?? []).map((prop) => ({ key: prop.id })),
      linkChips: [],
      actions: [],
    },
    rows: [],
  };
}

/**
 * The hand-authored surface for a known nav id (finance/asset), else — when the
 * screen names a kind registered no-code via the Ontology Manager — a generic
 * surface derived from the registry. Unknown/unregistered → finance default.
 */
export function getModuleScreen(screen: string | null | undefined): ModuleScreenConfig {
  if (screen && Object.prototype.hasOwnProperty.call(MOD_SCREENS, screen)) {
    return MOD_SCREENS[screen as ModuleScreenId];
  }
  if (screen && registeredObjectType(screen)) {
    return genericModuleScreen(screen);
  }
  return financeModuleScreen;
}
