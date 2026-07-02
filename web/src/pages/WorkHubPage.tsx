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
import {
  devApprovalItemsPage,
  devDailyPlanListPage,
  devMessengerThreads,
  devSupportTicketPage,
  devWorkOrderListPage,
  isDevPreviewEnabled,
} from "../lib/dev-preview";
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

interface HubItem {
  id: string;
  filter: Exclude<FilterKey, "all" | "urgent" | "mail">;
  title: string;
  eyebrow: string;
  detail: string;
  href: string;
  action: string;
  dueLabel?: string;
  badge?: string;
  badgeClass?: string;
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

function workOrderTitle(workOrder: WorkOrderListItem): string {
  const customer = safeLabel(workOrder.customer.name);
  const site = safeLabel(workOrder.site.name);
  return `${workOrder.request_no} · ${customer} / ${site}`;
}

function workOrderDetail(workOrder: WorkOrderListItem): string {
  const equipment = safeLabel(
    workOrder.equipment.management_no,
    workOrder.equipment.equipment_no,
    workOrder.equipment.model,
  );
  const status = labelFromMap(ko.status, workOrder.status);
  const assignees = workOrder.assignments
    .map((assignment) => safeLabel(assignment.mechanic_name))
    .filter((name) => name !== ko.common.unknownLabel)
    .join(", ");
  return assignees
    ? `${equipment} · ${status} · ${assignees}`
    : `${equipment} · ${status}`;
}

function buildWorkItems(workOrders: WorkOrderListItem[]): HubItem[] {
  return workOrders.map((workOrder) => {
    const overdue = isOverdue(workOrder.target_due_at);
    return {
      id: `work-${workOrder.id}`,
      filter: "work",
      title: workOrderTitle(workOrder),
      eyebrow: ko.workHub.items.work,
      detail: workOrderDetail(workOrder),
      href: `/work-orders/${workOrder.id}`,
      action: ko.workHub.actions.openWorkOrder,
      dueLabel: workOrder.target_due_at
        ? ko.workHub.due.target.replace("{time}", formatKoreanDateTime(workOrder.target_due_at))
        : undefined,
      badge: overdue ? ko.workHub.badges.overdue : priorityLabel(workOrder.priority),
      badgeClass: overdue
        ? "border-red-300 bg-red-50 text-red-800"
        : priorityClass(workOrder.priority),
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
    title: safeLabel(item.title),
    eyebrow: `${ko.workHub.items.approval} · ${approvalSourceLabel(item.source)}`,
    detail: safeLabel(item.summary, item.workflow.workflow_key),
    href: approvalHref(item),
    action: approvalActionLabel(item),
    dueLabel: item.due_at
      ? ko.workHub.due.target.replace("{time}", formatKoreanDateTime(item.due_at))
      : undefined,
    badge: approvalStatusLabel(item),
    badgeClass: "border-amber-300 bg-amber-50 text-amber-900",
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
    if (isDevPreviewEnabled()) {
      setData({
        workOrders: devWorkOrderListPage().items,
        approvalItems: canApprove ? devApprovalItemsPage().items : [],
        dailyPlans: canUseDailyPlan ? devDailyPlanListPage().items : [],
        tickets: devSupportTicketPage().items.filter(isActionableSupportTicket),
        messengerThreads: canUseMessenger ? devMessengerThreads() : [],
      });
      setFailures([]);
      setReadState("idle");
      return;
    }
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
        hint: ko.workHub.priorityRail.cards.urgent.hint,
        count: urgentCount,
        className: "border-red-200 bg-red-50 text-red-900",
      },
      {
        key: "approval" as const,
        filter: "approval" as const,
        label: ko.workHub.priorityRail.cards.approval.label,
        hint: ko.workHub.priorityRail.cards.approval.hint,
        count: canApprove ? data.approvalItems.length : 0,
        disabled: !canApprove,
        className: "border-amber-200 bg-amber-50 text-amber-950",
      },
      {
        key: "daily" as const,
        filter: "daily" as const,
        label: ko.workHub.priorityRail.cards.daily.label,
        hint: ko.workHub.priorityRail.cards.daily.hint,
        count: canUseDailyPlan ? data.dailyPlans.length : 0,
        disabled: !canUseDailyPlan,
        className: "border-violet-200 bg-violet-50 text-violet-950",
      },
      {
        key: "support" as const,
        filter: "support" as const,
        label: ko.workHub.priorityRail.cards.support.label,
        hint: ko.workHub.priorityRail.cards.support.hint,
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
        description={canSeeTeamQueue ? ko.workHub.descriptionTeam : ko.workHub.descriptionMine}
        actions={
          <>
            <Badge>{ko.workHub.badges.liveWorkflow}</Badge>
            <RefreshButton onClick={() => { void loadData(); }} isLoading={readState === "loading"} />
          </>
        }
      />

      <div className="grid gap-5">
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={ko.workHub.sections.capabilities}>
          {stats.map(({ key, label, value, href, Icon, disabled }) => (
            <Card key={key} className={cn("flex min-h-36 flex-col justify-between gap-4", disabled && "bg-muted-panel/40")}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-steel">{label}</p>
                  <p className="mt-1 text-3xl font-semibold text-ink">{disabled ? "—" : value}</p>
                </div>
                <span className="rounded-full border border-line bg-white p-2 text-brand-teal">
                  <Icon size={20} aria-hidden="true" />
                </span>
              </div>
              {disabled ? (
                <p className="text-sm text-steel">{ko.workHub.permissionScoped}</p>
              ) : (
                <Button asChild variant="secondary" size="sm" className="self-start">
                  <Link to={href} aria-label={`${label} ${ko.workHub.actions.openModule}`}>
                    {ko.workHub.actions.openModule}
                  </Link>
                </Button>
              )}
            </Card>
          ))}
        </section>

        <WorkHubFocusDashboard
          workOrders={data.workOrders}
          dailyPlans={data.dailyPlans}
          inboxItems={inboxItems}
          urgentCount={urgentCount}
        />

        <Card
          aria-labelledby="work-hub-priority-title"
          className="grid gap-4 border-brand-teal/20 bg-white"
          role="region"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-brand-teal">{ko.workHub.priorityRail.eyebrow}</p>
              <h2 id="work-hub-priority-title" className="mt-1 text-xl font-semibold text-ink">
                {ko.workHub.priorityRail.title}
              </h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge className="border-brand-teal/20 bg-brand-teal/10 text-brand-teal">
                {canSeeTeamQueue ? ko.workHub.scope.team : ko.workHub.scope.mine}
              </Badge>
              <Badge className="border-line bg-muted-panel text-steel">{ko.workHub.priorityRail.policyBadge}</Badge>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-5">
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
                  "rounded-xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal",
                  card.className,
                  filter === card.filter && "ring-2 ring-brand-teal ring-offset-2",
                  card.disabled && "cursor-not-allowed opacity-50",
                )}
                onClick={() => { setFilter(card.filter); }}
              >
                <span className="block text-xs font-semibold uppercase tracking-wide">{card.label}</span>
                <span className="mt-1 block text-3xl font-semibold">
                  {card.count}
                  {ko.workHub.priorityRail.countSuffix}
                </span>
                <span className="mt-1 block text-sm">{card.hint}</span>
              </button>
            ))}
          </div>
        </Card>

        {failures.length > 0 && readState !== "error" ? (
          <PageError message={ko.workHub.partialFailure.replace("{sources}", failures.map((failure) => ko.workHub.sources[failure.key]).join(", "))} onRetry={() => { void loadData(); }} />
        ) : null}

        <section aria-labelledby="work-hub-inbox-title" className="grid gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="work-hub-inbox-title" className="text-lg font-semibold text-ink">
                {ko.workHub.sections.inbox}
              </h2>
              <p className="text-sm text-steel">{ko.workHub.sections.inboxHint}</p>
            </div>
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
  urgentCount,
}: {
  workOrders: WorkOrderListItem[];
  dailyPlans: DailyPlanSummary[];
  inboxItems: HubItem[];
  urgentCount: number;
}) {
  const calendarItems = [
    ...workOrders.flatMap((workOrder) =>
      workOrder.target_due_at
        ? [
            {
              id: `work-${workOrder.id}`,
              time: workOrder.target_due_at,
              title: workOrder.request_no,
              detail: workOrderDetail(workOrder),
            },
          ]
        : [],
    ),
    ...dailyPlans.map((plan, index) => ({
      id: `daily-${String(plan.id ?? index)}`,
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
        <div>
          <h2 className="text-base font-semibold text-ink">{ko.workHub.dashboard.focusTitle}</h2>
          <p className="text-xs text-steel">
            {ko.workHub.dashboard.focusHint.replace("{count}", String(urgentCount))}
          </p>
        </div>
        <ul className="grid gap-2">
          {focusItems.length === 0 ? (
            <li className="text-sm text-steel">{ko.workHub.dashboard.emptyFocus}</li>
          ) : (
            focusItems.map((item) => (
              <li key={item.id} className="rounded-md border border-line px-3 py-2">
                <p className="truncate text-sm font-semibold text-ink">{item.title}</p>
                <p className="truncate text-xs text-steel">{item.eyebrow} · {item.detail}</p>
              </li>
            ))
          )}
        </ul>
      </Card>

      <Card className="grid gap-3 p-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{ko.workHub.dashboard.calendarTitle}</h2>
          <p className="text-xs text-steel">{ko.workHub.dashboard.calendarHint}</p>
        </div>
        <ol className="grid gap-2">
          {calendarItems.length === 0 ? (
            <li className="text-sm text-steel">{ko.workHub.dashboard.emptyCalendar}</li>
          ) : (
            calendarItems.map((item) => (
              <li key={item.id} className="grid grid-cols-[auto_1fr] gap-2 rounded-md border border-line px-3 py-2">
                <time className="text-xs font-semibold text-brand-teal">
                  {item.time ? formatKoreanDateTime(item.time) : ko.common.unknownLabel}
                </time>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{item.title}</p>
                  <p className="truncate text-xs text-steel">{item.detail}</p>
                </div>
              </li>
            ))
          )}
        </ol>
      </Card>

      <Card className="grid gap-3 p-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{ko.workHub.dashboard.personalTitle}</h2>
          <p className="text-xs text-steel">
            {ko.workHub.dashboard.personalHint.replace("{count}", String(workOrders.length))}
          </p>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
          {compactWorkOrders.length === 0 ? (
            <li className="text-sm text-steel">{ko.workHub.dashboard.emptyWork}</li>
          ) : (
            compactWorkOrders.map((workOrder) => (
              <li key={workOrder.id} className="rounded-md border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={priorityClass(workOrder.priority)}>{priorityLabel(workOrder.priority)}</Badge>
                  <span className="truncate text-sm font-semibold text-ink">{workOrder.request_no}</span>
                </div>
                <p className="mt-1 truncate text-xs text-steel">{workOrderDetail(workOrder)}</p>
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
        "grid gap-3 border-l-4 md:grid-cols-[auto_1fr_auto] md:items-center",
        item.tone === "urgent" && "border-l-red-500",
        item.tone === "approval" && "border-l-amber-500",
        item.tone === "conversation" && "border-l-brand-teal",
        item.tone === "support" && "border-l-sky-500",
        item.tone === "neutral" && "border-l-line",
      )}
    >
      <span className="hidden rounded-full border border-line bg-muted-panel p-2 text-steel md:inline-flex">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-steel">{item.eyebrow}</p>
          {item.badge ? (
            <Badge className={cn("min-h-6 py-0.5", item.badgeClass)}>
              {item.badge}
            </Badge>
          ) : null}
        </div>
        <h3 className="mt-1 truncate text-base font-semibold text-ink">{item.title}</h3>
        <p className="mt-1 text-sm text-steel">{item.detail}</p>
        {item.dueLabel ? <p className="mt-1 text-xs font-medium text-steel">{item.dueLabel}</p> : null}
      </div>
      <Button asChild variant="secondary" size="sm" className="justify-self-start md:justify-self-end">
        <Link to={item.href}>{item.action}</Link>
      </Button>
    </Card>
  );
}
