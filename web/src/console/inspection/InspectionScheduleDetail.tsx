import type { InspectionScheduleSummary } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { formatKoreanDateTime } from "../../lib/datetime";
import { safeLabel } from "../../lib/utils";
import { ko } from "../../i18n/ko";

interface InspectionScheduleDetailProps {
  schedule: InspectionScheduleSummary;
  overdue: boolean;
}

export function InspectionScheduleDetail({
  schedule,
  overdue,
}: InspectionScheduleDetailProps) {
  const statusLabel = overdue
    ? ko.inspection.overdue
    : ko.inspection.statuses[schedule.status];

  return (
    <aside
      aria-label={ko.inspection.listTitle}
      className="grid content-start gap-4 rounded-md border border-line bg-muted-panel p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <h2 className="text-base font-semibold text-ink">
            {safeLabel(
              schedule.management_no,
              schedule.model,
              ko.common.noNumber,
            )}
          </h2>
          <p className="text-sm text-steel">{schedule.site_name}</p>
        </div>
        <Badge
          className={
            overdue ? "border-red-300 bg-red-50 text-red-800" : undefined
          }
        >
          {statusLabel}
        </Badge>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Detail
          term={ko.inspection.fields.cycle}
          value={ko.inspection.cycles[schedule.cycle]}
        />
        <Detail
          term={ko.inspection.fields.intervalDays}
          value={String(schedule.interval_days)}
        />
        <Detail term={ko.inspection.fields.dueDate} value={schedule.due_date} />
        <Detail
          term={ko.inspection.fields.mechanic}
          value={safeLabel(schedule.mechanic_display_name)}
        />
        <Detail
          term={ko.inspection.round.complete}
          value={formatKoreanDateTime(schedule.completed_at)}
        />
      </dl>

      {schedule.note ? (
        <div className="grid gap-1 border-t border-line pt-3">
          <span className="text-xs font-medium text-steel">
            {ko.inspection.fields.note}
          </span>
          <p className="whitespace-pre-wrap text-sm text-ink">
            {schedule.note}
          </p>
        </div>
      ) : null}
    </aside>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-steel">{term}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}
