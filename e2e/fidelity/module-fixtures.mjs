/**
 * Rig-side fixtures for the P0.4 module-template build capture (capture.mjs
 * `--screen=module`). Node/Playwright can't import the TS `web/src/test/`
 * fixtures, so these plain payloads mirror the API response shape the two
 * ModuleConfigs read (`{ items: [...] }`). Rows deliberately span BOTH exception
 * statuses (chip) and routine/neutral ones (plain text) so the §4.7-1 "예외만 칩"
 * grammar is visible in the committed baseline.
 *
 * ponytail: only the fields the configs actually read are populated; add more
 * if a later config binds new columns.
 */

const eq = (model, no) => ({ id: `eq-${no}`, equipment_no: no, model, management_no: no, status: "임대", specification: "-", ton_text: "-" });
const cust = (name) => ({ id: `c-${name}`, name });
const site = (name) => ({ id: `s-${name}`, name });

export const workOrders = {
  items: [
    { id: "wo-1", request_no: "20260709-001", status: "UNASSIGNED", priority: "P1", customer: cust("한일냉장"), site: site("성산공장"), equipment: eq("D30S-9", "D-30-305"), assignments: [] },
    { id: "wo-2", request_no: "20260709-002", status: "RECEIVED", priority: "P2", customer: cust("Acme"), site: site("인천센터"), equipment: eq("B18X", "E-18-112"), assignments: [] },
    { id: "wo-3", request_no: "20260709-003", status: "IN_PROGRESS", priority: "P1", customer: cust("수도권냉장"), site: site("하남창고"), equipment: eq("F25", "F-25-220"), assignments: [] },
    { id: "wo-4", request_no: "20260709-004", status: "ASSIGNED", priority: "P3", customer: cust("동성물류"), site: site("김해허브"), equipment: eq("G12", "G-12-118"), assignments: [] },
    { id: "wo-5", request_no: "20260709-005", status: "REPORT_SUBMITTED", priority: "P2", customer: cust("남광"), site: site("창원1"), equipment: eq("H40", "H-40-401"), assignments: [] },
    { id: "wo-6", request_no: "20260709-006", status: "FINAL_COMPLETED", priority: "OUTSOURCE", customer: cust("대주"), site: site("양산"), equipment: eq("J22", "J-22-210"), assignments: [] },
  ],
};

const ticket = (id, title, status, priority, category, requester) => ({
  id,
  branch_id: "b-1",
  origin: "CUSTOMER",
  category,
  priority,
  status,
  title,
  requester_user_id: "u-1",
  requester_name: requester,
  assignee_user_id: "u-2",
  assignee_name: "운영 관리자",
  due_at: null,
  created_at: "2026-07-09T08:00:00Z",
  updated_at: "2026-07-09T09:00:00Z",
  resolved_at: null,
  closed_at: null,
});

export const supportTickets = {
  items: [
    ticket("t-1", "지게차 시동 불량 문의", "OPEN", "URGENT", "EQUIPMENT_INQUIRY", "홍길동"),
    ticket("t-2", "임대 계약 연장 요청", "IN_PROGRESS", "HIGH", "OPERATIONAL", "김성아"),
    ticket("t-3", "청구서 재발행 요청", "RESOLVED", "MEDIUM", "OTHER", "이종호"),
    ticket("t-4", "정기 점검 일정 확인", "CLOSED", "LOW", "OPERATIONAL", "박민수"),
  ],
};

export const equipmentId = "eq-900";
export const equipmentRow = {
  equipment_id: equipmentId,
  branch_id: "branch-main",
  equipment_no: "EQ-900",
  management_no: "MG-77",
  status: "rented",
  model: "ZX-9",
  maker: "MakerOne",
  specification: "3단 마스트",
  ton_text: "3.0t",
  customer_name: "고객 A",
  site_name: "서울 센터",
  asset_owner: "케이엔엘",
  vin: "VIN-900",
  updated_at: "2026-07-09T12:30:00Z",
};

export const equipmentList = {
  items: [equipmentRow],
  total: 1,
  limit: 50,
  offset: 0,
};

export const equipmentTimelineGraph = {
  equipment: equipmentRow,
  lifecycle_events: [
    {
      id: "evt-1",
      kind: "maintenance",
      label: "정비 완료",
      description: "정기 점검 완료",
      event_date: "2026-07-08",
      occurred_at: null,
      href: "/work-orders/wo-1",
    },
  ],
  graph: {
    nodes: [
      {
        id: "node-equipment",
        node_type: "equipment",
        label: "EQ-900",
        subtitle: "현재 장비",
        href: null,
        current: true,
      },
      {
        id: "node-customer",
        node_type: "customer",
        label: "고객 A",
        subtitle: "서울 센터",
        href: "/customers/customer-a",
        current: false,
      },
    ],
    edges: [{ from: "node-equipment", to: "node-customer", kind: "assigned", label: "배치" }],
  },
  work_order_count: 3,
  cost_ledger_total_won: 120000,
};

export const equipmentCostLedger = [
  {
    id: "ledger-1",
    branch_id: equipmentRow.branch_id,
    equipment_id: equipmentId,
    work_order_id: "wo-1",
    purchase_request_id: null,
    source: "MANUAL_ADMIN",
    amount_won: 120000,
    memo: "오일 교체",
    residual_before_won: 5000000,
    residual_after_won: 4880000,
    entry_at: "2026-07-08T06:10:00Z",
  },
];

export const equipmentLifecycleCost = {
  equipment_id: equipmentId,
  equipment_no: equipmentRow.equipment_no,
  status: equipmentRow.status,
  acquisition_cost_won: 5000000,
  acquisition_date: "2025-01-01",
  acquisition_source: "EXPLICIT",
  maintenance_total_won: 120000,
  manual_total_won: 0,
  purchase_total_won: 120000,
  entry_count: 1,
  outsource_unlinked_won: 0,
  residual_value_won: 4880000,
  sale_price_won: null,
  sold_at: null,
  gross_margin_won: null,
  tco_won: 5120000,
  cost_per_month_won: 320000,
  cost_per_hour_won: 12000,
  timeline: equipmentCostLedger,
};

export const equipmentActionCatalog = {
  object_type: "equipment",
  object_id: equipmentId,
  actions: [
    {
      action_id: "equipment.update_profile",
      object_type: "equipment",
      object_id: equipmentId,
      label: "정보 수정",
      description: "프로필 수정",
      submit_label: "저장",
      requires_passkey_step_up: true,
      risk_level: "sensitive_write",
      fields: [],
    },
  ],
};

export default {
  workOrders,
  supportTickets,
  equipmentList,
  equipmentRow,
  equipmentTimelineGraph,
  equipmentCostLedger,
  equipmentLifecycleCost,
  equipmentActionCatalog,
};
