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
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { formatKoreanDate, formatKoreanDateTime } from "../lib/datetime";
import { cn, priorityClass, priorityLabel, safeLabel } from "../lib/utils";

const APPROVAL_STATUSES: WorkOrderListItem["status"][] = [
  "REPORT_SUBMITTED",
  "ADMIN_REVIEW",
];

const ADMIN_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;
const DAILY_PLAN_ROLES = [ROLES.MECHANIC, ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;
const TEAM_QUEUE_ROLES = [
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
  ROLES.EXECUTIVE,
  ROLES.RECEPTIONIST,
] as const;

type FilterKey = "all" | "work" | "approval" | "daily" | "conversation" | "support" | "mail";
type SourceKey = "workOrders" | "approvals" | "dailyPlans" | "messenger" | "support";

type ReadState = "loading" | "idle" | "error";

interface WorkHubData {
  workOrders: WorkOrderListItem[];
  approvalWorkOrders: WorkOrderListItem[];
  dailyPlans: DailyPlanSummary[];
  threads: MessengerThreadSummary[];
  tickets: SupportTicketSummary[];
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
  filter: Exclude<FilterKey, "all" | "mail">;
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
  approvalWorkOrders: [],
  dailyPlans: [],
  threads: [],
  tickets: [],
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

function buildApprovalItems(workOrders: WorkOrderListItem[]): HubItem[] {
  return workOrders.map((workOrder) => ({
    id: `approval-${workOrder.id}`,
    filter: "approval",
    title: ko.workHub.items.approvalTitle.replace("{requestNo}", workOrder.request_no),
    eyebrow: ko.workHub.items.approval,
    detail: workOrderDetail(workOrder),
    href: `/approvals?source=work-order&focus=${workOrder.id}`,
    action: ko.workHub.actions.openApprovals,
    dueLabel: workOrder.target_due_at
      ? ko.workHub.due.target.replace("{time}", formatKoreanDateTime(workOrder.target_due_at))
      : undefined,
    badge: labelFromMap(ko.status, workOrder.status),
    badgeClass: "border-amber-300 bg-amber-50 text-amber-900",
    tone: "approval",
    sortTime: timeValue(workOrder.updated_at),
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

function threadDisplayTitle(thread: MessengerThreadSummary): string {
  return safeLabel(
    thread.title,
    thread.kind === "work_order" ? ko.workHub.threadFallback.workOrder : undefined,
    thread.kind === "dm" ? ko.workHub.threadFallback.dm : undefined,
    thread.kind === "group" ? ko.workHub.threadFallback.group : undefined,
    ko.workHub.threadFallback.team,
  );
}

function buildConversationItems(threads: MessengerThreadSummary[]): HubItem[] {
  return threads.map((thread) => ({
    id: `conversation-${thread.id}`,
    filter: "conversation",
    title: threadDisplayTitle(thread),
    eyebrow: ko.workHub.items.conversation,
    detail: ko.workHub.threadDetail
      .replace("{kind}", labelFromMap(ko.workHub.threadKind, thread.kind))
      .replace("{count}", String(thread.member_count)),
    href: "/messenger",
    action: ko.workHub.actions.openMessenger,
    dueLabel: thread.last_message_at
      ? ko.workHub.due.lastMessage.replace("{time}", formatKoreanDateTime(thread.last_message_at))
      : undefined,
    badge: thread.work_order_id ? ko.workHub.badges.linkedWork : undefined,
    badgeClass: "border-brand-teal/30 bg-brand-teal/10 text-brand-teal",
    tone: "conversation",
    sortTime: timeValue(thread.last_message_at || thread.updated_at),
  }));
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

function isActionableSupportTicket(ticket: SupportTicketSummary): boolean {
  return ticket.status !== "CLOSED" && !ticket.closed_at;
}

function buildInboxItems(data: WorkHubData): HubItem[] {
  return [
    ...buildApprovalItems(data.approvalWorkOrders),
    ...buildWorkItems(data.workOrders),
    ...buildDailyItems(data.dailyPlans),
    ...buildConversationItems(data.threads),
    ...buildSupportItems(data.tickets),
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
  const canManageMail = hasAnyRole(session?.roles, ADMIN_ROLES);

  const loadData = useCallback(async () => {
    setReadState("loading");
    const workOrderQuery = canSeeTeamQueue
      ? { limit: 20, offset: 0 }
      : { assigned_to: "me", limit: 20, offset: 0 };

    const requests = [
      capture("workOrders", api.GET("/api/v1/work-orders", { params: { query: workOrderQuery } })),
      capture("messenger", api.GET("/api/messenger/threads", { params: { query: { limit: 20 } } })),
      capture("support", api.GET("/api/v1/support/tickets", { params: { query: { include_untriaged: true, limit: 20 } } })),
      canApprove
        ? capture(
            "approvals",
            api.GET("/api/v1/work-orders", {
              params: { query: { status: APPROVAL_STATUSES, limit: 50, offset: 0 } },
            }),
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
      approvalWorkOrders: (results.find((r) => r.key === "approvals")?.data as { items?: WorkOrderListItem[] } | undefined)?.items ?? [],
      dailyPlans: (results.find((r) => r.key === "dailyPlans")?.data as { items?: DailyPlanSummary[] } | undefined)?.items ?? [],
      threads: (results.find((r) => r.key === "messenger")?.data as { items?: MessengerThreadSummary[] } | undefined)?.items ?? [],
      tickets: ((results.find((r) => r.key === "support")?.data as { items?: SupportTicketSummary[] } | undefined)?.items ?? []).filter(isActionableSupportTicket),
    };

    setData(nextData);
    setFailures(nextFailures);
    setReadState(requestedResults.every((result) => result.failed) ? "error" : "idle");
  }, [api, canApprove, canSeeTeamQueue, canUseDailyPlan]);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  const inboxItems = useMemo(() => buildInboxItems(data), [data]);
  const visibleItems = filter === "all" ? inboxItems : inboxItems.filter((item) => item.filter === filter);
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
        value: data.approvalWorkOrders.length,
        href: "/approvals?source=work-order",
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
        key: "conversation" as const,
        label: ko.workHub.stats.conversations,
        value: data.threads.length,
        href: "/messenger",
        Icon: MessageSquare,
      },
      {
        key: "support" as const,
        label: ko.workHub.stats.support,
        value: data.tickets.length,
        href: "/support",
        Icon: LifeBuoy,
      },
      {
        key: "mail" as const,
        label: ko.workHub.stats.mail,
        value: canManageMail ? 1 : 0,
        href: "/settings/email",
        Icon: Mail,
        disabled: !canManageMail,
      },
    ],
    [canApprove, canManageMail, canUseDailyPlan, data],
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

        <Card
          aria-labelledby="work-hub-workflow-title"
          className="grid gap-4 border-brand-teal/20 bg-brand-teal/5"
          role="region"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-brand-teal">{ko.workHub.workflowRail.eyebrow}</p>
              <h2 id="work-hub-workflow-title" className="mt-1 text-xl font-semibold text-ink">
                {ko.workHub.workflowRail.title}
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-steel">{ko.workHub.workflowRail.description}</p>
            </div>
            <Badge className="border-brand-teal/20 bg-white text-brand-teal">{ko.workHub.workflowRail.auditBadge}</Badge>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {ko.workHub.workflowRail.steps.map((step) => (
              <div key={step.title} className="rounded-lg border border-line bg-white p-3">
                <p className="font-semibold text-ink">{step.title}</p>
                <p className="mt-1 text-sm text-steel">{step.description}</p>
              </div>
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

function WorkHubItemCard({ item }: { item: HubItem }) {
  const Icon = item.filter === "approval"
    ? CheckSquare
    : item.filter === "daily"
      ? CalendarCheck
      : item.filter === "conversation"
        ? MessageSquare
        : item.filter === "support"
          ? LifeBuoy
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
