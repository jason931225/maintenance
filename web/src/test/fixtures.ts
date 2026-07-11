import type { components } from "@maintenance/api-client-ts";

export const branchId = "11111111-1111-4111-8111-111111111111";
export const primaryMechanicId = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Paginated-envelope helpers. The list endpoints now return
// `{ items, limit, offset, total }` (or a keyset variant), so tests wrap their
// fixture arrays through these instead of returning a bare array.
// ---------------------------------------------------------------------------

export function userPage(
  items: components["schemas"]["UserSummary"][],
  total = items.length,
): components["schemas"]["UserPage"] {
  return { items, limit: 200, offset: 0, total };
}

export function supportTicketPage(
  items: components["schemas"]["SupportTicketSummary"][],
  total = items.length,
  nextCursor: string | null = null,
): components["schemas"]["SupportTicketPage"] {
  return { items, next_cursor: nextCursor, total };
}

export function inspectionSchedulePage(
  items: components["schemas"]["InspectionScheduleSummary"][],
  total = items.length,
): components["schemas"]["InspectionSchedulePage"] {
  return { items, limit: 200, offset: 0, total };
}

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
    maker: "현대",
    vin: null,
    vehicle_registration_no: null,
    customer: {
      id: "55555555-5555-4555-8555-555555555555",
      name: "케이앤엘",
    },
    site: {
      id: "66666666-6666-4666-8666-666666666666",
      name: "본사",
    },
  };

export const workOrderListItems: components["schemas"]["WorkOrderListItem"][] =
  [
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
      site_contact: {
        name: "현장담당 김씨",
        phone: "010-2625-0987",
        email: null,
      },
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
        name: "Acme Corporation",
      },
      site: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "인천센터",
      },
      site_contact: null,
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
      site_contact: null,
      assignments: [],
    },
  ];

export const workOrderLens: components["schemas"]["WorkOrderObjectSetLens"] = {
  object_type: "work_order",
  aggregates: {
    total_count: 3,
    p1_count: 1,
    overdue_open_count: 1,
    unassigned_count: 2,
  },
  facets: {
    status: [
      { value: "RECEIVED", count: 1, filters: { status: "RECEIVED" } },
      { value: "ADMIN_REVIEW", count: 1, filters: { status: "ADMIN_REVIEW" } },
      { value: "ASSIGNED", count: 1, filters: { status: "ASSIGNED" } },
    ],
    priority: [
      { value: "P1", count: 1, filters: { priority: "P1" } },
      { value: "P2", count: 1, filters: { priority: "P2" } },
      { value: "P3", count: 1, filters: { priority: "P3" } },
    ],
  },
  histograms: {
    target_due_date: [
      {
        bucket: "2026-06-12",
        count: 2,
        filters: {
          target_due_from: "2026-06-12T00:00:00+09:00",
          target_due_to: "2026-06-12T23:59:59+09:00",
        },
      },
    ],
  },
  listograms: {
    customers: [
      {
        id: equipmentLookup.customer.id,
        name: equipmentLookup.customer.name,
        count: 1,
        filters: { customer_id: equipmentLookup.customer.id },
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        name: "Acme Corporation",
        count: 1,
        filters: { customer_id: "99999999-9999-4999-8999-999999999999" },
      },
    ],
    sites: [
      {
        id: equipmentLookup.site.id,
        name: equipmentLookup.site.name,
        count: 1,
        filters: { site_id: equipmentLookup.site.id },
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "인천센터",
        count: 1,
        filters: { site_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      },
    ],
  },
};

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

export const kpiReport: components["schemas"]["KpiReport"] = {
  period: {
    start: "2026-06-01T00:00:00Z",
    end: "2026-07-01T00:00:00Z",
  },
  requested_scope: {
    kind: "company",
  },
  rollups: [
    {
      scope: {
        kind: "company",
      },
      approved_report_count: 20,
      completed_count: 18,
      weighted_completed_points: 27,
      average_response_seconds: 540,
      average_completion_seconds: 14_400,
      target_due_compliance_bps: 8_750,
      revisit_rate_bps: 500,
      delay_rate_bps: 1_250,
      // Real backend contract: keys are work_order.delay_reason enum variants
      // (migration 0008), NOT pre-localized labels — the UI localizes them.
      delay_reason_distribution: {
        PART_WAITING: 2,
        EQUIPMENT_IN_USE: 1,
        ADDITIONAL_FAULT_FOUND: 1,
      },
    },
    {
      scope: {
        kind: "branch",
        id: branchId,
      },
      scope_display_name: "창원지점",
      approved_report_count: 8,
      completed_count: 7,
      weighted_completed_points: 10,
      average_response_seconds: 420,
      average_completion_seconds: 10_800,
      target_due_compliance_bps: 9_000,
      revisit_rate_bps: 250,
      delay_rate_bps: 750,
      delay_reason_distribution: {
        PART_WAITING: 1,
      },
    },
    {
      scope: {
        kind: "region",
        id: "abababab-abab-4bab-8bab-abababababab",
      },
      scope_display_name: "경남권역",
      approved_report_count: 14,
      completed_count: 12,
      weighted_completed_points: 18,
      average_response_seconds: 500,
      average_completion_seconds: 12_600,
      target_due_compliance_bps: 8_900,
      revisit_rate_bps: 430,
      delay_rate_bps: 900,
      delay_reason_distribution: {
        PART_WAITING: 2,
      },
    },
    {
      scope: {
        kind: "technician",
        id: primaryMechanicId,
      },
      scope_display_name: "김정비",
      approved_report_count: 4,
      completed_count: 4,
      weighted_completed_points: 6,
      average_response_seconds: 360,
      average_completion_seconds: 9_000,
      target_due_compliance_bps: 10_000,
      revisit_rate_bps: 0,
      delay_rate_bps: 0,
      delay_reason_distribution: {},
    },
  ],
  unavailable_metrics: [
    {
      metric: "inspection_plan_completion_rate",
      source_domain: "regular-inspection",
      reason: "정기검사 도메인 병합 대기",
    },
    {
      metric: "p1_acceptance_rate",
      source_domain: "p1-broadcast",
      reason: "P1 수락 이벤트 수집 전",
    },
  ],
};
