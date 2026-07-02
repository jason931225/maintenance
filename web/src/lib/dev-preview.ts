import type {
  ApprovalItemsPage,
  AttendanceSummaryPage,
  CustomerInquiryPage,
  DailyPlanListPage,
  EmployeeAttendanceRecord,
  EmployeeAttendanceRecordPage,
  EmployeeDirectoryPage,
  HrReadinessSummary,
  KpiReport,
  LeaveBalancePage,
  MailFolderView,
  MailThreadDetail,
  MailThreadView,
  MessengerMemberSummary,
  MessengerMessagePage,
  MessengerMessageSummary,
  MessengerThreadSummary,
  SupportTicketPage,
  WorkOrderListItem,
  WorkOrderListPage,
} from "../api/types";
import { ko } from "../i18n/ko";

const DEV_PREVIEW_STORAGE_KEY = "maintenance_dev_auto_login";

export const DEV_PREVIEW_USER_ID = "22222222-2222-4222-8222-222222222222";
export const DEV_PREVIEW_BRANCH_ID = "11111111-1111-4111-8111-111111111111";

function isLocalPreviewHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isDevPreviewEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  if (!isLocalPreviewHost(window.location.hostname)) return false;
  if (new URLSearchParams(window.location.search).get("dev_auto_login") === "on") {
    return true;
  }
  try {
    return window.localStorage.getItem(DEV_PREVIEW_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function createDevPreviewAccessToken(): string {
  const header = base64UrlJson({ alg: "none", typ: "JWT" });
  const payload = base64UrlJson({
    sub: DEV_PREVIEW_USER_ID,
    name: ko.devPreview.adminName,
    email: "dev-preview@knllogistic.local",
    org: "00000000-0000-4000-8000-000000000001",
    roles: ["SUPER_ADMIN"],
    group_roles: [],
    feature_grants: [],
    branches: [DEV_PREVIEW_BRANCH_ID],
    platform: false,
  });
  return `${header}.${payload}.dev-preview`;
}

const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const otherUserId = "33333333-3333-4333-8333-333333333333";
const thirdUserId = "44444444-4444-4444-8444-444444444444";
const createdAt = "2026-07-02T08:30:00Z";

const devThread: MessengerThreadSummary = {
  id: threadId,
  kind: "team",
  branch_id: DEV_PREVIEW_BRANCH_ID,
  title: ko.devPreview.messengerThreadTitle,
  work_order_id: null,
  last_message_id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000003",
  last_message_at: "2026-07-02T08:42:00Z",
  member_count: 3,
  unread_count: 2,
  created_at: createdAt,
  updated_at: "2026-07-02T08:42:00Z",
};

const devMessages: MessengerMessageSummary[] = [
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    thread_id: threadId,
    branch_id: DEV_PREVIEW_BRANCH_ID,
    sender_id: otherUserId,
    sender_name: ko.devPreview.fieldTechnicianName,
    body: ko.devPreview.messengerIncoming,
    attachment_evidence_ids: [],
    read_count: 0,
    read_target_count: 0,
    sent_at: "2026-07-02T08:35:00Z",
    created_at: "2026-07-02T08:35:00Z",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
    thread_id: threadId,
    branch_id: DEV_PREVIEW_BRANCH_ID,
    sender_id: DEV_PREVIEW_USER_ID,
    sender_name: ko.devPreview.adminName,
    body: ko.devPreview.messengerReply,
    attachment_evidence_ids: [],
    read_count: 1,
    read_target_count: 2,
    sent_at: "2026-07-02T08:38:00Z",
    created_at: "2026-07-02T08:38:00Z",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000003",
    thread_id: threadId,
    branch_id: DEV_PREVIEW_BRANCH_ID,
    sender_id: DEV_PREVIEW_USER_ID,
    sender_name: ko.devPreview.adminName,
    body: ko.devPreview.messengerReadProgressProbe,
    attachment_evidence_ids: [],
    read_count: 2,
    read_target_count: 2,
    sent_at: "2026-07-02T08:42:00Z",
    created_at: "2026-07-02T08:42:00Z",
  },
];

export function devMessengerThreads(): MessengerThreadSummary[] {
  return [devThread];
}

export function devMessengerMessagePage(threadIdParam: string): MessengerMessagePage {
  return {
    items: threadIdParam === threadId ? devMessages : [],
    next_cursor: null,
  };
}

export function searchDevMessengerMessages(query: string): MessengerMessageSummary[] {
  const normalized = query.trim().toLocaleLowerCase("ko-KR");
  if (!normalized) return [];
  return devMessages.filter((message) =>
    message.body.toLocaleLowerCase("ko-KR").includes(normalized),
  );
}

export function devMessengerMembers(): MessengerMemberSummary[] {
  return [
    {
      id: otherUserId,
      display_name: ko.devPreview.fieldTechnicianName,
      team: ko.devPreview.fieldTechnicianTeam,
    },
    {
      id: thirdUserId,
      display_name: ko.devPreview.dispatcherName,
      team: ko.devPreview.dispatcherTeam,
    },
  ];
}

export function createDevMessengerThread(params: {
  branchId: string;
  memberIds: string[];
  title?: string;
}): MessengerThreadSummary {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind: params.memberIds.length > 1 ? "group" : "dm",
    branch_id: params.branchId,
    title: params.title?.trim() || null,
    work_order_id: null,
    last_message_id: null,
    last_message_at: null,
    member_count: params.memberIds.length + 1,
    unread_count: 0,
    created_at: now,
    updated_at: now,
  };
}

export function createDevMessengerMessage(params: {
  thread: MessengerThreadSummary;
  body: string;
}): MessengerMessageSummary {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    thread_id: params.thread.id,
    branch_id: params.thread.branch_id,
    sender_id: DEV_PREVIEW_USER_ID,
    sender_name: ko.devPreview.adminName,
    body: params.body,
    attachment_evidence_ids: [],
    read_count: 0,
    read_target_count: Math.max(0, params.thread.member_count - 1),
    sent_at: now,
    created_at: now,
  };
}

const workOrderId = "66666666-6666-4666-8666-666666666666";
const dailyPlanId = "77777777-7777-4777-8777-777777777777";
const mailThreadId = "99999999-9999-4999-8999-999999999999";
const mailInboxId = "aaaaaaaa-0000-4000-8000-000000000010";
const payrollMaterialRefId = "aaaaaaaa-0000-4000-8000-000000000020";

export function devWorkOrderListPage(): WorkOrderListPage {
  const items: WorkOrderListItem[] = [
    {
      id: workOrderId,
      request_no: "BESTEC-20260702-001",
      branch_id: DEV_PREVIEW_BRANCH_ID,
      status: "ADMIN_REVIEW",
      priority: "P1",
      result_type: "COMPLETED",
      target_due_at: "2026-07-02T12:00:00Z",
      created_at: "2026-07-02T07:30:00Z",
      updated_at: "2026-07-02T08:45:00Z",
      equipment: {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        equipment_no: "B-25-290",
        management_no: "290",
        model: "BESTEC GTS25",
        status: "rented",
        specification: "2.5t",
        ton_text: "2.5",
      },
      customer: {
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        name: "BESTEC",
      },
      site: {
        id: "aaaaaaaa-0000-4000-8000-000000000003",
        name: "Incheon Center",
      },
      site_contact: {
        name: "Kim Field",
        phone: "010-0000-1001",
        email: "field@bestec.example",
      },
      assignments: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000004",
          mechanic_id: otherUserId,
          mechanic_name: ko.devPreview.fieldTechnicianName,
          role: "PRIMARY",
          assigned_at: "2026-07-02T07:45:00Z",
        },
      ],
    },
  ];

  return {
    items,
    limit: 20,
    offset: 0,
    total: items.length,
    lens: {
      object_type: "work_order",
      aggregates: {
        total_count: items.length,
        p1_count: 1,
        overdue_open_count: 0,
        unassigned_count: 0,
      },
      facets: {
        status: [{ value: "ADMIN_REVIEW", count: 1, filters: { status: "ADMIN_REVIEW" } }],
        priority: [{ value: "P1", count: 1, filters: { priority: "P1" } }],
      },
      histograms: {
        target_due_date: [
          {
            bucket: "2026-07-02",
            count: 1,
            filters: {
              target_due_from: "2026-07-02T00:00:00+09:00",
              target_due_to: "2026-07-02T23:59:59+09:00",
            },
          },
        ],
      },
      listograms: {
        customers: [{ id: "aaaaaaaa-0000-4000-8000-000000000002", name: "BESTEC", count: 1, filters: { customer_id: "aaaaaaaa-0000-4000-8000-000000000002" } }],
        sites: [{ id: "aaaaaaaa-0000-4000-8000-000000000003", name: "Incheon Center", count: 1, filters: { site_id: "aaaaaaaa-0000-4000-8000-000000000003" } }],
      },
    },
  };
}

export function devDailyPlanListPage(): DailyPlanListPage {
  return {
    items: [
      {
        id: dailyPlanId,
        branch_id: DEV_PREVIEW_BRANCH_ID,
        mechanic_id: otherUserId,
        plan_date: "2026-07-02",
        status: "REQUESTED",
        items: [
          {
            work_order_id: workOrderId,
            request_no: "BESTEC-20260702-001",
            customer_name: "BESTEC",
            site_name: "Incheon Center",
            description: ko.devPreview.dailyPlanItemDescription,
            sort_order: 1,
          },
        ],
      },
    ],
  };
}

export function devApprovalItemsPage(): ApprovalItemsPage {
  const workOrder = devWorkOrderListPage().items[0];
  const dailyPlan = devDailyPlanListPage().items[0];
  const items = [
    {
      id: `WORK_ORDER:${workOrder.id}`,
      source: "WORK_ORDER",
      source_id: workOrder.id,
      branch_id: DEV_PREVIEW_BRANCH_ID,
      status: workOrder.status,
      title: ko.devPreview.workOrderApprovalTitle,
      summary: ko.devPreview.workOrderApprovalSummary,
      requested_at: "2026-07-02T08:40:00Z",
      due_at: "2026-07-02T12:00:00Z",
      href: `/approvals?source=work-order&focus=${workOrder.id}`,
      action_href: `/api/work-orders/${workOrder.id}/approve`,
      ontology: {
        object_type: "WORK_ORDER",
        object_id: workOrder.id,
        tenant_id: "00000000-0000-4000-8000-000000000001",
        branch_id: DEV_PREVIEW_BRANCH_ID,
      },
      workflow: {
        workflow_key: "work_order.report_completion_review",
        action_key: "approve_work_order",
      },
      policy: {
        decision: "ALLOWED",
        enforcement: "server",
        required_features: ["completion_review"],
        scope_kind: "BRANCH",
        scope_id: DEV_PREVIEW_BRANCH_ID,
      },
      work_order: workOrder,
    },
    {
      id: `DAILY_PLAN:${dailyPlanId}`,
      source: "DAILY_PLAN",
      source_id: dailyPlan.id ?? dailyPlanId,
      branch_id: DEV_PREVIEW_BRANCH_ID,
      status: dailyPlan.status ?? "REQUESTED",
      title: ko.devPreview.dailyPlanApprovalTitle,
      summary: ko.devPreview.dailyPlanApprovalSummary,
      requested_at: "2026-07-02T08:20:00Z",
      due_at: "2026-07-02T10:00:00Z",
      href: `/daily-plan?planId=${dailyPlan.id ?? dailyPlanId}`,
      action_href: `/api/daily-work-plans/${dailyPlan.id ?? dailyPlanId}/approve`,
      ontology: {
        object_type: "DAILY_PLAN",
        object_id: dailyPlan.id ?? dailyPlanId,
        tenant_id: "00000000-0000-4000-8000-000000000001",
        branch_id: DEV_PREVIEW_BRANCH_ID,
      },
      workflow: {
        workflow_key: "daily_plan.review",
        action_key: "review_daily_plan",
      },
      policy: {
        decision: "ALLOWED",
        enforcement: "server",
        required_features: ["daily_plan_review"],
        scope_kind: "BRANCH",
        scope_id: DEV_PREVIEW_BRANCH_ID,
      },
      daily_plan: dailyPlan,
    },
  ] satisfies ApprovalItemsPage["items"];

  return {
    items,
    sources: [
      { key: "workOrders", label: ko.approvals.sources.workOrders, status: "ok", count: 1 },
      { key: "dailyPlans", label: ko.approvals.sources.dailyPlans, status: "ok", count: 1 },
    ],
    limit: 100,
    offset: 0,
    total: items.length,
  };
}

export function devSupportTicketPage(): SupportTicketPage {
  return {
    items: [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000030",
        branch_id: DEV_PREVIEW_BRANCH_ID,
        origin: "CUSTOMER",
        category: "OPERATIONAL",
        priority: "URGENT",
        status: "OPEN",
        title: ko.devPreview.supportTicketTitle,
        requester_user_id: thirdUserId,
        requester_name: ko.devPreview.dispatcherName,
        assignee_user_id: DEV_PREVIEW_USER_ID,
        assignee_name: ko.devPreview.adminName,
        due_at: "2026-07-02T11:00:00Z",
        created_at: "2026-07-02T08:10:00Z",
        updated_at: "2026-07-02T08:30:00Z",
        resolved_at: null,
        closed_at: null,
      },
    ],
    next_cursor: null,
    total: 1,
  };
}

export function devAttendanceSummaryPage(): AttendanceSummaryPage {
  return {
    items: [
      {
        user_id: otherUserId,
        display_name: ko.devPreview.fieldTechnicianName,
        arrivals: 1,
        departures: 0,
        last_kind: "OUT_FOR_WORK",
        last_event_at: "2026-07-02T08:15:00Z",
      },
      {
        user_id: thirdUserId,
        display_name: ko.devPreview.dispatcherName,
        arrivals: 1,
        departures: 1,
        last_kind: "CLOCK_OUT",
        last_event_at: "2026-07-02T08:20:00Z",
      },
    ],
    total: 2,
    limit: 1000,
    offset: 0,
  };
}

export function devEmployeeAttendanceRecordPage(): EmployeeAttendanceRecordPage {
  return {
    items: [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000040",
        employee_id: devEmployeeOneId,
        employee_display_name: ko.devPreview.fieldTechnicianName,
        kind: "OUT_FOR_WORK",
        occurred_at: "2026-07-02T08:15:00Z",
        work_date: "2026-07-02",
        state_after: "OUT_FOR_WORK",
        note: ko.devPreview.attendanceTripNote,
        payroll_material_ref_id: payrollMaterialRefId,
        payroll_link_status: "LINKED",
        duplicate: false,
      },
      {
        id: "aaaaaaaa-0000-4000-8000-000000000041",
        employee_id: devEmployeeOneId,
        employee_display_name: ko.devPreview.fieldTechnicianName,
        kind: "CLOCK_IN",
        occurred_at: "2026-07-02T00:05:00Z",
        work_date: "2026-07-02",
        state_after: "CLOCKED_IN",
        note: null,
        payroll_material_ref_id: "aaaaaaaa-0000-4000-8000-000000000021",
        payroll_link_status: "LINKED",
        duplicate: false,
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  };
}

export function createDevEmployeeAttendanceRecord(params: {
  kind: EmployeeAttendanceRecord["kind"];
  duplicate?: boolean;
}): EmployeeAttendanceRecord {
  const now = new Date();
  const stateAfter: EmployeeAttendanceRecord["state_after"] =
    params.kind === "CLOCK_OUT"
      ? "OFF_DUTY"
      : params.kind === "OUT_FOR_WORK"
        ? "OUT_FOR_WORK"
        : params.kind === "BUSINESS_TRIP"
          ? "BUSINESS_TRIP"
          : "CLOCKED_IN";
  return {
    id: crypto.randomUUID(),
    employee_id: devEmployeeOneId,
    employee_display_name: ko.devPreview.fieldTechnicianName,
    kind: params.kind,
    occurred_at: now.toISOString(),
    work_date: now.toISOString().slice(0, 10),
    state_after: stateAfter,
    note: null,
    payroll_material_ref_id: crypto.randomUUID(),
    payroll_link_status: "LINKED",
    duplicate: params.duplicate ?? false,
  };
}

export function devKpiReport(): KpiReport {
  return {
    period: {
      start: "2026-07-01T00:00:00Z",
      end: "2026-08-01T00:00:00Z",
    },
    requested_scope: {
      kind: "company",
    },
    rollups: [
      {
        scope: { kind: "company" },
        scope_display_name: "BESTEC",
        approved_report_count: 18,
        completed_count: 16,
        weighted_completed_points: 24,
        average_response_seconds: 420,
        average_completion_seconds: 12600,
        target_due_compliance_bps: 9200,
        revisit_rate_bps: 300,
        delay_rate_bps: 700,
        delay_reason_distribution: {
          [ko.devPreview.delayReasonPartsWaiting]: 1,
          [ko.devPreview.delayReasonEquipmentInUse]: 1,
        },
        inspection_schedule_due_count: 6,
        inspection_schedule_completed_count: 5,
        inspection_plan_completion_bps: 8333,
        p1_dispatch_count: 4,
        p1_accepted_count: 4,
        p1_acceptance_bps: 10000,
      },
      {
        scope: { kind: "technician", id: otherUserId },
        scope_display_name: ko.devPreview.fieldTechnicianName,
        approved_report_count: 7,
        completed_count: 7,
        weighted_completed_points: 11,
        average_response_seconds: 360,
        average_completion_seconds: 9000,
        target_due_compliance_bps: 10000,
        revisit_rate_bps: 0,
        delay_rate_bps: 0,
        delay_reason_distribution: {},
        inspection_schedule_due_count: 2,
        inspection_schedule_completed_count: 2,
        inspection_plan_completion_bps: 10000,
        p1_dispatch_count: 2,
        p1_accepted_count: 2,
        p1_acceptance_bps: 10000,
      },
    ],
    unavailable_metrics: [],
  };
}

const previewMailFolders: MailFolderView[] = [
  {
    id: mailInboxId,
    role: "INBOX",
    name: "INBOX",
    unread_count: 1,
    total_count: 2,
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000011",
    role: "SENT",
    name: "Sent",
    unread_count: 0,
    total_count: 1,
  },
];

const previewMailThreads: MailThreadView[] = [
  {
    id: mailThreadId,
    subject: ko.devPreview.mailPayrollSubject,
    last_message_at: "2026-07-02T08:25:00Z",
    message_count: 2,
    unread_count: 1,
    has_attachments: true,
    is_flagged: true,
  },
];

const devMailDetail: MailThreadDetail = {
  id: mailThreadId,
  subject: ko.devPreview.mailPayrollSubject,
  messages: [
    {
      id: "aaaaaaaa-0000-4000-8000-000000000012",
      thread_id: mailThreadId,
      direction: "IN",
      message_id: "<bestec-payroll-20260702@example>",
      in_reply_to: null,
      from_address: "hr@bestec.example",
      from_name: "BESTEC HR",
      to: [{ address: "payroll@knllogistic.local", name: "K-NL Payroll" }],
      cc: [],
      subject: ko.devPreview.mailPayrollSubject,
      snippet: ko.devPreview.mailPayrollSnippet,
      body_text: ko.devPreview.mailPayrollBody,
      body_html: null,
      seen: false,
      flagged: true,
      answered: false,
      has_attachments: true,
      received_at: "2026-07-02T08:25:00Z",
      attachments: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000013",
          filename: "bestec-payroll-202607.xlsx",
          content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size_bytes: 18240,
          is_inline: false,
        },
      ],
    },
  ],
};

export function devMailFolders(): MailFolderView[] {
  return previewMailFolders;
}

export function devMailThreads(): MailThreadView[] {
  return previewMailThreads;
}

export function devMailThreadDetail(id: string): MailThreadDetail | undefined {
  return id === mailThreadId ? devMailDetail : undefined;
}

export function devCustomerInquiryPage(): CustomerInquiryPage {
  return {
    items: [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000014",
        name: ko.devPreview.customerInquiryName,
        phone: "010-0000-2001",
        topic: "MAINTENANCE",
        location: "Incheon Center",
        message: ko.devPreview.customerInquiryMessage,
        listing_id: null,
        status: "NEW",
        created_at: "2026-07-02T08:00:00Z",
        updated_at: "2026-07-02T08:00:00Z",
      },
    ],
    limit: 5,
    offset: 0,
    total: 1,
  };
}

const devEmployeeOneId = otherUserId;
const devEmployeeTwoId = thirdUserId;
const devEmployeeThreeId = "55555555-5555-4555-8555-555555555555";

export function devEmployeeDirectoryPage(): EmployeeDirectoryPage {
  return {
    items: [
      {
        id: devEmployeeOneId,
        company: "BESTEC",
        name: ko.devPreview.fieldTechnicianName,
        employee_number: "B-1001",
        org_unit: ko.devPreview.fieldTechnicianTeam,
        worksite_name: "Incheon Center",
        worksite: "ICN-01",
        job: "Maintenance",
        position: "Lead",
        hire_date: "2024-03-01",
        exit_date: null,
        status: "ACTIVE",
        leave_accrued: "15",
        leave_used: "4",
        leave_remaining: "11",
        identity_resolution_strategy: "employee_number",
        identity_resolution_confidence: "high",
        identity_review_required: false,
        identity_name_only_merge: false,
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: devEmployeeTwoId,
        company: "BESTEC",
        name: ko.devPreview.dispatcherName,
        employee_number: "B-1002",
        org_unit: ko.devPreview.dispatcherTeam,
        worksite_name: "Seoul Office",
        worksite: "SEL-01",
        job: "Operations",
        position: "Manager",
        hire_date: "2022-01-10",
        exit_date: null,
        status: "ACTIVE",
        leave_accrued: "16",
        leave_used: "8",
        leave_remaining: "8",
        identity_resolution_strategy: "employee_number",
        identity_resolution_confidence: "high",
        identity_review_required: false,
        identity_name_only_merge: false,
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: devEmployeeThreeId,
        company: "BESTEC",
        name: ko.devPreview.adminName,
        employee_number: "B-0901",
        org_unit: "HR",
        worksite_name: "Seoul Office",
        worksite: "SEL-01",
        job: "HR",
        position: "Admin",
        hire_date: "2021-04-05",
        exit_date: "2026-07-01",
        status: "EXITED",
        leave_accrued: "17",
        leave_used: "17",
        leave_remaining: "0",
        identity_resolution_strategy: "employee_number",
        identity_resolution_confidence: "high",
        identity_review_required: false,
        identity_name_only_merge: false,
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
    total: 3,
    limit: 1000,
    offset: 0,
  };
}

export function devLeaveBalancePage(): LeaveBalancePage {
  return {
    items: devEmployeeDirectoryPage().items.map((employee) => ({
      id: employee.id,
      company: employee.company,
      name: employee.name,
      employee_number: employee.employee_number,
      org_unit: employee.org_unit,
      position: employee.position,
      leave_accrued: employee.leave_accrued,
      leave_used: employee.leave_used,
      leave_remaining: employee.leave_remaining,
    })),
    total: 3,
    limit: 1000,
    offset: 0,
    summary: {
      accrued: "48",
      used: "29",
      remaining: "19",
    },
  };
}

export function devHrReadinessSummary(): HrReadinessSummary {
  return {
    imports: {
      runs: 3,
      applied_runs: 3,
      input_rows: 42,
      candidate_rows: 3,
      preserved_rows: 39,
      ledger_rows: 42,
      latest_import_at: "2026-07-02T08:30:00Z",
    },
    payroll: {
      draft_runs: 1,
      blocked_runs: 0,
      calculation_enabled_runs: 1,
      draft_lines: 3,
      payroll_source_rows: 3,
      attendance_source_rows: 9,
      attendance_event_links: 9,
      attendance_material_refs: 9,
      gross_pay_source_lines: 3,
      net_pay_source_lines: 3,
      latest_status: "READY",
      latest_source_label: "BESTEC 2026-07 preview",
      latest_period_start: "2026-07-01",
      latest_period_end: "2026-07-31",
      latest_updated_at: "2026-07-02T08:42:00Z",
    },
    annual_leave: {
      obligations: 2,
      usage_promotion_required: 2,
      payout_review_required: 1,
      needs_review: 1,
      remaining_days: "19",
    },
    attendance: {
      durable_events: 12,
      self_service_records: 6,
      payroll_material_refs: 9,
    },
  };
}
