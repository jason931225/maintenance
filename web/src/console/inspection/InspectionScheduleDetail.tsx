import type { InspectionScheduleSummary } from "../../api/types";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { safeLabel } from "../../lib/utils";
import "./inspection.css";

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
    <aside aria-label={ko.inspection.listTitle} className="inspection-detail">
      <div className="inspection-detail__head">
        <div>
          <h2>
            {safeLabel(
              schedule.management_no,
              schedule.model,
              ko.common.noNumber,
            )}
          </h2>
          <p>{schedule.site_name}</p>
        </div>
        <span
          className={
            overdue
              ? "inspection-chip inspection-chip--danger"
              : "inspection-chip"
          }
        >
          {statusLabel}
        </span>
      </div>
      <dl className="inspection-detail__facts">
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
        <div className="inspection-detail__note">
          <span>{ko.inspection.fields.note}</span>
          <p>{schedule.note}</p>
        </div>
      ) : null}
    </aside>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}
