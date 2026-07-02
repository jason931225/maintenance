import type {
  EmployeeDirectoryPage,
  HrReadinessSummary,
  LeaveBalancePage,
  MessengerMemberSummary,
  MessengerMessagePage,
  MessengerMessageSummary,
  MessengerThreadSummary,
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
