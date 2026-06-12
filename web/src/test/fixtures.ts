import type { components } from "@maintenance/api-client-ts";

export const branchId = "11111111-1111-4111-8111-111111111111";
export const primaryMechanicId = "22222222-2222-4222-8222-222222222222";

export const workOrders: components["schemas"]["WorkOrderSummary"][] = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    request_no: "20260612-001",
    branch_id: branchId,
    equipment_id: "44444444-4444-4444-8444-444444444444",
    customer_id: "55555555-5555-4555-8555-555555555555",
    site_id: "66666666-6666-4666-8666-666666666666",
    status: "RECEIVED",
    priority: "P1",
    result_type: "UNKNOWN",
    evidence_verified: false,
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    request_no: "20260612-002",
    branch_id: branchId,
    equipment_id: "88888888-8888-4888-8888-888888888888",
    customer_id: "99999999-9999-4999-8999-999999999999",
    site_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "ADMIN_REVIEW",
    priority: "P2",
    result_type: "COMPLETED",
    evidence_verified: true,
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    request_no: "20260612-003",
    branch_id: branchId,
    equipment_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    customer_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    site_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    status: "ASSIGNED",
    priority: "P3",
    result_type: "UNKNOWN",
    evidence_verified: false,
  },
];
