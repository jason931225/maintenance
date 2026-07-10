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

export default { workOrders, supportTickets };
