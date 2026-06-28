import { CalendarCheck, CheckSquare, GitPullRequestDraft } from "lucide-react";
import { Link } from "react-router-dom";

import type {
  ApprovalItemSource,
  DailyPlanSummary,
  TargetChangeRequestSummary,
  WorkOrderListItem,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import { formatKoreanDate } from "../../lib/datetime";

export type ApprovalSourceKey = "workOrders" | "dailyPlans" | "targetChanges";

interface ApprovalCommandCenterProps {
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

export function ApprovalCommandCenter({
  workOrders,
  dailyPlans,
  targetChanges,
  sources,
}: ApprovalCommandCenterProps) {
  const t = ko.approvals.commandCenter;
  const pendingPlans = requestedDailyPlans(dailyPlans);
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
      description: t.sources.workReports.description,
      count: sourceCount("workOrders", workOrders.length),
      href: "#work-order-approval-queue",
      action: t.sources.workReports.action,
      Icon: CheckSquare,
    },
    {
      key: "daily-plans",
      title: t.sources.dailyPlans.title,
      description: t.sources.dailyPlans.description,
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
      description: t.sources.targetChange.description,
      count: sourceCount("targetChanges", targetChanges.length),
      href: "#target-change-review-queue",
      action: t.sources.targetChange.action,
      Icon: GitPullRequestDraft,
    },
  ].flatMap((card) =>
    card.count === undefined ? [] : [{ ...card, count: card.count }],
  );

  return (
    <Card
      className="grid gap-5 border-brand-teal/20 bg-brand-teal/5"
      aria-labelledby="approval-command-center-title"
      role="region"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-brand-teal">{t.eyebrow}</p>
          <h2 id="approval-command-center-title" className="mt-1 text-xl font-semibold text-ink">
            {t.title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-steel">{t.description}</p>
        </div>
        <Badge className="border-brand-teal/20 bg-white text-brand-teal">
          {t.auditBadge}
        </Badge>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {sourceCards.map(({ key, title, description, count, href, action, Icon }) => (
          <div
            key={key}
            className="grid gap-3 rounded-lg border border-line bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-ink">{title}</p>
                <p className="mt-1 text-sm text-steel">{description}</p>
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
              <p className="mt-1 text-sm text-steel">{t.dailyPlans.pendingDescription}</p>
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
