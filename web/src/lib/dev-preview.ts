import type {
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
