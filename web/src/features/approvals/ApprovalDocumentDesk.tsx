import {
  CalendarCheck,
  CheckSquare,
  ClipboardCheck,
  FileText,
  Mail,
  Receipt,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

import type {
  ApprovalItem,
  HrReadinessSummary,
  LeaveBalancePage,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { approvalDocumentDeskKo as copy } from "../../i18n/hrWorkflows";
import { toneBadgeClass } from "../../lib/semantic";
import { formatListCount } from "../../lib/utils";

interface ApprovalDocumentDeskProps {
  items: ApprovalItem[];
  readinessSummary?: HrReadinessSummary;
  leaveBalances?: LeaveBalancePage;
}

const completedStatuses = new Set([
  "APPROVED",
  "ADMIN_APPROVED",
  "EXECUTIVE_APPROVED",
  "COMPLETED",
]);

const documentTemplates = [
  {
    key: "annual-leave",
    content: copy.templates.annualLeave,
    Icon: CalendarCheck,
    href: "/approvals/new?template=annual-leave",
    tone: "success",
  },
  {
    key: "outing-business-trip",
    content: copy.templates.outingBusinessTrip,
    Icon: Users,
    href: "/approvals/new?template=outing-business-trip",
    tone: "info",
  },
  {
    key: "draft",
    content: copy.templates.draft,
    Icon: FileText,
    href: "/approvals/new?template=draft",
    tone: "accent",
  },
  {
    key: "report",
    content: copy.templates.report,
    Icon: ClipboardCheck,
    href: "/approvals/new?template=report",
    tone: "neutral",
  },
  {
    key: "minutes",
    content: copy.templates.minutes,
    Icon: CheckSquare,
    href: "/approvals/new?template=minutes",
    tone: "info",
  },
  {
    key: "expense",
    content: copy.templates.expense,
    Icon: Receipt,
    href: "/approvals/new?template=expense",
    tone: "warning",
  },
] as const;

export function ApprovalDocumentDesk({
  items,
  readinessSummary,
  leaveBalances,
}: ApprovalDocumentDeskProps) {
  const pendingItems = items.filter((item) => !completedStatuses.has(item.status));
  const completedItems = items.length - pendingItems.length;
  const leaveSummary = leaveBalances?.summary;
  const annualLeave = readinessSummary?.annual_leave;
  const payroll = readinessSummary?.payroll;
  const attendance = readinessSummary?.attendance;

  const overviewCards = [
    {
      label: copy.overview.pendingDocuments,
      value: formatListCount(pendingItems.length),
      meta: copy.overview.completedMeta(formatListCount(completedItems)),
    },
    {
      label: copy.overview.leavePromotion,
      value: formatListCount(annualLeave?.usage_promotion_required ?? 0),
      meta: copy.overview.reviewNeededMeta(
        formatListCount(annualLeave?.needs_review ?? 0),
      ),
    },
    {
      label: copy.overview.remainingLeave,
      value: leaveSummary?.remaining ?? annualLeave?.remaining_days ?? "0",
      meta: copy.overview.leaveSummaryMeta(
        leaveSummary?.used ?? "0",
        leaveSummary?.accrued ?? "0",
      ),
    },
    {
      label: copy.overview.attendancePayroll,
      value: formatListCount(payroll?.attendance_event_links ?? 0),
      meta: copy.overview.payrollSourceMeta(
        formatListCount(payroll?.payroll_source_rows ?? 0),
      ),
    },
  ];

  return (
    <Card
      className="grid gap-5"
      aria-labelledby="approval-document-desk-title"
      role="region"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="approval-document-desk-title"
            className="text-lg font-semibold text-ink"
          >
            {copy.title}
          </h2>
          <p className="text-sm text-steel">{copy.description}</p>
        </div>
        <Badge className={toneBadgeClass("success")}>{copy.badge}</Badge>
      </div>

      <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {overviewCards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-line bg-muted-panel/40 p-3"
          >
            <dt className="text-xs font-semibold text-steel">{card.label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-ink">
              {card.value}
            </dd>
            <dd className="mt-1 text-xs text-steel">{card.meta}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-3 xl:grid-cols-2">
        {documentTemplates.map(({ key, content, Icon, href, tone }) => (
          <article
            key={key}
            className="grid gap-3 rounded-lg border border-line bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Icon size={18} aria-hidden="true" className="text-brand-teal" />
                  <h3 className="font-semibold text-ink">{content.title}</h3>
                </div>
                <p className="mt-2 text-sm text-steel">{content.integration}</p>
              </div>
              <Badge className={toneBadgeClass(tone)}>
                {content.approvalLine}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {content.requiredFields.map((field) => (
                <Badge key={field}>{field}</Badge>
              ))}
            </div>
            <Button
              asChild
              size="sm"
              variant="secondary"
              className="justify-self-start"
            >
              <Link to={href}>{copy.openLinkedScreen}</Link>
            </Button>
          </article>
        ))}
      </div>

      <div className="grid gap-3 rounded-lg border border-line bg-muted-panel/40 p-4 lg:grid-cols-3">
        <LinkedCheck
          Icon={ShieldCheck}
          title={copy.linkedChecks.approvalLine.title}
          detail={copy.linkedChecks.approvalLine.detail}
        />
        <LinkedCheck
          Icon={CalendarCheck}
          title={copy.linkedChecks.leaveAttendance.title}
          detail={copy.linkedChecks.leaveAttendance.detail(
            formatListCount(annualLeave?.obligations ?? 0),
            formatListCount(attendance?.durable_events ?? 0),
          )}
        />
        <LinkedCheck
          Icon={Mail}
          title={copy.linkedChecks.mail.title}
          detail={copy.linkedChecks.mail.detail}
        />
      </div>
    </Card>
  );
}

function LinkedCheck({
  Icon,
  title,
  detail,
}: {
  Icon: LucideIcon;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-brand-teal/20 bg-brand-teal/5 text-brand-teal">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div>
        <p className="font-semibold text-ink">{title}</p>
        <p className="mt-1 text-sm text-steel">{detail}</p>
      </div>
    </div>
  );
}
