import {
  CalendarCheck,
  CheckSquare,
  Clock3,
  GitPullRequestDraft,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router";

import type {
  ApprovalItem,
  ApprovalItemSource,
  DailyPlanSummary,
  TargetChangeRequestSummary,
  WorkOrderListItem,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import { formatKoreanDate, formatKoreanDateTime } from "../../lib/datetime";

export type ApprovalSourceKey = "workOrders" | "dailyPlans" | "targetChanges";

interface ApprovalCommandCenterProps {
  items: ApprovalItem[];
  workOrders: WorkOrderListItem[];
  dailyPlans: DailyPlanSummary[];
  targetChanges: TargetChangeRequestSummary[];
  sources: ApprovalItemSource[];
}

function requestedDailyPlans(plans: DailyPlanSummary[]): DailyPlanSummary[] {
  return plans.filter((plan) => plan.status === "REQUESTED");
}

function countLabel(count: number): string {
  return count === 0 ? ko.approvals.commandCenter.none : String(count);
}

const sourceOrder: Record<ApprovalItem["source"], number> = {
  WORK_ORDER: 0,
  DAILY_PLAN: 1,
  TARGET_CHANGE: 2,
};

function statusLabel(status: string): string {
  if (status in ko.status) {
    return ko.status[status as keyof typeof ko.status];
  }
  const approvalStatus = (
    ko.approvals.targetChange.statuses as Partial<Record<string, string>>
  )[status];
  return approvalStatus ?? status;
}

function actionLabel(actionKey: string): string {
  const mapped = (
    ko.approvals.actionLabels as Partial<Record<string, string>>
  )[actionKey];
  return mapped ?? actionKey;
}

function isCompletedStatus(status: string): boolean {
  return ["APPROVED", "ADMIN_APPROVED", "EXECUTIVE_APPROVED", "COMPLETED"].includes(status);
}

function scopeLabel(scopeKind: string): string {
  const mapped = (
    ko.approvals.scopeLabels as Partial<Record<string, string>>
  )[scopeKind];
  return mapped ?? scopeKind;
}

function timeRank(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function formatDecisionTime(value: string | null | undefined): string {
  return value ? formatKoreanDateTime(value) : ko.approvals.commandCenter.noDueAt;
}

export function ApprovalCommandCenter({
  items,
  workOrders,
  dailyPlans,
  targetChanges,
  sources,
}: ApprovalCommandCenterProps) {
  const t = ko.approvals.commandCenter;
  const pendingPlans = requestedDailyPlans(dailyPlans);
  const nextDecisions = [...items]
    .sort((left, right) => {
      const dueDiff = timeRank(left.due_at) - timeRank(right.due_at);
      if (dueDiff !== 0) return dueDiff;
      const requestedDiff =
        timeRank(left.requested_at) - timeRank(right.requested_at);
      if (requestedDiff !== 0) return requestedDiff;
      return sourceOrder[left.source] - sourceOrder[right.source];
    })
    .slice(0, 5);
  const hasAuthoritativeSources = sources.length > 0;
  const hasDailyPlanSource =
    !hasAuthoritativeSources || sources.some((source) => source.key === "dailyPlans");
  const sourceCount = (key: ApprovalSourceKey, fallback: number) => {
    const source = sources.find((candidate) => candidate.key === key);
    if (source) return source.count;
    return sources.length > 0 ? undefined : fallback;
  };
  const sourceCards = [
    {
      key: "work-reports",
      title: t.sources.workReports.title,
      count: sourceCount("workOrders", workOrders.length),
      href: "#work-order-approval-queue",
      action: t.sources.workReports.action,
      Icon: CheckSquare,
    },
    {
      key: "daily-plans",
      title: t.sources.dailyPlans.title,
      count: sourceCount("dailyPlans", pendingPlans.length),
      href: pendingPlans[0]?.id
        ? `/daily-plan?planId=${pendingPlans[0].id}`
        : "/daily-plan",
      action: t.sources.dailyPlans.action,
      Icon: CalendarCheck,
    },
    {
      key: "target-change",
      title: t.sources.targetChange.title,
      count: sourceCount("targetChanges", targetChanges.length),
      href: "#target-change-review-queue",
      action: t.sources.targetChange.action,
      Icon: GitPullRequestDraft,
    },
  ].flatMap((card) =>
    card.count === undefined ? [] : [{ ...card, count: card.count }],
  );
  const submittedDocumentCount = sourceCards.reduce((sum, card) => sum + card.count, 0);
  const completedApprovalCount = items.filter((item) => isCompletedStatus(item.status)).length;
  const summaryCards = [
    {
      key: "payable",
      label: t.summary.payable,
      value: items.length,
    },
    {
      key: "submitted",
      label: t.summary.submittedDocuments,
      value: submittedDocumentCount,
    },
    {
      key: "completed",
      label: t.summary.completed,
      value: completedApprovalCount,
    },
    {
      key: "other",
      label: t.summary.other,
      value: Math.max(0, items.length - submittedDocumentCount),
    },
  ];

  return (
    <Card
      className="grid gap-5 border-brand-teal/20 bg-brand-teal/5"
      aria-labelledby="approval-command-center-title"
      role="region"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="approval-command-center-title" className="mt-1 text-xl font-semibold text-ink">
            {t.title}
          </h2>
        </div>
        <Badge className="border-brand-teal/20 bg-white text-brand-teal">
          {t.auditBadge}
        </Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {summaryCards.map((card) => (
          <div key={card.key} className="rounded-lg border border-line bg-white p-3">
            <p className="text-xs font-semibold text-steel">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{countLabel(card.value)}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 rounded-lg border border-line bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-ink">{t.nextDecisionsTitle}</h3>
          <Badge className="border-brand-teal/20 bg-brand-teal/5 text-brand-teal">
            {countLabel(items.length)}
          </Badge>
        </div>
        {nextDecisions.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
            {t.empty}
          </p>
        ) : (
          <ol className="grid gap-2" aria-label={t.nextDecisionsLabel}>
            {nextDecisions.map((item) => {
              const sourceLabel = ko.approvals.sourceLabels[item.source];
              return (
                <li
                  key={item.id}
                  className="grid gap-3 rounded-md border border-line bg-muted-panel/30 p-3 lg:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{sourceLabel}</Badge>
                      <Badge className="border-brand-teal/20 bg-brand-teal/5 text-brand-teal">
                        {statusLabel(item.status)}
                      </Badge>
                      <Badge className="border-line bg-white text-steel">
                        <ShieldCheck size={14} aria-hidden="true" />
                        {t.policyBadge}
                      </Badge>
                    </div>
                    <p className="mt-2 font-semibold text-ink">{item.title}</p>
                    <p className="mt-1 text-sm text-steel">{item.summary}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium text-steel">
                      <span className="inline-flex items-center gap-1">
                        <Clock3 size={14} aria-hidden="true" />
                        {t.dueAt}: {formatDecisionTime(item.due_at)}
                      </span>
                      <span>{t.scope}: {scopeLabel(item.policy.scope_kind)}</span>
                      <span>{t.workflow}: {actionLabel(item.workflow.action_key)}</span>
                    </div>
                  </div>
                  <Button asChild size="sm">
                    {item.href.startsWith("#") ? (
                      <a href={item.href} aria-label={`${item.title} ${t.decide}`}>
                        {t.decide}
                      </a>
                    ) : (
                      <Link to={item.href} aria-label={`${item.title} ${t.decide}`}>
                        {t.decide}
                      </Link>
                    )}
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {sourceCards.map(({ key, title, count, href, action, Icon }) => (
          <div
            key={key}
            className="grid gap-3 rounded-lg border border-line bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-ink">{title}</p>
              </div>
              <span className="rounded-full border border-brand-teal/20 bg-brand-teal/10 p-2 text-brand-teal">
                <Icon size={18} aria-hidden="true" />
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge className="border-brand-teal/20 bg-brand-teal/5 text-brand-teal">
                {countLabel(count)}
              </Badge>
              <Button asChild variant="secondary" size="sm">
                {href.startsWith("#") ? (
                  <a href={href}>{action}</a>
                ) : (
                  <Link to={href}>{action}</Link>
                )}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {hasDailyPlanSource ? (
        <div className="grid gap-3 rounded-lg border border-line bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink">{t.dailyPlans.pendingTitle}</h3>
            </div>
            <Badge className="border-brand-teal/20 bg-brand-teal/5 text-brand-teal">
              {countLabel(pendingPlans.length)}
            </Badge>
          </div>
          {pendingPlans.length === 0 ? (
            <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
              {t.dailyPlans.empty}
            </p>
          ) : (
            <ul className="grid gap-2" aria-label={t.dailyPlans.listLabel}>
              {pendingPlans.map((plan) => {
                const date = formatKoreanDate(plan.plan_date);
                return (
                  <li
                    key={plan.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-muted-panel/30 p-3"
                  >
                    <div>
                      <p className="font-semibold text-ink">{date}</p>
                      <p className="text-sm text-steel">{t.dailyPlans.requested}</p>
                    </div>
                    {plan.id ? (
                      <Button asChild variant="secondary" size="sm">
                        <Link
                          to={`/daily-plan?planId=${plan.id}`}
                          aria-label={`${date} ${t.dailyPlans.open}`}
                        >
                          {t.dailyPlans.open}
                        </Link>
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </Card>
  );
}
