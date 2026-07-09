import type { components } from "@maintenance/api-client-ts";

import { ko } from "../../i18n/ko";
import { safeLabel } from "../../lib/utils";
import { workOrderCode } from "../composer/candidates";
import type { Tone } from "../composer/objectKinds";
import type { ModuleConfig, ModuleLane } from "./config";

/**
 * Two real ModuleConfigs proving the ONE generic ModuleScreen renders two
 * different domains with ZERO component changes (charter §3 P0.4 config-driven
 * proof). Both bind LIVE reads through the shared typed client:
 *   • work orders  → GET /api/v1/work-orders   (reference binding + lanes field)
 *   • support      → GET /api/v1/support/tickets (second config, same component)
 * Row actions execute REAL mutations (reject / transition).
 */

type WorkOrder = components["schemas"]["WorkOrderListItem"];
type WorkOrderStatus = components["schemas"]["WorkOrderStatus"];
type Priority = components["schemas"]["PriorityLevel"];
type Ticket = components["schemas"]["SupportTicketSummary"];
type TicketStatus = components["schemas"]["SupportTicketStatus"];

const PAGE = 100;

/**
 * DESIGN §4.7-1 "예외만 칩" — a list cell is a chip ONLY when its value is an
 * exception that needs attention; routine/neutral values render as plain text.
 * Exception tones are the attention/alarm family (warn, danger); everything
 * else (neutral, info, accent, ok, purple) is a routine state and stays plain.
 */
const EXCEPTION_TONES = new Set<Tone>(["warn", "danger"]);
const chipTone = (tone: Tone): Tone | undefined => (EXCEPTION_TONES.has(tone) ? tone : undefined);

/* ─────────────────────────────── work orders ──────────────────────────── */

const WO = ko.console.module.workOrder;

const WO_STATUS_TONE: Record<WorkOrderStatus, Tone> = {
  RECEIVED: "info",
  UNASSIGNED: "warn",
  ASSIGNED: "info",
  IN_PROGRESS: "accent",
  REPORT_SUBMITTED: "info",
  ADMIN_REVIEW: "info",
  FINAL_COMPLETED: "ok",
  REJECTED: "danger",
  ON_HOLD: "warn",
  DELAYED: "danger",
  TEMPORARY_ACTION: "warn",
  PART_WAITING: "warn",
  EQUIPMENT_IN_USE: "warn",
  REVISIT_REQUIRED: "warn",
  ARCHIVED: "neutral",
  CANCELLED: "neutral",
};

const PRIORITY_TONE: Record<Priority, Tone> = {
  P1: "danger",
  P2: "warn",
  P3: "info",
  OUTSOURCE: "purple",
  UNSET: "neutral",
};

const WO_ACTIVE = new Set<WorkOrderStatus>(["ASSIGNED", "IN_PROGRESS", "TEMPORARY_ACTION", "PART_WAITING", "EQUIPMENT_IN_USE", "REVISIT_REQUIRED", "ON_HOLD", "DELAYED"]);
const WO_REVIEW = new Set<WorkOrderStatus>(["REPORT_SUBMITTED", "ADMIN_REVIEW", "FINAL_COMPLETED"]);

function woLanes(rows: WorkOrder[]): ModuleLane[] {
  const lane = (id: string, label: string, tone: Tone, pick: (s: WorkOrderStatus) => boolean): ModuleLane => ({
    id,
    label,
    tone,
    cards: rows
      .filter((r) => pick(r.status))
      .map((r) => ({
        id: r.id,
        title: workOrderCode(r.request_no),
        sub: safeLabel(r.customer.name),
        tone: PRIORITY_TONE[r.priority],
      })),
  });
  return [
    lane("unassigned", WO.lane.unassigned, "warn", (s) => s === "UNASSIGNED" || s === "RECEIVED"),
    lane("active", WO.lane.active, "accent", (s) => WO_ACTIVE.has(s)),
    lane("review", WO.lane.review, "ok", (s) => WO_REVIEW.has(s)),
  ];
}

export const workOrderModuleConfig: ModuleConfig<WorkOrder> = {
  key: "workOrder",
  title: WO.title,
  rowId: (r) => r.id,
  rowTitle: (r) => workOrderCode(r.request_no),
  columns: [
    { key: "code", header: WO.col.code, width: 168, minWidth: 120, cell: (r) => ({ text: workOrderCode(r.request_no), mono: true }) },
    { key: "customer", header: WO.col.customer, width: 160, minWidth: 90, cell: (r) => ({ text: safeLabel(r.customer.name) }) },
    { key: "equipment", header: WO.col.equipment, width: 180, minWidth: 90, cell: (r) => ({ text: safeLabel(r.equipment.model, r.equipment.equipment_no) }) },
    { key: "status", header: WO.col.status, width: 108, minWidth: 72, cell: (r) => ({ text: WO.status[r.status], tone: chipTone(WO_STATUS_TONE[r.status]) }) },
    { key: "priority", header: WO.col.priority, width: 80, minWidth: 56, align: "end", cell: (r) => ({ text: WO.priority[r.priority], tone: chipTone(PRIORITY_TONE[r.priority]) }) },
  ],
  statbar: (rows) => [
    { key: "total", label: WO.stat.total, value: String(rows.length) },
    { key: "inProgress", label: WO.stat.inProgress, value: String(rows.filter((r) => r.status === "IN_PROGRESS").length), tone: "accent" },
    { key: "unassigned", label: WO.stat.unassigned, value: String(rows.filter((r) => r.status === "UNASSIGNED").length), tone: "warn" },
    { key: "p1", label: WO.stat.p1, value: String(rows.filter((r) => r.priority === "P1").length), tone: "danger" },
  ],
  search: (r) => [workOrderCode(r.request_no), r.customer.name, r.site.name, r.equipment.model, r.equipment.equipment_no, WO.status[r.status]].map((v) => v?.toLowerCase() ?? "").join("\n"),
  detail: {
    kv: (r) => [
      { key: "requestNo", label: WO.kv.requestNo, value: workOrderCode(r.request_no) },
      { key: "customer", label: WO.kv.customer, value: safeLabel(r.customer.name) },
      { key: "site", label: WO.kv.site, value: safeLabel(r.site.name) },
      { key: "equipment", label: WO.kv.equipment, value: safeLabel(r.equipment.model, r.equipment.equipment_no) },
      { key: "status", label: WO.kv.status, value: WO.status[r.status] },
      { key: "priority", label: WO.kv.priority, value: WO.priority[r.priority] },
    ],
    links: (r) => [{ code: workOrderCode(r.request_no) }],
    actions: (r) => [
      {
        key: "reject",
        label: WO.reject,
        policy: "work_order.reject",
        tone: "danger",
        run: async (row, api) => {
          const res = await api.POST("/api/v1/work-orders/{workOrderId}/reject", {
            params: { path: { workOrderId: row.id } },
            body: { memo: WO.rejectMemo },
          });
          if (res.error || !res.response.ok) throw new Error("reject failed");
          return `${workOrderCode(r.request_no)} ${WO.reject}`;
        },
      },
    ],
  },
  primaryAction: { key: "compose", label: WO.compose, policy: "work_order.create" },
  field: { kind: "lanes", lanes: woLanes },
  load: async (api) => {
    const res = await api.GET("/api/v1/work-orders", { params: { query: { limit: PAGE } } });
    if (res.error || !res.response.ok) throw new Error("work-order load failed");
    return res.data.items;
  },
};

/* ─────────────────────────────── support ──────────────────────────────── */

const SP = ko.console.module.support;

const TICKET_STATUS_TONE: Record<TicketStatus, Tone> = {
  OPEN: "warn",
  IN_PROGRESS: "accent",
  ON_HOLD: "info",
  RESOLVED: "ok",
  CLOSED: "neutral",
};

const TICKET_PRIORITY_TONE: Record<components["schemas"]["SupportTicketPriority"], Tone> = {
  LOW: "neutral",
  MEDIUM: "info",
  HIGH: "warn",
  URGENT: "danger",
};

export const supportTicketModuleConfig: ModuleConfig<Ticket> = {
  key: "support",
  title: SP.title,
  rowId: (r) => r.id,
  rowTitle: (r) => safeLabel(r.title),
  columns: [
    { key: "title", header: SP.col.title, width: 240, minWidth: 120, cell: (r) => ({ text: safeLabel(r.title) }) },
    { key: "requester", header: SP.col.requester, width: 120, minWidth: 80, cell: (r) => ({ text: safeLabel(r.requester_name) }) },
    { key: "category", header: SP.col.category, width: 120, minWidth: 80, cell: (r) => ({ text: SP.category[r.category] }) },
    { key: "status", header: SP.col.status, width: 96, minWidth: 64, cell: (r) => ({ text: SP.status[r.status], tone: chipTone(TICKET_STATUS_TONE[r.status]) }) },
    { key: "priority", header: SP.col.priority, width: 80, minWidth: 56, align: "end", cell: (r) => ({ text: SP.priority[r.priority], tone: chipTone(TICKET_PRIORITY_TONE[r.priority]) }) },
  ],
  statbar: (rows) => [
    { key: "total", label: SP.stat.total, value: String(rows.length) },
    { key: "open", label: SP.stat.open, value: String(rows.filter((r) => r.status === "OPEN").length), tone: "warn" },
    { key: "inProgress", label: SP.stat.inProgress, value: String(rows.filter((r) => r.status === "IN_PROGRESS").length), tone: "accent" },
    { key: "urgent", label: SP.stat.urgent, value: String(rows.filter((r) => r.priority === "URGENT").length), tone: "danger" },
  ],
  search: (r) => [r.title, r.requester_name, SP.category[r.category], SP.status[r.status]].map((v) => v?.toLowerCase() ?? "").join("\n"),
  detail: {
    kv: (r) => [
      { key: "title", label: SP.kv.title, value: safeLabel(r.title) },
      { key: "requester", label: SP.kv.requester, value: safeLabel(r.requester_name) },
      { key: "assignee", label: SP.kv.assignee, value: safeLabel(r.assignee_name) },
      { key: "category", label: SP.kv.category, value: SP.category[r.category] },
      { key: "origin", label: SP.kv.origin, value: SP.origin[r.origin] },
      { key: "status", label: SP.kv.status, value: SP.status[r.status] },
      { key: "priority", label: SP.kv.priority, value: SP.priority[r.priority] },
    ],
    // Support tickets carry no issued object code (UUID-keyed); no link chips.
    links: () => [],
    actions: (r) => [
      {
        key: "resolve",
        label: SP.resolve,
        policy: "support.transition",
        tone: "ok",
        run: async (row, api) => {
          const res = await api.POST("/api/v1/support/tickets/{id}/transition", {
            params: { path: { id: row.id } },
            body: { to_status: "RESOLVED" },
          });
          if (res.error || !res.response.ok) throw new Error("transition failed");
          return `${safeLabel(r.title)} ${SP.resolve}`;
        },
      },
    ],
  },
  primaryAction: { key: "compose", label: SP.compose, policy: "support.create" },
  load: async (api) => {
    const res = await api.GET("/api/v1/support/tickets", { params: { query: { limit: PAGE } } });
    if (res.error || !res.response.ok) throw new Error("support load failed");
    return res.data.items;
  },
};

export type { WorkOrder, Ticket };
