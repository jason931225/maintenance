import {
  CalendarCheck,
  CheckSquare,
  Inbox,
  LifeBuoy,
  Mail,
  MessageSquare,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type {
  ApprovalItem,
  DailyPlanSummary,
  MessengerThreadSummary,
  SupportTicketSummary,
  WorkOrderListItem,
} from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import {
  FEATURES,
  hasAnyFeatureGrant,
  hasAnyRole,
  ROLES,
} from "../components/shell/nav";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { useAuth } from "../context/auth";
import { isActionableSupportTicket } from "../features/support/support-format";
import { ko } from "../i18n/ko";
import { formatKoreanDate, formatKoreanDateTime } from "../lib/datetime";
import { cn, priorityClass, priorityLabel, safeLabel } from "../lib/utils";

const ADMIN_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;
const DAILY_PLAN_ROLES = [ROLES.MECHANIC, ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;
const MAIL_USE_ROLES = [
  ROLES.RECEPTIONIST,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;
const MAIL_USE_FEATURES = [FEATURES.MAIL_USE] as const;
const MESSENGER_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.MECHANIC,
  ROLES.RECEPTIONIST,
] as const;
const TEAM_QUEUE_ROLES = [
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
  ROLES.EXECUTIVE,
  ROLES.RECEPTIONIST,
] as const;

type FilterKey = "all" | "urgent" | "work" | "approval" | "daily" | "support" | "conversation";
type SourceKey = "workOrders" | "approvals" | "dailyPlans" | "support" | "messenger";

type ReadState = "loading" | "idle" | "error";

interface WorkHubData {
  workOrders: WorkOrderListItem[];
  approvalItems: ApprovalItem[];
  dailyPlans: DailyPlanSummary[];
  tickets: SupportTicketSummary[];
  messengerThreads: MessengerThreadSummary[];
}

interface SourceFailure {
  key: SourceKey;
}

interface CapturedSource<T = unknown> {
  key: SourceKey;
  data?: T;
  failed: boolean;
  skipped?: boolean;
}

interface HubObjectLink {
  id: string;
  label: string;
  value: string;
  href: string;
}

interface HubItem {
  id: string;
  filter: Exclude<FilterKey, "all" | "urgent" | "mail">;
  objectCode?: string;
  objectHref?: string;
  title: string;
  eyebrow: string;
  detail: string;
  href: string;
  action: string;
  dueLabel?: string;
  statusLabel?: string;
  badge?: string;
  badgeClass?: string;
  objectLinks?: HubObjectLink[];
  tone: "neutral" | "urgent" | "approval" | "conversation" | "support";
  sortTime: number;
}

const emptyData: WorkHubData = {
  workOrders: [],
  approvalItems: [],
  dailyPlans: [],
  tickets: [],
  messengerThreads: [],
};

function labelFromMap(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return ko.common.unknownLabel;
  return map[value] ?? value;
}

function isOverdue(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) && time < Date.now();
}

function timeValue(iso: string | null | undefined): number {
  if (!iso) return 0;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : 0;
}

function equipmentObjectLabel(workOrder: WorkOrderListItem): string {
  return safeLabel(
    workOrder.equipment.equipment_no,
    workOrder.equipment.management_no,
    workOrder.equipment.model,
  );
}

function workOrderTitle(workOrder: WorkOrderListItem): string {
  const customer = safeLabel(workOrder.customer.name);
  const site = safeLabel(workOrder.site.name);
  return `${customer} / ${site}`;
}

function workOrderDetail(workOrder: WorkOrderListItem): string {
  const equipment = equipmentObjectLabel(workOrder);
  const assignees = workOrder.assignments
    .map((assignment) => safeLabel(assignment.mechanic_name))
    .filter((name) => name !== ko.common.unknownLabel)
    .join(", ");
  return assignees ? `${equipment} · ${assignees}` : equipment;
}

function workOrderObjectLinks(workOrder: WorkOrderListItem): HubObjectLink[] {
  const links: HubObjectLink[] = [];
  const equipment = equipmentObjectLabel(workOrder);
  if (equipment !== ko.common.unknownLabel) {
    links.push({
      id: `equipment-${workOrder.equipment.id}`,
      label: ko.workOrder.detail.equipment,
      value: equipment,
      href: `/equipment/${encodeURIComponent(workOrder.equipment.id)}`,
    });
  }

  const customer = safeLabel(workOrder.customer.name);
  if (customer !== ko.common.unknownLabel) {
    links.push({
      id: `customer-${workOrder.customer.id}`,
      label: ko.workOrder.detail.customer,
      value: customer,
      href: `/dispatch?customer_id=${encodeURIComponent(workOrder.customer.id)}`,
    });
  }

  const site = safeLabel(workOrder.site.name);
  if (site !== ko.common.unknownLabel) {
    links.push({
      id: `site-${workOrder.site.id}`,
      label: ko.workOrder.detail.site,
      value: site,
      href: `/dispatch?site_id=${encodeURIComponent(workOrder.site.id)}`,
    });
  }

  return links;
}

function buildWorkItems(workOrders: WorkOrderListItem[]): HubItem[] {
  return workOrders.map((workOrder) => {
    const overdue = isOverdue(workOrder.target_due_at);
    const href = `/work-orders/${workOrder.id}`;
    return {
      id: `work-${workOrder.id}`,
      filter: "work",
      objectCode: workOrder.request_no,
      objectHref: href,
      title: workOrderTitle(workOrder),
      eyebrow: ko.workHub.items.work,
      detail: workOrderDetail(workOrder),
      href,
      action: ko.workHub.actions.openWorkOrder,
      dueLabel: workOrder.target_due_at
        ? ko.workHub.due.target.replace("{time}", formatKoreanDateTime(workOrder.target_due_at))
        : undefined,
      statusLabel: labelFromMap(ko.status, workOrder.status),
      badge: overdue ? ko.workHub.badges.overdue : priorityLabel(workOrder.priority),
      badgeClass: overdue
        ? "border-red-300 bg-red-50 text-red-800"
        : priorityClass(workOrder.priority),
      objectLinks: workOrderObjectLinks(workOrder),
      tone: overdue || workOrder.priority === "P1" ? "urgent" : "neutral",
      sortTime: overdue ? Date.now() + 1 : timeValue(workOrder.target_due_at || workOrder.updated_at),
    };
  });
}

function approvalSourceLabel(source: ApprovalItem["source"]): string {
  switch (source) {
    case "WORK_ORDER":
      return ko.approvals.sources.workOrders;
    case "DAILY_PLAN":
      return ko.approvals.sources.dailyPlans;
    case "TARGET_CHANGE":
      return ko.approvals.sources.targetChanges;
  }
}

function approvalStatusLabel(item: ApprovalItem): string {
  if (item.source === "WORK_ORDER") {
    return labelFromMap(ko.status, item.status);
  }
  if (item.source === "DAILY_PLAN") {
    return labelFromMap(ko.workHub.dailyPlanStatus, item.status);
  }
  return labelFromMap(ko.approvals.targetChange.statuses, item.status);
}

function approvalFallbackHref(source: ApprovalItem["source"]): string {
  return source === "DAILY_PLAN" ? "/daily-plan" : "/approvals";
}

function approvalHref(item: ApprovalItem): string {
  const href = item.href.trim();
  if (href.startsWith("#")) {
    return `/approvals${href}`;
  }
  if (!href.startsWith("/") || href.startsWith("//")) {
    return approvalFallbackHref(item.source);
  }
  const path = href.split(/[?#]/, 1)[0];
  if (path === "/approvals" || path === "/daily-plan") {
    return href;
  }
  return approvalFallbackHref(item.source);
}

function approvalActionLabel(item: ApprovalItem): string {
  if (item.source === "DAILY_PLAN") {
    return ko.workHub.actions.openDailyPlan;
  }
  return ko.workHub.actions.openApprovals;
}

function buildApprovalItems(items: ApprovalItem[]): HubItem[] {
  return items.map((item) => ({
    id: `approval-${item.id}`,
    filter: "approval",
    objectCode: item.work_order?.request_no,
    objectHref: item.work_order ? `/work-orders/${item.work_order.id}` : undefined,
    title: safeLabel(item.title),
    eyebrow: `${ko.workHub.items.approval} · ${approvalSourceLabel(item.source)}`,
    detail: safeLabel(item.summary, item.workflow.workflow_key),
    href: approvalHref(item),
    action: approvalActionLabel(item),
    dueLabel: item.due_at
      ? ko.workHub.due.target.replace("{time}", formatKoreanDateTime(item.due_at))
      : undefined,
    statusLabel: approvalStatusLabel(item),
    badge: approvalStatusLabel(item),
    badgeClass: "border-amber-300 bg-amber-50 text-amber-900",
    objectLinks: item.work_order ? workOrderObjectLinks(item.work_order) : undefined,
    tone: "approval",
    sortTime: timeValue(item.due_at || item.requested_at),
  }));
}

function buildDailyItems(plans: DailyPlanSummary[]): HubItem[] {
  return plans.map((plan, index) => {
    const status = labelFromMap(ko.workHub.dailyPlanStatus, plan.status);
    const date = plan.plan_date ? formatKoreanDate(plan.plan_date) : ko.common.unknownLabel;
    const href = plan.id ? `/daily-plan?planId=${plan.id}` : "/daily-plan";
    return {
      id: `daily-${String(plan.id ?? index)}`,
      filter: "daily",
      title: ko.workHub.items.dailyTitle.replace("{date}", date),
      eyebrow: ko.workHub.items.daily,
      detail: status,
      href,
      action: ko.workHub.actions.openDailyPlan,
      statusLabel: status,
      badge: status,
      badgeClass:
        plan.status === "REQUESTED"
          ? "border-amber-300 bg-amber-50 text-amber-900"
          : "border-line bg-muted-panel text-steel",
      tone: plan.status === "REQUESTED" ? "approval" : "neutral",
      sortTime: timeValue(plan.plan_date),
    };
  });
}

function buildSupportItems(tickets: SupportTicketSummary[]): HubItem[] {
  return tickets.map((ticket) => {
    const overdue = ticket.status !== "RESOLVED" && ticket.status !== "CLOSED" && isOverdue(ticket.due_at);
    return {
      id: `support-${ticket.id}`,
      filter: "support",
      title: safeLabel(ticket.title),
      eyebrow: ko.workHub.items.support,
      detail: ko.workHub.ticketDetail
        .replace("{status}", labelFromMap(ko.support.ticketStatus, ticket.status))
        .replace("{requester}", safeLabel(ticket.requester_name, ko.workHub.unknownRequester)),
      href: "/support",
      action: ko.workHub.actions.openSupport,
      dueLabel: ticket.due_at
        ? ko.workHub.due.target.replace("{time}", formatKoreanDateTime(ticket.due_at))
        : undefined,
      statusLabel: labelFromMap(ko.support.ticketStatus, ticket.status),
      badge: overdue ? ko.workHub.badges.overdue : labelFromMap(ko.support.ticketPriority, ticket.priority),
      badgeClass:
        overdue || ticket.priority === "URGENT"
          ? "border-red-300 bg-red-50 text-red-800"
          : "border-sky-300 bg-sky-50 text-sky-800",
      tone: overdue || ticket.priority === "URGENT" ? "urgent" : "support",
      sortTime: overdue ? Date.now() + 1 : timeValue(ticket.due_at || ticket.updated_at),
    };
  });
}

function messengerUnreadTotal(threads: MessengerThreadSummary[]): number {
  return threads.reduce((sum, thread) => sum + Math.max(0, thread.unread_count), 0);
}

function isActionableConversationThread(thread: MessengerThreadSummary): boolean {
  return thread.kind !== "work_order" && thread.unread_count > 0;
}

function conversationThreadFallback(kind: MessengerThreadSummary["kind"]): string {
  switch (kind) {
    case "work_order":
      return ko.workHub.threadFallback.workOrder;
    case "team":
      return ko.workHub.threadFallback.team;
    case "dm":
      return ko.workHub.threadFallback.dm;
    case "group":
      return ko.workHub.threadFallback.group;
  }
}

function conversationThreadKindLabel(kind: MessengerThreadSummary["kind"]): string {
  switch (kind) {
    case "work_order":
      return ko.workHub.threadKind.work_order;
    case "team":
      return ko.workHub.threadKind.team;
    case "dm":
      return ko.workHub.threadKind.dm;
    case "group":
      return ko.workHub.threadKind.group;
  }
}

function conversationThreadTitle(thread: MessengerThreadSummary): string {
  const title = thread.title?.trim();
  if (title) return title;
  return conversationThreadFallback(thread.kind);
}

function buildConversationItems(threads: MessengerThreadSummary[]): HubItem[] {
  if (threads.length === 0) return [];
  return threads.filter(isActionableConversationThread).map((thread) => {
    const kindLabel = conversationThreadKindLabel(thread.kind);
    return {
      id: `conversation-${thread.id}`,
      filter: "conversation",
      title: conversationThreadTitle(thread),
      eyebrow: `${ko.workHub.items.conversation} · ${kindLabel}`,
      detail: ko.workHub.threadDetail
        .replace("{kind}", kindLabel)
        .replace("{count}", String(thread.member_count)),
      href: `/messenger?thread=${thread.id}`,
      action: ko.workHub.actions.openMessenger,
      dueLabel: thread.last_message_at
        ? ko.workHub.due.lastMessage.replace("{time}", formatKoreanDateTime(thread.last_message_at))
        : undefined,
      badge: ko.workHub.badges.unreadMessages.replace("{count}", String(thread.unread_count)),
      badgeClass: "border-brand-teal/30 bg-brand-teal/10 text-brand-teal",
      tone: "conversation",
      sortTime: timeValue(thread.last_message_at || thread.updated_at),
    };
  });
}

function buildInboxItems(data: WorkHubData): HubItem[] {
  return [
    ...buildApprovalItems(data.approvalItems),
    ...buildWorkItems(data.workOrders),
    ...buildDailyItems(data.dailyPlans),
    ...buildSupportItems(data.tickets),
    ...buildConversationItems(data.messengerThreads),
  ].sort((a, b) => b.sortTime - a.sortTime);
}

async function capture<T>(
  key: SourceKey,
  request: Promise<{ data?: T } | undefined>,
): Promise<CapturedSource<T>> {
  const response = await request.catch(() => undefined);
  return { key, data: response?.data, failed: !response?.data };
}

function skippedSource(key: SourceKey): Promise<CapturedSource<{ items: [] }>> {
  return Promise.resolve({ key, data: { items: [] }, failed: false, skipped: true });
}

export function WorkHubPage() {
  const { api, session } = useAuth();
  const [data, setData] = useState<WorkHubData>(emptyData);
  const [failures, setFailures] = useState<SourceFailure[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [filter, setFilter] = useState<FilterKey>("all");

  const canApprove = hasAnyRole(session?.roles, ADMIN_ROLES);
  const canUseDailyPlan = hasAnyRole(session?.roles, DAILY_PLAN_ROLES);
  const canSeeTeamQueue = hasAnyRole(session?.roles, TEAM_QUEUE_ROLES);
  const canUseMessenger = hasAnyRole(session?.roles, MESSENGER_ROLES);
  const canUseMail =
    hasAnyRole(session?.roles, MAIL_USE_ROLES) ||
    hasAnyFeatureGrant(session?.feature_grants, MAIL_USE_FEATURES);

  const loadData = useCallback(async () => {
    setReadState("loading");
    const workOrderQuery = canSeeTeamQueue
      ? { limit: 20, offset: 0 }
      : { assigned_to: "me", limit: 20, offset: 0 };

    const requests = [
      capture("workOrders", api.GET("/api/v1/work-orders", { params: { query: workOrderQuery } })),
      capture("support", api.GET("/api/v1/support/tickets", { params: { query: { include_untriaged: true, limit: 20 } } })),
      canUseMessenger
        ? capture(
            "messenger",
            api.GET("/api/messenger/threads", { params: { query: { limit: 100 } } }),
          )
        : skippedSource("messenger"),
      canApprove
        ? capture(
            "approvals",
            api.GET("/api/approval-items", { params: { query: { limit: 50, offset: 0 } } }),
          )
        : skippedSource("approvals"),
      canUseDailyPlan
        ? capture("dailyPlans", api.GET("/api/daily-work-plans", { params: { query: {} } }))
        : skippedSource("dailyPlans"),
    ];

    const results = await Promise.all(requests);
    const requestedResults = results.filter((result) => !result.skipped);
    const nextFailures = results
      .filter((result) => result.failed)
      .map((result) => ({ key: result.key }));

    const nextData: WorkHubData = {
      workOrders: (results.find((r) => r.key === "workOrders")?.data as { items?: WorkOrderListItem[] } | undefined)?.items ?? [],
      approvalItems: (results.find((r) => r.key === "approvals")?.data as { items?: ApprovalItem[] } | undefined)?.items ?? [],
      dailyPlans: (results.find((r) => r.key === "dailyPlans")?.data as { items?: DailyPlanSummary[] } | undefined)?.items ?? [],
      tickets: ((results.find((r) => r.key === "support")?.data as { items?: SupportTicketSummary[] } | undefined)?.items ?? []).filter(isActionableSupportTicket),
      messengerThreads: (results.find((r) => r.key === "messenger")?.data as { items?: MessengerThreadSummary[] } | undefined)?.items ?? [],
    };

    setData(nextData);
    setFailures(nextFailures);
    setReadState(requestedResults.every((result) => result.failed) ? "error" : "idle");
  }, [api, canApprove, canSeeTeamQueue, canUseDailyPlan, canUseMessenger]);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  const inboxItems = useMemo(() => buildInboxItems(data), [data]);
  const visibleItems = filter === "all"
    ? inboxItems
    : filter === "urgent"
      ? inboxItems.filter((item) => item.tone === "urgent")
      : inboxItems.filter((item) => item.filter === filter);
  const urgentCount = useMemo(
    () => inboxItems.filter((item) => item.tone === "urgent").length,
    [inboxItems],
  );
  const messengerUnreadCount = useMemo(
    () => messengerUnreadTotal(data.messengerThreads),
    [data.messengerThreads],
  );
  const stats = useMemo(
    () => [
      {
        key: "work" as const,
        label: ko.workHub.stats.work,
        value: data.workOrders.length,
        href: "/dispatch",
        Icon: Inbox,
      },
      {
        key: "approval" as const,
        label: ko.workHub.stats.approvals,
        value: data.approvalItems.length,
        href: "/approvals",
        Icon: CheckSquare,
        disabled: !canApprove,
      },
      {
        key: "daily" as const,
        label: ko.workHub.stats.daily,
        value: data.dailyPlans.length,
        href: "/daily-plan",
        Icon: CalendarCheck,
        disabled: !canUseDailyPlan,
      },
      {
        key: "support" as const,
        label: ko.workHub.stats.support,
        value: data.tickets.length,
        href: "/support",
        Icon: LifeBuoy,
      },
      {
        key: "messenger" as const,
        label: ko.workHub.stats.messenger,
        value: messengerUnreadCount,
        href: "/messenger",
        Icon: MessageSquare,
        disabled: !canUseMessenger,
      },
      {
        key: "mail" as const,
        label: ko.workHub.stats.mail,
        value: 0,
        href: "/mail",
        Icon: Mail,
        disabled: !canUseMail,
      },
    ],
    [canApprove, canUseDailyPlan, canUseMail, canUseMessenger, data, messengerUnreadCount],
  );
  const priorityCards = useMemo(
    () => [
      {
        key: "urgent" as const,
        filter: "urgent" as const,
        label: ko.workHub.priorityRail.cards.urgent.label,
        count: urgentCount,
        className: "border-red-200 bg-red-50 text-red-900",
      },
      {
        key: "approval" as const,
        filter: "approval" as const,
        label: ko.workHub.priorityRail.cards.approval.label,
        count: canApprove ? data.approvalItems.length : 0,
        disabled: !canApprove,
        className: "border-amber-200 bg-amber-50 text-amber-950",
      },
      {
        key: "daily" as const,
        filter: "daily" as const,
        label: ko.workHub.priorityRail.cards.daily.label,
        count: canUseDailyPlan ? data.dailyPlans.length : 0,
        disabled: !canUseDailyPlan,
        className: "border-violet-200 bg-violet-50 text-violet-950",
      },
      {
        key: "support" as const,
        filter: "support" as const,
        label: ko.workHub.priorityRail.cards.support.label,
        count: data.tickets.length,
        className: "border-sky-200 bg-sky-50 text-sky-950",
      },
    ],
    [
      canApprove,
      canUseDailyPlan,
      data.approvalItems.length,
      data.dailyPlans.length,
      data.tickets.length,
      urgentCount,
    ],
  );

  return (
    <>
      <PageHeader
        title={ko.workHub.title}
        actions={
          <RefreshButton onClick={() => { void loadData(); }} isLoading={readState === "loading"} />
        }
      />

      <div className="grid gap-5">
        <section
          className="flex flex-col gap-2 rounded-xl border border-line bg-white p-2 md:flex-row md:items-stretch"
          aria-label={ko.workHub.sections.capabilities}
        >
          {stats.map(({ key, label, value, href, Icon, disabled }) => {
            const valueText = disabled ? "—" : `${String(value)}${ko.workHub.priorityRail.countSuffix}`;
            const content = (
              <>
                <span className="flex min-w-0 items-center gap-2">
                  <Icon size={16} aria-hidden="true" className="shrink-0 text-brand-teal" />
                  <span className="whitespace-nowrap text-sm font-semibold text-steel">{label}</span>
                </span>
                <span className="whitespace-nowrap font-mono text-sm font-semibold text-ink">{valueText}</span>
              </>
            );

            return disabled ? (
              <div
                key={key}
                aria-label={`${label} ${ko.workHub.permissionScoped}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-line bg-muted-panel/40 px-3 py-2"
              >
                {content}
              </div>
            ) : (
              <Link
                key={key}
                to={href}
                aria-label={`${label} ${valueText} ${ko.workHub.actions.openModule}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-line bg-white px-3 py-2 transition hover:border-brand-teal/40 hover:bg-brand-teal/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal"
              >
                {content}
              </Link>
            );
          })}
        </section>

        <WorkHubFocusDashboard
          workOrders={data.workOrders}
          dailyPlans={data.dailyPlans}
          inboxItems={inboxItems}
        />

        <Card
          aria-labelledby="work-hub-priority-title"
          className="grid gap-4 border-brand-teal/20 bg-white"
          role="region"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <h2 id="work-hub-priority-title" className="text-lg font-semibold text-ink">
              {ko.workHub.priorityRail.title}
            </h2>
            <div className="flex flex-wrap gap-2">
              <Badge className="border-brand-teal/20 bg-brand-teal/10 text-brand-teal">
                {canSeeTeamQueue ? ko.workHub.scope.team : ko.workHub.scope.mine}
              </Badge>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            {priorityCards.map((card) => (
              <button
                key={card.key}
                type="button"
                disabled={card.disabled}
                aria-pressed={filter === card.filter}
                aria-label={ko.workHub.priorityRail.actionLabel
                  .replace("{label}", card.label)
                  .replace("{count}", String(card.count))}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal",
                  card.className,
                  filter === card.filter && "ring-2 ring-brand-teal ring-offset-2",
                  card.disabled && "cursor-not-allowed opacity-50",
                )}
                onClick={() => { setFilter(card.filter); }}
              >
                <span className="text-sm font-semibold">{card.label}</span>
                <span className="font-mono text-sm font-semibold">
                  {card.count}
                  {ko.workHub.priorityRail.countSuffix}
                </span>
              </button>
            ))}
          </div>
        </Card>

        {failures.length > 0 && readState !== "error" ? (
          <PageError message={ko.workHub.partialFailure.replace("{sources}", failures.map((failure) => ko.workHub.sources[failure.key]).join(", "))} onRetry={() => { void loadData(); }} />
        ) : null}

        <section aria-labelledby="work-hub-inbox-title" className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="work-hub-inbox-title" className="text-lg font-semibold text-ink">
              {ko.workHub.sections.inbox}
            </h2>
            <div className="flex flex-wrap gap-2" aria-label={ko.workHub.filters.label}>
              {ko.workHub.filters.options.map((option) => (
                <Button
                  key={option.key}
                  type="button"
                  variant={filter === option.key ? "default" : "secondary"}
                  size="xs"
                  aria-pressed={filter === option.key}
                  onClick={() => { setFilter(option.key); }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          {readState === "loading" && inboxItems.length === 0 ? (
            <SkeletonCards count={4} lines={3} />
          ) : readState === "error" ? (
            <PageError onRetry={() => { void loadData(); }} />
          ) : visibleItems.length === 0 ? (
            <PageEmpty message={ko.workHub.emptyInbox} />
          ) : (
            <div className="grid gap-3">
              {visibleItems.slice(0, 14).map((item) => (
                <WorkHubItemCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function WorkHubFocusDashboard({
  workOrders,
  dailyPlans,
  inboxItems,
}: {
  workOrders: WorkOrderListItem[];
  dailyPlans: DailyPlanSummary[];
  inboxItems: HubItem[];
}) {
  const calendarItems = [
    ...workOrders.flatMap((workOrder) =>
      workOrder.target_due_at
        ? [
            {
              id: `work-${workOrder.id}`,
              href: `/work-orders/${workOrder.id}`,
              time: workOrder.target_due_at,
              title: workOrder.request_no,
              detail: workOrderDetail(workOrder),
            },
          ]
        : [],
    ),
    ...dailyPlans.map((plan, index) => ({
      id: `daily-${String(plan.id ?? index)}`,
      href: plan.id ? `/daily-plan?planId=${plan.id}` : "/daily-plan",
      time: plan.plan_date,
      title: ko.workHub.items.dailyTitle.replace(
        "{date}",
        plan.plan_date ? formatKoreanDate(plan.plan_date) : ko.common.unknownLabel,
      ),
      detail: labelFromMap(ko.workHub.dailyPlanStatus, plan.status),
    })),
  ]
    .sort((left, right) => timeValue(left.time) - timeValue(right.time))
    .slice(0, 5);
  const focusItems = inboxItems.slice(0, 4);
  const compactWorkOrders = workOrders.slice(0, 5);

  return (
    <section className="grid gap-3 xl:grid-cols-[1fr_1fr_1.2fr]" aria-label={ko.workHub.dashboard.label}>
      <Card className="grid gap-3 p-3">
        <h2 className="text-base font-semibold text-ink">{ko.workHub.dashboard.focusTitle}</h2>
        <ul className="grid gap-2">
          {focusItems.length === 0 ? (
            <li className="text-sm text-steel">{ko.workHub.dashboard.emptyFocus}</li>
          ) : (
            focusItems.map((item) => (
              <li key={item.id}>
                <Link
                  to={item.href}
                  className="grid gap-1 rounded-md border border-line px-3 py-2 transition hover:border-brand-teal/40 hover:bg-brand-teal/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    {item.objectCode ? (
                      <span className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-xs font-semibold text-ink">
                        {item.objectCode}
                      </span>
                    ) : null}
                    <span className="truncate text-sm font-semibold text-ink">{item.title}</span>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    {item.statusLabel ? (
                      <Badge className="border-line bg-white py-0.5 text-steel">
                        {item.statusLabel}
                      </Badge>
                    ) : null}
                    {item.badge && item.badge !== item.statusLabel ? (
                      <Badge className={cn("py-0.5", item.badgeClass)}>
                        {item.badge}
                      </Badge>
                    ) : null}
                    {item.dueLabel ? (
                      <span className="truncate text-xs font-medium text-steel">{item.dueLabel}</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))
          )}
        </ul>
      </Card>

      <Card className="grid gap-3 p-3">
        <h2 className="text-base font-semibold text-ink">{ko.workHub.dashboard.calendarTitle}</h2>
        <ol className="grid gap-2">
          {calendarItems.length === 0 ? (
            <li className="text-sm text-steel">{ko.workHub.dashboard.emptyCalendar}</li>
          ) : (
            calendarItems.map((item) => (
              <li key={item.id}>
                <Link
                  to={item.href}
                  className="grid grid-cols-[auto_1fr] gap-2 rounded-md border border-line px-3 py-2 transition hover:border-brand-teal/40 hover:bg-brand-teal/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal"
                >
                  <time className="text-xs font-semibold text-brand-teal">
                    {item.time ? formatKoreanDateTime(item.time) : ko.common.unknownLabel}
                  </time>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{item.title}</span>
                    <span className="block truncate text-xs text-steel">{item.detail}</span>
                  </span>
                </Link>
              </li>
            ))
          )}
        </ol>
      </Card>

      <Card className="grid gap-3 p-3">
        <h2 className="text-base font-semibold text-ink">{ko.workHub.dashboard.personalTitle}</h2>
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
          {compactWorkOrders.length === 0 ? (
            <li className="text-sm text-steel">{ko.workHub.dashboard.emptyWork}</li>
          ) : (
            compactWorkOrders.map((workOrder) => (
              <li key={workOrder.id}>
                <Link
                  to={`/work-orders/${workOrder.id}`}
                  className="grid gap-1 rounded-md border border-line px-3 py-2 transition hover:border-brand-teal/40 hover:bg-brand-teal/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge className={priorityClass(workOrder.priority)}>{priorityLabel(workOrder.priority)}</Badge>
                    <span className="truncate font-mono text-sm font-semibold text-ink">{workOrder.request_no}</span>
                  </span>
                  <span className="truncate text-xs text-steel">{workOrderDetail(workOrder)}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      </Card>
    </section>
  );
}

function WorkHubItemCard({ item }: { item: HubItem }) {
  const Icon = item.filter === "approval"
    ? CheckSquare
    : item.filter === "daily"
      ? CalendarCheck
      : item.filter === "support"
        ? LifeBuoy
        : item.filter === "conversation"
          ? MessageSquare
          : Timer;
  return (
    <Card
      className={cn(
        "grid gap-3 md:grid-cols-[auto_1fr_auto] md:items-center",
        item.tone === "urgent" && "border-red-200 bg-red-50",
        item.tone === "approval" && "border-amber-200 bg-amber-50",
        item.tone === "conversation" && "border-brand-teal/30 bg-brand-teal/10",
        item.tone === "support" && "border-sky-200 bg-sky-50",
        item.tone === "neutral" && "border-line bg-white",
      )}
    >
      <span
        className={cn(
          "hidden rounded-full border bg-white/75 p-2 md:inline-flex",
          item.tone === "urgent" && "border-red-200 text-red-700",
          item.tone === "approval" && "border-amber-200 text-amber-700",
          item.tone === "conversation" && "border-brand-teal/30 text-brand-teal",
          item.tone === "support" && "border-sky-200 text-sky-700",
          item.tone === "neutral" && "border-line text-steel",
        )}
      >
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {item.objectCode && item.objectHref ? (
            <Link
              to={item.objectHref}
              className="inline-flex min-h-6 items-center rounded-md border border-line bg-white px-2 py-0.5 font-mono text-xs font-semibold text-ink underline-offset-2 transition hover:border-brand-teal/40 hover:bg-brand-teal/5 hover:underline focus-visible:underline"
            >
              {item.objectCode}
            </Link>
          ) : null}
          <p className="text-xs font-semibold uppercase tracking-wide text-steel">{item.eyebrow}</p>
          {item.statusLabel ? (
            <Badge className="min-h-6 border-line bg-white py-0.5 text-steel">
              {item.statusLabel}
            </Badge>
          ) : null}
          {item.badge && item.badge !== item.statusLabel ? (
            <Badge className={cn("min-h-6 py-0.5", item.badgeClass)}>
              {item.badge}
            </Badge>
          ) : null}
        </div>
        <h3 className="mt-1 truncate text-base font-semibold text-ink">
          <Link to={item.href} className="underline-offset-2 hover:underline focus-visible:underline">
            {item.title}
          </Link>
        </h3>
        {item.detail && item.detail !== item.statusLabel ? (
          <p className="mt-1 text-sm text-steel">{item.detail}</p>
        ) : null}
        {item.objectLinks?.length ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {item.objectLinks.map((link) => (
              <Link
                key={link.id}
                to={link.href}
                aria-label={`${link.label} ${link.value}`}
                className="inline-flex min-h-6 min-w-0 items-center gap-1 rounded-md border border-line bg-white px-2 py-0.5 text-xs underline-offset-2 transition hover:border-brand-teal/40 hover:bg-brand-teal/5 hover:underline focus-visible:underline"
              >
                <span className="text-steel">{link.label}</span>
                <span className="max-w-[10rem] truncate font-semibold text-ink">{link.value}</span>
              </Link>
            ))}
          </div>
        ) : null}
        {item.dueLabel ? <p className="mt-1 text-xs font-medium text-steel">{item.dueLabel}</p> : null}
      </div>
      <Button asChild variant="secondary" size="sm" className="justify-self-start md:justify-self-end">
        <Link to={item.href}>{item.action}</Link>
      </Button>
    </Card>
  );
}
