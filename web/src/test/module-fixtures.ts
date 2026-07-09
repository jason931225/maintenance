import type { components } from "@maintenance/api-client-ts";

import { branchId, workOrderListItems } from "./fixtures";

/**
 * Fixtures for the generic module template (ModuleScreen) — its component test,
 * config-driven test, and static fidelity demo. Korean sample labels live here
 * under `src/test/` so `check-ui-strings` treats them as fixtures, not shippable
 * UI copy. Work orders reuse the shared `workOrderListItems` fixture; support
 * tickets are declared here (no shared summary fixture existed).
 */

export const demoWorkOrders = workOrderListItems;

const REQUESTER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASSIGNEE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function ticket(
  id: string,
  title: string,
  status: components["schemas"]["SupportTicketStatus"],
  priority: components["schemas"]["SupportTicketPriority"],
  category: components["schemas"]["SupportTicketCategory"],
  requesterName: string,
): components["schemas"]["SupportTicketSummary"] {
  return {
    id,
    branch_id: branchId,
    origin: "CUSTOMER",
    category,
    priority,
    status,
    title,
    requester_user_id: REQUESTER,
    requester_name: requesterName,
    assignee_user_id: ASSIGNEE,
    assignee_name: "운영 관리자",
    due_at: null,
    created_at: "2026-07-08T08:00:00Z",
    updated_at: "2026-07-08T09:00:00Z",
    resolved_at: null,
    closed_at: null,
  };
}

export const demoTickets: components["schemas"]["SupportTicketSummary"][] = [
  ticket("e1111111-1111-4111-8111-111111111111", "지게차 시동 불량 문의", "OPEN", "URGENT", "EQUIPMENT_INQUIRY", "홍길동"),
  ticket("e2222222-2222-4222-8222-222222222222", "임대 계약 연장 요청", "IN_PROGRESS", "HIGH", "OPERATIONAL", "김성아"),
  ticket("e3333333-3333-4333-8333-333333333333", "청구서 재발행 요청", "RESOLVED", "MEDIUM", "OTHER", "이종호"),
];
