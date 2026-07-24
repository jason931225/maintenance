import {
  CalendarDays,
  CheckSquare,
  Inbox,
  Mail,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Link } from "react-router";

import type {
  ApprovalItem,
  CalendarEventResponse,
  CollaborationScopeType,
  CreateCalendarEventRequest,
  CreatePollRequest,
  DailyPlanSummary,
  MailThreadView,
  MessengerThreadSummary,
  PollAnonymity,
  PollResponse,
  SupportTicketSummary,
  WorkOrderListItem,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import {
  FEATURES,
  hasAnyFeatureGrant,
  hasAnyRole,
  ROLES,
} from "../components/shell/nav";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { isActionableSupportTicket } from "../features/support/support-format";
import { ko } from "../i18n/ko";
import { formatKoreanDateTime } from "../lib/datetime";
import { todayInSeoul } from "../lib/utils";

const WORK_QUEUE_STATUSES: WorkOrderListItem["status"][] = [
  "RECEIVED",
  "ASSIGNED",
  "IN_PROGRESS",
];
const ADMIN_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;
const DAILY_PLAN_ROLES = [
  ROLES.MECHANIC,
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
] as const;
const MAIL_USE_FEATURES = [FEATURES.MAIL_USE] as const;

type ReadState = "loading" | "ready" | "error";
type MailReadState = "allowed" | "forbidden" | "unavailable";

interface CollaborationData {
  workOrders: WorkOrderListItem[];
  approvals: ApprovalItem[];
  dailyPlans: DailyPlanSummary[];
  calendarEvents: CalendarEventResponse[];
  polls: PollResponse[];
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

interface CalendarFormState {
  scopeType: CollaborationScopeType;
  title: string;
  startsAt: string;
  endsAt: string;
  objectType: string;
  objectId: string;
}

interface PollFormState {
  targetScopeType: CollaborationScopeType;
  title: string;
  question: string;
  anonymity: PollAnonymity;
  options: string;
  objectType: string;
  objectId: string;
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

function objectHref(
  objectType: string | null | undefined,
  objectId: string | null | undefined,
): string {
  if (!objectType || !objectId) return "/collaboration";
  switch (objectType) {
    case "work_order":
      return `/work-orders/${objectId}`;
    case "daily_plan":
      return `/daily-plan?planId=${objectId}`;
    case "approval":
      return `/approvals?focus=${objectId}`;
    case "support_ticket":
      return "/support";
    default:
      return "/collaboration";
  }
}

function scopeLabel(scopeType: CollaborationScopeType): string {
  return ko.collaboration.scopes[scopeType];
}

function policyLabel(policy: CalendarEventResponse["policy"]): string {
  return `${scopeLabel(policy.scope_type)} · ${ko.collaboration.policy[policy.visibility]}`;
}

function calendarEntries(
  data: CollaborationData,
  today: string,
  weekEnd: string,
): CalendarEntry[] {
  const apiEvents = data.calendarEvents
    .filter((event) => {
      const starts = dateOnly(event.starts_at);
      const ends = dateOnly(event.ends_at);
      return starts !== undefined && ends !== undefined && starts <= weekEnd && ends >= today;
    })
    .map((event) => ({
      id: `event-${event.id}`,
      dateLabel: event.all_day ? dateOnly(event.starts_at) ?? event.starts_at : formatKoreanDateTime(event.starts_at),
      title: event.title,
      meta: policyLabel(event.policy),
      kind: "event" as const,
      href: objectHref(event.object_type, event.object_id),
    }));
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
      dateLabel: workOrder.target_due_at
        ? formatKoreanDateTime(workOrder.target_due_at)
        : ko.common.notSet,
      title: workOrder.request_no,
      meta: `${workOrder.customer.name} · ${workOrder.site.name}`,
      kind: "work" as const,
      href: `/work-orders/${workOrder.id}`,
    }));
  const approvals = data.approvals.slice(0, 5).map((item) => ({
    id: `approval-${item.id}`,
    dateLabel: item.due_at
      ? formatKoreanDateTime(item.due_at)
      : item.requested_at
        ? formatKoreanDateTime(item.requested_at)
        : ko.common.notSet,
    title: ko.collaboration.calendar.approvalTitle(item.title),
    meta: `${approvalSourceLabel(item.source)} · ${item.summary}`,
    kind: "approval" as const,
    href: approvalHref(item),
  }));
  const support = data.supportTickets
    .filter(isActionableSupportTicket)
    .slice(0, 5)
    .map((ticket) => ({
      id: `support-${ticket.id}`,
      dateLabel: ticket.due_at
        ? formatKoreanDateTime(ticket.due_at)
        : formatKoreanDateTime(ticket.updated_at),
      title: ticket.title,
      meta:
        ticket.assignee_name ??
        ticket.requester_name ??
        ko.collaboration.unassigned,
      kind: "support" as const,
      href: "/support",
    }));
  return [...apiEvents, ...plans, ...work, ...approvals, ...support].slice(0, 16);
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
        <span className="rounded-lg bg-brand-teal/10 p-2 text-brand-teal">
          {icon}
        </span>
      </div>
      <strong className="text-3xl font-black tabular-nums text-ink">
        {value}
      </strong>
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
  const canUseMail = hasAnyFeatureGrant(session?.feature_grants, MAIL_USE_FEATURES);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [mutationError, setMutationError] = useState<string>();
  const [mutationOk, setMutationOk] = useState<string>();
  const [calendarForm, setCalendarForm] = useState<CalendarFormState>(() => {
    const day = todayInSeoul();
    return {
      scopeType: "ORG",
      title: "",
      startsAt: `${day}T09:00`,
      endsAt: `${day}T10:00`,
      objectType: "",
      objectId: "",
    };
  });
  const [pollForm, setPollForm] = useState<PollFormState>({
    targetScopeType: "ORG",
    title: "",
    question: "",
    anonymity: "NAMED",
    options: ko.collaboration.polls.defaultOptions,
    objectType: "",
    objectId: "",
  });
  const [data, setData] = useState<CollaborationData>({
    workOrders: [],
    approvals: [],
    dailyPlans: [],
    calendarEvents: [],
    polls: [],
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
        calendarRes,
        pollRes,
        supportRes,
        messengerRes,
        mailRes,
      ] = await Promise.all([
        api.GET("/api/v1/work-orders", {
          params: {
            query: { status: WORK_QUEUE_STATUSES, limit: 20, offset: 0 },
          },
        }),
        canApprove
          ? api.GET("/api/approval-items", {
              params: { query: { limit: 20, offset: 0 } },
            })
          : Promise.resolve(undefined),
        canDailyPlan
          ? api.GET("/api/daily-work-plans", { params: { query: {} } })
          : Promise.resolve(undefined),
        api.GET("/api/v1/collaboration/calendar/events", {
          params: {
            query: {
              from: `${todayInSeoul()}T00:00:00+09:00`,
              to: `${addDaysToSeoulDate(todayInSeoul(), 6)}T23:59:59+09:00`,
              limit: 50,
            },
          },
        }),
        api.GET("/api/v1/collaboration/polls", {
          params: { query: { status: "OPEN", limit: 20 } },
        }),
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

      if (
        !workOrderRes.data ||
        !calendarRes.data ||
        !pollRes.data ||
        !supportRes.data ||
        !messengerRes.data
      ) {
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
      const mailThreads =
        mailState === "allowed" && mailRes?.data ? mailRes.data : [];

      setData({
        workOrders: workOrderRes.data.items,
        approvals: approvalRes?.data?.items ?? [],
        dailyPlans: dailyPlanRes?.data?.items ?? [],
        calendarEvents: calendarRes.data.items,
        polls: pollRes.data.items,
        supportTickets: supportRes.data.items.filter(isActionableSupportTicket),
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

  const createCalendarEvent = useCallback(
    async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
      event.preventDefault();
      setMutationError(undefined);
      setMutationOk(undefined);
      const objectType = calendarForm.objectType.trim();
      const objectId = calendarForm.objectId.trim();
      const body: CreateCalendarEventRequest = {
        scope_type: calendarForm.scopeType,
        title: calendarForm.title,
        starts_at: new Date(calendarForm.startsAt).toISOString(),
        ends_at: new Date(calendarForm.endsAt).toISOString(),
        all_day: false,
        ...(objectType && objectId
          ? { object_type: objectType, object_id: objectId }
          : {}),
      };
      const response = await api.POST("/api/v1/collaboration/calendar/events", {
        body,
      });
      if (!response.data) {
        setMutationError(ko.collaboration.calendar.createFailed);
        return;
      }
      setData((current) => ({
        ...current,
        calendarEvents: [response.data, ...current.calendarEvents],
      }));
      setCalendarForm((current) => ({ ...current, title: "", objectType: "", objectId: "" }));
      setMutationOk(ko.collaboration.calendar.created);
    },
    [api, calendarForm],
  );

  const createPoll = useCallback(
    async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
      event.preventDefault();
      setMutationError(undefined);
      setMutationOk(undefined);
      const options = pollForm.options
        .split(/\r?\n/)
        .map((option) => option.trim())
        .filter(Boolean);
      const objectType = pollForm.objectType.trim();
      const objectId = pollForm.objectId.trim();
      const body: CreatePollRequest = {
        target_scope_type: pollForm.targetScopeType,
        title: pollForm.title,
        question: pollForm.question,
        status: "OPEN",
        anonymity: pollForm.anonymity,
        allow_multiple: false,
        options,
        ...(objectType && objectId
          ? { object_type: objectType, object_id: objectId }
          : {}),
      };
      const response = await api.POST("/api/v1/collaboration/polls", { body });
      if (!response.data) {
        setMutationError(ko.collaboration.polls.createFailed);
        return;
      }
      setData((current) => ({
        ...current,
        polls: [response.data, ...current.polls],
      }));
      setPollForm((current) => ({ ...current, title: "", question: "", objectType: "", objectId: "" }));
      setMutationOk(ko.collaboration.polls.created);
    },
    [api, pollForm],
  );

  const votePoll = useCallback(
    async (poll: PollResponse, optionId: string) => {
      setMutationError(undefined);
      setMutationOk(undefined);
      const response = await api.POST("/api/v1/collaboration/polls/{id}/vote", {
        params: { path: { id: poll.id } },
        body: { selected_option_ids: [optionId] },
      });
      if (!response.data) {
        setMutationError(ko.collaboration.polls.voteFailed);
        return;
      }
      setData((current) => ({
        ...current,
        polls: current.polls.map((item) =>
          item.id === poll.id ? response.data : item,
        ),
      }));
      setMutationOk(ko.collaboration.polls.voted);
    },
    [api],
  );

  return (
    <>
      <PageHeader
        title={ko.collaboration.title}
        description={ko.collaboration.description}
        actions={
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void loadCollaboration();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {ko.page.refresh}
          </Button>
        }
      />
      {readState === "loading" ? (
        <SkeletonCards count={4} lines={3} />
      ) : readState === "error" ? (
        <PageError
          message={ko.collaboration.loadFailed}
          onRetry={() => {
            void loadCollaboration();
          }}
        />
      ) : (
        <div className="grid gap-5">
          <section
            className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
            aria-label={ko.collaboration.metricsLabel}
          >
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
              value={data.polls.length}
              description={ko.collaboration.metrics.pollsHelp}
              icon={<CheckSquare size={18} aria-hidden="true" />}
            />
          </section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(22rem,0.8fr)]">
            <SectionCard
              title={ko.collaboration.calendar.title}
              description={ko.collaboration.calendar.description}
              action={
                <div
                  className="flex flex-wrap gap-2"
                  aria-label={ko.collaboration.calendar.scopesLabel}
                >
                  {ko.collaboration.calendar.scopes.map((scope) => (
                    <Badge
                      key={scope}
                      className="border-brand-teal/30 bg-brand-teal/10 text-brand-teal"
                    >
                      {scope}
                    </Badge>
                  ))}
                </div>
              }
            >
              <form
                className="grid gap-3 rounded-lg border border-line bg-muted-panel p-3 md:grid-cols-[10rem_1fr_12rem_12rem_auto]"
                onSubmit={(event) => {
                  void createCalendarEvent(event);
                }}
              >
                <label className="grid gap-1 text-sm font-semibold text-steel">
                  {ko.collaboration.scope}
                  <select
                    className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                    value={calendarForm.scopeType}
                    onChange={(event) => {
                      const scopeType = event.currentTarget.value as CollaborationScopeType;
                      setCalendarForm((current) => ({
                        ...current,
                        scopeType,
                      }));
                    }}
                  >
                    {(["PERSONAL", "TEAM", "DEPARTMENT", "ORG", "TENANT"] as const).map((scope) => (
                      <option key={scope} value={scope}>
                        {scopeLabel(scope)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-steel">
                  {ko.collaboration.calendar.eventTitle}
                  <input
                    className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                    value={calendarForm.title}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setCalendarForm((current) => ({
                        ...current,
                        title: value,
                      }));
                    }}
                    required
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-steel">
                  {ko.collaboration.calendar.startsAt}
                  <input
                    type="datetime-local"
                    className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                    value={calendarForm.startsAt}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setCalendarForm((current) => ({
                        ...current,
                        startsAt: value,
                      }));
                    }}
                    required
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-steel">
                  {ko.collaboration.calendar.endsAt}
                  <input
                    type="datetime-local"
                    className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                    value={calendarForm.endsAt}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setCalendarForm((current) => ({
                        ...current,
                        endsAt: value,
                      }));
                    }}
                    required
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-steel md:col-span-2">
                  {ko.collaboration.objectType}
                  <input
                    className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                    placeholder={ko.collaboration.objectTypePlaceholder}
                    value={calendarForm.objectType}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setCalendarForm((current) => ({
                        ...current,
                        objectType: value,
                      }));
                    }}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-steel md:col-span-2">
                  {ko.collaboration.objectId}
                  <input
                    className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                    placeholder={ko.collaboration.objectIdPlaceholder}
                    value={calendarForm.objectId}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setCalendarForm((current) => ({
                        ...current,
                        objectId: value,
                      }));
                    }}
                  />
                </label>
                <Button type="submit" size="sm" className="self-end">
                  {ko.collaboration.calendar.create}
                </Button>
              </form>
              {entries.length === 0 ? (
                <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                  {ko.collaboration.calendar.empty}
                </p>
              ) : (
                <div
                  className="grid gap-2"
                  role="list"
                  aria-label={ko.collaboration.calendar.listLabel}
                >
                  {entries.map((entry) => (
                    <Link
                      key={entry.id}
                      to={entry.href}
                      role="listitem"
                      className="grid gap-2 rounded-lg border border-line bg-white p-3 transition hover:border-brand-teal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal sm:grid-cols-[8rem_1fr_auto]"
                    >
                      <time className="text-sm font-semibold text-steel">
                        {entry.dateLabel}
                      </time>
                      <span>
                        <span className="block font-semibold text-ink">
                          {entry.title}
                        </span>
                        <span className="text-sm text-steel">{entry.meta}</span>
                      </span>
                      <Badge>
                        {ko.collaboration.calendar.kinds[entry.kind]}
                      </Badge>
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
                    <Link to="/messenger">
                      {ko.collaboration.openMessenger}
                    </Link>
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
                      <div
                        key={thread.id}
                        className="rounded-lg border border-line p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <strong className="text-sm text-ink">
                            {thread.title?.trim() ||
                              ko.messenger.untitled[thread.kind]}
                          </strong>
                          <Badge>{ko.messenger.kinds[thread.kind]}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-steel">
                          {ko.collaboration.messenger.memberCount(
                            thread.member_count,
                          )}
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
                      <div
                        key={thread.id}
                        className="rounded-lg border border-line p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <strong className="text-sm text-ink">
                            {thread.subject || ko.mailbox.noSubject}
                          </strong>
                          {thread.unread_count > 0 ? (
                            <Badge>
                              {ko.mailbox.unreadCount(thread.unread_count)}
                            </Badge>
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
            action={<Badge>{ko.collaboration.polls.backendReady}</Badge>}
          >
            {mutationError ? (
              <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {mutationError}
              </p>
            ) : null}
            {mutationOk ? (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                {mutationOk}
              </p>
            ) : null}
            <form
              className="grid gap-3 rounded-lg border border-line bg-muted-panel p-3 lg:grid-cols-[10rem_minmax(12rem,1fr)_minmax(12rem,1fr)_12rem_auto]"
              onSubmit={(event) => {
                void createPoll(event);
              }}
            >
              <label className="grid gap-1 text-sm font-semibold text-steel">
                {ko.collaboration.scope}
                <select
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                  value={pollForm.targetScopeType}
                  onChange={(event) => {
                    const targetScopeType = event.currentTarget.value as CollaborationScopeType;
                    setPollForm((current) => ({
                      ...current,
                      targetScopeType,
                    }));
                  }}
                >
                  {(["TEAM", "DEPARTMENT", "ORG", "TENANT"] as const).map((scope) => (
                    <option key={scope} value={scope}>
                      {scopeLabel(scope)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-steel">
                {ko.collaboration.polls.pollTitle}
                <input
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                  value={pollForm.title}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setPollForm((current) => ({
                      ...current,
                      title: value,
                    }));
                  }}
                  required
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-steel">
                {ko.collaboration.polls.question}
                <input
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                  value={pollForm.question}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setPollForm((current) => ({
                      ...current,
                      question: value,
                    }));
                  }}
                  required
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-steel">
                {ko.collaboration.polls.anonymity}
                <select
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                  value={pollForm.anonymity}
                  onChange={(event) => {
                    const anonymity = event.currentTarget.value as PollAnonymity;
                    setPollForm((current) => ({
                      ...current,
                      anonymity,
                    }));
                  }}
                >
                  <option value="NAMED">{ko.collaboration.polls.named}</option>
                  <option value="ANONYMOUS">{ko.collaboration.polls.anonymous}</option>
                </select>
              </label>
              <Button type="submit" size="sm" className="self-end">
                {ko.collaboration.polls.create}
              </Button>
              <label className="grid gap-1 text-sm font-semibold text-steel lg:col-span-5">
                {ko.collaboration.polls.options}
                <textarea
                  className="min-h-20 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                  value={pollForm.options}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setPollForm((current) => ({
                      ...current,
                      options: value,
                    }));
                  }}
                  required
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-steel lg:col-span-2">
                {ko.collaboration.objectType}
                <input
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                  placeholder={ko.collaboration.objectTypePlaceholder}
                  value={pollForm.objectType}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setPollForm((current) => ({
                      ...current,
                      objectType: value,
                    }));
                  }}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-steel lg:col-span-3">
                {ko.collaboration.objectId}
                <input
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                  placeholder={ko.collaboration.objectIdPlaceholder}
                  value={pollForm.objectId}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    setPollForm((current) => ({
                      ...current,
                      objectId: value,
                    }));
                  }}
                />
              </label>
            </form>
            {data.polls.length === 0 ? (
              <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                {ko.collaboration.polls.empty}
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {data.polls.map((poll) => (
                  <article key={poll.id} className="rounded-lg border border-line bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-ink">{poll.title}</h3>
                        <p className="mt-1 text-sm text-steel">{poll.question}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge>{scopeLabel(poll.target_scope_type)}</Badge>
                        <Badge>
                          {poll.anonymity === "ANONYMOUS"
                            ? ko.collaboration.polls.anonymous
                            : ko.collaboration.polls.named}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2">
                      {poll.options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-left text-sm transition hover:border-brand-teal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal"
                          onClick={() => {
                            void votePoll(poll, option.id);
                          }}
                        >
                          <span className="font-medium text-ink">{option.label}</span>
                          <span className="text-steel">
                            {ko.collaboration.polls.votes(option.vote_count)}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-steel">
                      {ko.collaboration.polls.policy(
                        policyLabel(poll.policy),
                        poll.vote_count,
                      )}
                    </p>
                  </article>
                ))}
              </div>
            )}
            <div className="rounded-lg border border-brand-teal/20 bg-brand-teal/5 p-4">
              <div className="flex items-start gap-3">
                <Inbox
                  className="mt-0.5 text-brand-teal"
                  size={18}
                  aria-hidden="true"
                />
                <div>
                  <h3 className="font-semibold text-ink">
                    {ko.collaboration.workflow.title}
                  </h3>
                  <p className="mt-1 text-sm text-steel">
                    {ko.collaboration.workflow.description}
                  </p>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>
      )}
    </>
  );
}
