import type { components } from "@maintenance/api-client-ts";

export const branchId = "11111111-1111-4111-8111-111111111111";
export const primaryMechanicId = "22222222-2222-4222-8222-222222222222";

export const tokenPair: components["schemas"]["TokenPairResponse"] = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  token_type: "Bearer",
  refresh_expires_at: "2026-06-13T00:00:00Z",
};

export const equipmentLookup: components["schemas"]["EquipmentLookupResponse"] =
  {
    id: "44444444-4444-4444-8444-444444444444",
    branch_id: branchId,
    equipment_no: "D-25-290",
    management_no: "290",
    model: "GTS25DE",
    status: "임대",
    specification: "좌식",
    ton_text: "2.5",
    customer: {
      id: "55555555-5555-4555-8555-555555555555",
      name: "케이앤엘",
    },
    site: {
      id: "66666666-6666-4666-8666-666666666666",
      name: "본사",
    },
  };

export const workOrderListItems: components["schemas"]["WorkOrderListItem"][] = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    request_no: "20260612-001",
    branch_id: branchId,
    status: "RECEIVED",
    priority: "P1",
    result_type: "UNKNOWN",
    target_due_at: "2026-06-12T09:00:00Z",
    created_at: "2026-06-12T08:00:00Z",
    updated_at: "2026-06-12T08:00:00Z",
    equipment: {
      id: equipmentLookup.id,
      equipment_no: equipmentLookup.equipment_no,
      management_no: equipmentLookup.management_no,
      model: equipmentLookup.model,
      status: equipmentLookup.status,
      specification: equipmentLookup.specification,
      ton_text: equipmentLookup.ton_text,
    },
    customer: equipmentLookup.customer,
    site: equipmentLookup.site,
    assignments: [],
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    request_no: "20260612-002",
    branch_id: branchId,
    status: "ADMIN_REVIEW",
    priority: "P2",
    result_type: "COMPLETED",
    target_due_at: "2026-06-12T15:00:00Z",
    created_at: "2026-06-12T10:00:00Z",
    updated_at: "2026-06-12T14:00:00Z",
    equipment: {
      id: "88888888-8888-4888-8888-888888888888",
      equipment_no: "D-30-305",
      management_no: "305",
      model: "D30S-9",
      status: "임대",
      specification: "좌식",
      ton_text: "3.0",
    },
    customer: {
      id: "99999999-9999-4999-8999-999999999999",
      name: "한빛물류",
    },
    site: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "인천센터",
    },
    assignments: [
      {
        id: "12121212-1212-4212-8212-121212121212",
        mechanic_id: primaryMechanicId,
        mechanic_name: "김정비",
        role: "PRIMARY",
        assigned_at: "2026-06-12T10:30:00Z",
      },
    ],
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    request_no: "20260612-003",
    branch_id: branchId,
    status: "ASSIGNED",
    priority: "P3",
    result_type: "UNKNOWN",
    target_due_at: null,
    created_at: "2026-06-12T11:00:00Z",
    updated_at: "2026-06-12T11:20:00Z",
    equipment: {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      equipment_no: "E-18-112",
      management_no: "112",
      model: "B18X",
      status: "임대",
      specification: "입식",
      ton_text: "1.8",
    },
    customer: {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      name: "수도권냉장",
    },
    site: {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      name: "하남창고",
    },
    assignments: [],
  },
];

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
