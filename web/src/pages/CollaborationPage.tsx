import {
  CalendarDays,
  CheckSquare,
  Inbox,
  LifeBuoy,
  Mail,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import type {
  DailyPlanSummary,
  MailThreadView,
  MessengerThreadSummary,
  SupportTicketSummary,
  WorkOrderListItem,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { formatKoreanDateTime } from "../lib/datetime";
import { todayInSeoul } from "../lib/utils";

const WORK_QUEUE_STATUSES: WorkOrderListItem["status"][] = [
  "RECEIVED",
  "ASSIGNED",
  "IN_PROGRESS",
];
const APPROVAL_STATUSES: WorkOrderListItem["status"][] = [
  "REPORT_SUBMITTED",
  "ADMIN_REVIEW",
];
const ADMIN_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;
const DAILY_PLAN_ROLES = [ROLES.MECHANIC, ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;
const MAIL_USE_ROLES = [
  ROLES.RECEPTIONIST,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

type ReadState = "loading" | "ready" | "error";
type MailReadState = "allowed" | "forbidden" | "unavailable";

interface CollaborationData {
  workOrders: WorkOrderListItem[];
  approvals: WorkOrderListItem[];
  dailyPlans: DailyPlanSummary[];
  supportTickets: SupportTicketSummary[];
  messengerThreads: MessengerThreadSummary[];
  mailThreads: MailThreadView[];
  mailState: MailReadState;
}

interface CalendarEntry {
  id: string;
  dateLabel: string;
  title: string;
  meta: string;
  kind: keyof typeof ko.collaboration.calendar.kinds;
  href: string;
}

function addDaysToSeoulDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function dateOnly(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 10);
}

function upcomingPlans(
  plans: DailyPlanSummary[],
  today: string,
  weekEnd: string,
): DailyPlanSummary[] {
  return plans.filter((plan) => {
    if (!plan.plan_date) return false;
    if (plan.status !== "DRAFT" && plan.status !== "REQUESTED") return false;
    return plan.plan_date >= today && plan.plan_date <= weekEnd;
  });
}

function calendarEntries(
  data: CollaborationData,
  today: string,
  weekEnd: string,
): CalendarEntry[] {
  const plans = upcomingPlans(data.dailyPlans, today, weekEnd).map((plan) => ({
    id: `plan-${plan.id ?? plan.plan_date ?? "unknown"}`,
    dateLabel: plan.plan_date ?? ko.common.notSet,
    title: ko.collaboration.calendar.planTitle(plan.status ?? "DRAFT"),
    meta: ko.collaboration.calendar.planMeta(plan.mechanic_id ? 1 : 0),
    kind: "plan" as const,
    href: plan.id ? `/daily-plan?planId=${plan.id}` : "/daily-plan",
  }));
  const work = data.workOrders
    .filter((workOrder) => {
      const due = dateOnly(workOrder.target_due_at);
      return due !== undefined && due >= today && due <= weekEnd;
    })
    .map((workOrder) => ({
      id: `wo-${workOrder.id}`,
      dateLabel: workOrder.target_due_at ? formatKoreanDateTime(workOrder.target_due_at) : ko.common.notSet,
      title: workOrder.request_no,
      meta: `${workOrder.customer.name} · ${workOrder.site.name}`,
      kind: "work" as const,
      href: `/work-orders/${workOrder.id}`,
    }));
  const approvals = data.approvals.slice(0, 5).map((workOrder) => ({
    id: `approval-${workOrder.id}`,
    dateLabel: formatKoreanDateTime(workOrder.updated_at),
    title: ko.collaboration.calendar.approvalTitle(workOrder.request_no),
    meta: `${workOrder.customer.name} · ${workOrder.site.name}`,
    kind: "approval" as const,
    href: "/approvals",
  }));
  const support = data.supportTickets
    .filter((ticket) => ticket.status !== "CLOSED" && !ticket.closed_at)
    .slice(0, 5)
    .map((ticket) => ({
      id: `support-${ticket.id}`,
      dateLabel: ticket.due_at ? formatKoreanDateTime(ticket.due_at) : formatKoreanDateTime(ticket.updated_at),
      title: ticket.title,
      meta: ticket.assignee_name ?? ticket.requester_name ?? ko.collaboration.unassigned,
      kind: "support" as const,
      href: "/support",
    }));
  return [...plans, ...work, ...approvals, ...support].slice(0, 12);
}

function MetricCard({
  title,
  value,
  description,
  icon,
}: {
  title: string;
  value: number | string;
  description: string;
  icon: ReactNode;
}) {
  return (
    <Card className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-steel">{title}</span>
        <span className="rounded-lg bg-brand-teal/10 p-2 text-brand-teal">{icon}</span>
      </div>
      <strong className="text-3xl font-black tabular-nums text-ink">{value}</strong>
      <p className="text-sm text-steel">{description}</p>
    </Card>
  );
}

function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <p className="mt-1 text-sm text-steel">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

export function CollaborationPage() {
  const { api, session } = useAuth();
  const roles = useMemo(() => session?.roles ?? [], [session?.roles]);
  const canApprove = hasAnyRole(roles, ADMIN_ROLES);
  const canDailyPlan = hasAnyRole(roles, DAILY_PLAN_ROLES);
  const canUseMail = hasAnyRole(roles, MAIL_USE_ROLES);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [data, setData] = useState<CollaborationData>({
    workOrders: [],
    approvals: [],
    dailyPlans: [],
    supportTickets: [],
    messengerThreads: [],
    mailThreads: [],
    mailState: canUseMail ? "allowed" : "forbidden",
  });

  const loadCollaboration = useCallback(async () => {
    setReadState("loading");
    try {
      const [
        workOrderRes,
        approvalRes,
        dailyPlanRes,
        supportRes,
        messengerRes,
        mailRes,
      ] = await Promise.all([
        api.GET("/api/v1/work-orders", {
          params: { query: { status: WORK_QUEUE_STATUSES, limit: 20, offset: 0 } },
        }),
        canApprove
          ? api.GET("/api/v1/work-orders", {
              params: { query: { status: APPROVAL_STATUSES, limit: 20, offset: 0 } },
            })
          : Promise.resolve(undefined),
        canDailyPlan
          ? api.GET("/api/daily-work-plans", { params: { query: {} } })
          : Promise.resolve(undefined),
        api.GET("/api/v1/support/tickets", {
          params: {
            query: { status: "OPEN", include_untriaged: true, limit: 10 },
          },
        }),
        api.GET("/api/messenger/threads", { params: { query: { limit: 10 } } }),
        canUseMail
          ? api.GET("/api/v1/mail/threads", {
              params: { query: { limit: 10 } },
            })
          : Promise.resolve(undefined),
      ]);

      if (!workOrderRes.data || !supportRes.data || !messengerRes.data) {
        setReadState("error");
        return;
      }
      if (canApprove && !approvalRes?.data) {
        setReadState("error");
        return;
      }
      if (canDailyPlan && !dailyPlanRes?.data) {
        setReadState("error");
        return;
      }

      const mailState: MailReadState = !canUseMail
        ? "forbidden"
        : mailRes?.response.status === 503
          ? "unavailable"
          : "allowed";
      const mailThreads = mailState === "allowed" && mailRes?.data ? mailRes.data : [];

      setData({
        workOrders: workOrderRes.data.items,
        approvals: approvalRes?.data?.items ?? [],
        dailyPlans: dailyPlanRes?.data?.items ?? [],
        supportTickets: supportRes.data.items,
        messengerThreads: messengerRes.data.items,
        mailThreads,
        mailState,
      });
      setReadState("ready");
    } catch {
      setReadState("error");
    }
  }, [api, canApprove, canDailyPlan, canUseMail]);

  useEffect(() => {
    void Promise.resolve().then(loadCollaboration);
  }, [loadCollaboration]);

  const today = todayInSeoul();
  const weekEnd = addDaysToSeoulDate(today, 6);
  const entries = useMemo(
    () => calendarEntries(data, today, weekEnd),
    [data, today, weekEnd],
  );
  const unreadMailCount = data.mailThreads.reduce(
    (sum, thread) => sum + thread.unread_count,
    0,
  );
  const openSupportCount = data.supportTickets.filter(
    (ticket) => ticket.status !== "CLOSED" && !ticket.closed_at,
  ).length;

  return (
    <>
      <PageHeader
        title={ko.collaboration.title}
        description={ko.collaboration.description}
        actions={
          <Button type="button" variant="secondary" onClick={() => { void loadCollaboration(); }}>
            <RefreshCw size={16} aria-hidden="true" />
            {ko.page.refresh}
          </Button>
        }
      />
      {readState === "loading" ? (
        <SkeletonCards count={4} lines={3} />
      ) : readState === "error" ? (
        <PageError message={ko.collaboration.loadFailed} onRetry={() => { void loadCollaboration(); }} />
      ) : (
        <div className="grid gap-5">
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label={ko.collaboration.metricsLabel}>
            <MetricCard
              title={ko.collaboration.metrics.messages}
              value={data.messengerThreads.length}
              description={ko.collaboration.metrics.messagesHelp}
              icon={<MessageSquare size={18} aria-hidden="true" />}
            />
            <MetricCard
              title={ko.collaboration.metrics.mail}
              value={data.mailState === "allowed" ? unreadMailCount : "—"}
              description={
                data.mailState === "forbidden"
                  ? ko.collaboration.mail.forbidden
                  : data.mailState === "unavailable"
                    ? ko.collaboration.mail.unavailable
                    : ko.collaboration.metrics.mailHelp
              }
              icon={<Mail size={18} aria-hidden="true" />}
            />
            <MetricCard
              title={ko.collaboration.metrics.calendar}
              value={entries.length}
              description={ko.collaboration.metrics.calendarHelp}
              icon={<CalendarDays size={18} aria-hidden="true" />}
            />
            <MetricCard
              title={ko.collaboration.metrics.polls}
              value={openSupportCount + data.approvals.length}
              description={ko.collaboration.metrics.pollsHelp}
              icon={<CheckSquare size={18} aria-hidden="true" />}
            />
          </section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(22rem,0.8fr)]">
            <SectionCard
              title={ko.collaboration.calendar.title}
              description={ko.collaboration.calendar.description}
              action={
                <div className="flex flex-wrap gap-2" aria-label={ko.collaboration.calendar.scopesLabel}>
                  {ko.collaboration.calendar.scopes.map((scope) => (
                    <Badge key={scope} className="border-brand-teal/30 bg-brand-teal/10 text-brand-teal">
                      {scope}
                    </Badge>
                  ))}
                </div>
              }
            >
              {entries.length === 0 ? (
                <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                  {ko.collaboration.calendar.empty}
                </p>
              ) : (
                <div className="grid gap-2" role="list" aria-label={ko.collaboration.calendar.listLabel}>
                  {entries.map((entry) => (
                    <Link
                      key={entry.id}
                      to={entry.href}
                      role="listitem"
                      className="grid gap-2 rounded-lg border border-line bg-white p-3 transition hover:border-brand-teal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal sm:grid-cols-[8rem_1fr_auto]"
                    >
                      <time className="text-sm font-semibold text-steel">{entry.dateLabel}</time>
                      <span>
                        <span className="block font-semibold text-ink">{entry.title}</span>
                        <span className="text-sm text-steel">{entry.meta}</span>
                      </span>
                      <Badge>{ko.collaboration.calendar.kinds[entry.kind]}</Badge>
                    </Link>
                  ))}
                </div>
              )}
            </SectionCard>

            <div className="grid gap-5">
              <SectionCard
                title={ko.collaboration.messenger.title}
                description={ko.collaboration.messenger.description}
                action={
                  <Button asChild type="button" variant="secondary" size="sm">
                    <Link to="/messenger">{ko.collaboration.openMessenger}</Link>
                  </Button>
                }
              >
                <div className="grid gap-2">
                  {data.messengerThreads.length === 0 ? (
                    <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                      {ko.collaboration.messenger.empty}
                    </p>
                  ) : (
                    data.messengerThreads.slice(0, 4).map((thread) => (
                      <div key={thread.id} className="rounded-lg border border-line p-3">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="text-sm text-ink">
                            {thread.title?.trim() || ko.messenger.untitled[thread.kind]}
                          </strong>
                          <Badge>{ko.messenger.kinds[thread.kind]}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-steel">
                          {ko.collaboration.messenger.memberCount(thread.member_count)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </SectionCard>

              <SectionCard
                title={ko.collaboration.mail.title}
                description={ko.collaboration.mail.description}
                action={
                  data.mailState === "allowed" ? (
                    <Button asChild type="button" variant="secondary" size="sm">
                      <Link to="/mail">{ko.collaboration.openMail}</Link>
                    </Button>
                  ) : null
                }
              >
                <div className="grid gap-2">
                  {data.mailState === "forbidden" ? (
                    <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                      {ko.collaboration.mail.forbidden}
                    </p>
                  ) : data.mailState === "unavailable" ? (
                    <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                      {ko.collaboration.mail.unavailable}
                    </p>
                  ) : data.mailThreads.length === 0 ? (
                    <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                      {ko.collaboration.mail.empty}
                    </p>
                  ) : (
                    data.mailThreads.slice(0, 4).map((thread) => (
                      <div key={thread.id} className="rounded-lg border border-line p-3">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="text-sm text-ink">
                            {thread.subject || ko.mailbox.noSubject}
                          </strong>
                          {thread.unread_count > 0 ? (
                            <Badge>{ko.mailbox.unreadCount(thread.unread_count)}</Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-steel">
                          {ko.mailbox.messageCount(thread.message_count)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </SectionCard>
            </div>
          </div>

          <SectionCard
            title={ko.collaboration.polls.title}
            description={ko.collaboration.polls.description}
            action={
              <Badge className="border-amber-300 bg-amber-50 text-amber-800">
                {ko.collaboration.polls.backendGate}
              </Badge>
            }
          >
            <div className="grid gap-3 md:grid-cols-3">
              {ko.collaboration.polls.controls.map((control) => (
                <div key={control.title} className="rounded-lg border border-line bg-white p-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-muted-panel p-2 text-ink">
                      {control.icon === "audience" ? (
                        <Users size={16} aria-hidden="true" />
                      ) : control.icon === "support" ? (
                        <LifeBuoy size={16} aria-hidden="true" />
                      ) : (
                        <ShieldCheck size={16} aria-hidden="true" />
                      )}
                    </span>
                    <h3 className="font-semibold text-ink">{control.title}</h3>
                  </div>
                  <p className="mt-2 text-sm text-steel">{control.description}</p>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-brand-teal/20 bg-brand-teal/5 p-4">
              <div className="flex items-start gap-3">
                <Inbox className="mt-0.5 text-brand-teal" size={18} aria-hidden="true" />
                <div>
                  <h3 className="font-semibold text-ink">{ko.collaboration.workflow.title}</h3>
                  <p className="mt-1 text-sm text-steel">{ko.collaboration.workflow.description}</p>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>
      )}
    </>
  );
}
