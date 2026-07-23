import type { InspectionScheduleSummary } from "../../api/types";

export type InspectionScheduleFilter =
  "ALL" | "SCHEDULED" | "OVERDUE" | "COMPLETED";

export function isInspectionOverdue(
  schedule: InspectionScheduleSummary,
  businessDate: string,
): boolean {
  return schedule.status === "SCHEDULED" && schedule.due_date < businessDate;
}

export function filterInspectionSchedules(
  schedules: readonly InspectionScheduleSummary[],
  filter: InspectionScheduleFilter,
  businessDate: string,
): InspectionScheduleSummary[] {
  return schedules.filter((schedule) => {
    switch (filter) {
      case "ALL":
        return true;
      case "SCHEDULED":
        return schedule.status === "SCHEDULED";
      case "OVERDUE":
        return isInspectionOverdue(schedule, businessDate);
      case "COMPLETED":
        return schedule.status === "COMPLETED";
    }
  });
}

export interface InspectionScheduleMetrics {
  scheduled: number;
  overdue: number;
  completed: number;
}

export function inspectionScheduleMetrics(
  schedules: readonly InspectionScheduleSummary[],
  businessDate: string,
): InspectionScheduleMetrics {
  return schedules.reduce<InspectionScheduleMetrics>(
    (metrics, schedule) => {
      if (schedule.status === "SCHEDULED") metrics.scheduled += 1;
      if (schedule.status === "COMPLETED") metrics.completed += 1;
      if (isInspectionOverdue(schedule, businessDate)) metrics.overdue += 1;
      return metrics;
    },
    { scheduled: 0, overdue: 0, completed: 0 },
  );
}
