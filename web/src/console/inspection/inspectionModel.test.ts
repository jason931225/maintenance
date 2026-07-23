import { describe, expect, it } from "vitest";

import type { InspectionScheduleSummary } from "../../api/types";
import {
  filterInspectionSchedules,
  inspectionScheduleMetrics,
} from "./inspectionModel";

const base: InspectionScheduleSummary = {
  id: "77777777-7777-4777-8777-777777777777",
  branch_id: "00000000-0000-4000-8000-000000000001",
  equipment_id: "00000000-0000-4000-8000-000000000002",
  mechanic_id: "00000000-0000-4000-8000-000000000003",
  mechanic_display_name: "홍정비",
  cycle: "MONTHLY",
  interval_days: 31,
  due_date: "2026-07-01",
  status: "SCHEDULED",
  completed_at: null,
  note: null,
  site_name: "창원 현장",
  management_no: "290",
  model: "GTS25DE",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

describe("inspection schedule model", () => {
  it("derives only returned schedule status counts and overdue rows", () => {
    const schedules = [
      base,
      {
        ...base,
        id: "77777777-7777-4777-8777-777777777778",
        due_date: "2026-07-31",
      },
      {
        ...base,
        id: "77777777-7777-4777-8777-777777777779",
        status: "COMPLETED" as const,
        completed_at: "2026-07-20T03:00:00Z",
      },
    ];

    expect(inspectionScheduleMetrics(schedules, "2026-07-23")).toEqual({
      scheduled: 2,
      overdue: 1,
      completed: 1,
    });
    expect(
      filterInspectionSchedules(schedules, "OVERDUE", "2026-07-23").map(
        ({ id }) => id,
      ),
    ).toEqual([base.id]);
  });
});
