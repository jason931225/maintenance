import { useCallback, useEffect, useRef, useState } from "react";

import type {
  InspectionRoundOutcome,
  InspectionScheduleSummary,
} from "../../api/types";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { safeLabel, todayInSeoul } from "../../lib/utils";
import { isInspectionOverdue } from "./inspectionModel";
import "./inspection.css";

const PAGE_SIZE = 100;

/**
 * Mechanic-only execution surface. Its source is the server-side `my-schedules`
 * projection, which binds rows to the authenticated principal; it intentionally
 * carries no schedule-management controls.
 */
export function MechanicInspectionWorkspace() {
  const { api, session } = useAuth();
  const [schedules, setSchedules] = useState<InspectionScheduleSummary[]>();
  const [error, setError] = useState<"retry" | "denied">();
  const [openId, setOpenId] = useState<string>();
  const [findings, setFindings] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [completionError, setCompletionError] = useState<string>();
  const scopeEpoch = useRef(0);
  const businessDate = todayInSeoul();
  const loadedSchedules = schedules ?? [];

  useEffect(() => {
    scopeEpoch.current += 1;
    return () => {
      scopeEpoch.current += 1;
    };
  }, [api, session?.user_id]);

  const load = useCallback(async () => {
    const epoch = scopeEpoch.current;
    setError(undefined);
    try {
      const response = await api.GET("/api/v1/inspections/my-schedules", {
        params: {
          query: {
            due_start: businessDate,
            due_end: `${Number(businessDate.slice(0, 4)) + 1}${businessDate.slice(4)}`,
            limit: PAGE_SIZE,
            offset: 0,
          },
        },
      });
      if (epoch !== scopeEpoch.current) return;
      if (response.data) {
        setSchedules(response.data.items);
      } else {
        setError(response.response.status === 403 ? "denied" : "retry");
      }
    } catch {
      if (epoch === scopeEpoch.current) setError("retry");
    }
  }, [api, businessDate, session?.user_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const complete = useCallback(
    async (scheduleId: string) => {
      const trimmed = findings.trim();
      if (!trimmed) return;
      const epoch = scopeEpoch.current;
      setSubmitting(true);
      setCompletionError(undefined);
      try {
        const response = await api.POST(
          "/api/v1/inspections/schedules/{schedule_id}/rounds",
          {
            params: { path: { schedule_id: scheduleId } },
            body: {
              outcome: "COMPLETED" as InspectionRoundOutcome,
              findings: trimmed,
              note: null,
            },
          },
        );
        if (epoch !== scopeEpoch.current) return;
        if (!response.data) {
          setCompletionError(ko.inspection.round.failed);
          return;
        }
        setOpenId(undefined);
        setFindings("");
        await load();
      } catch {
        if (epoch === scopeEpoch.current) {
          setCompletionError(ko.inspection.round.failed);
        }
      } finally {
        if (epoch === scopeEpoch.current) setSubmitting(false);
      }
    },
    [api, findings, load],
  );

  if (error) {
    return (
      <section className="inspection-mechanic" aria-live="polite">
        <p className="inspection-mechanic__error">
          {error === "denied"
            ? ko.page.permissionDenied
            : ko.inspection.loadFailed}
        </p>
        {error === "retry" ? (
          <button type="button" onClick={() => void load()}>
            {ko.page.retry}
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="inspection-mechanic" aria-label={ko.inspection.title}>
      <div className="inspection-mechanic__toolbar">
        <strong>{ko.inspection.title}</strong>
        <button type="button" onClick={() => void load()}>
          {ko.inspection.refresh}
        </button>
      </div>
      {schedules === undefined ? <p>{ko.common.loading}</p> : null}
      {schedules !== undefined && loadedSchedules.length === 0 ? (
        <p>{ko.inspection.empty}</p>
      ) : null}
      <ul className="inspection-mechanic__list">
        {loadedSchedules.map((schedule) => {
          const overdue = isInspectionOverdue(schedule, businessDate);
          const isOpen = openId === schedule.id;
          return (
            <li className="inspection-mechanic__row" key={schedule.id}>
              <div className="inspection-mechanic__row-head">
                <div>
                  <p className="inspection-mechanic__row-title">
                    {safeLabel(
                      schedule.management_no,
                      schedule.model,
                      ko.common.noNumber,
                    )}
                  </p>
                  <p className="inspection-mechanic__row-meta">
                    {schedule.site_name} · {schedule.due_date} ·{" "}
                    {ko.inspection.cycles[schedule.cycle]}
                  </p>
                </div>
                <span
                  className={
                    overdue
                      ? "inspection-chip inspection-chip--danger"
                      : "inspection-chip"
                  }
                >
                  {overdue
                    ? ko.inspection.overdue
                    : ko.inspection.statuses[schedule.status]}
                </span>
              </div>
              {schedule.status === "SCHEDULED" ? (
                <>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => {
                      setOpenId(isOpen ? undefined : schedule.id);
                      setFindings("");
                      setCompletionError(undefined);
                    }}
                  >
                    {ko.inspection.round.complete}
                  </button>
                  {isOpen ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void complete(schedule.id);
                      }}
                    >
                      <label htmlFor={`my-round-${schedule.id}`}>
                        {ko.inspection.round.findingsLabel}
                      </label>
                      <textarea
                        id={`my-round-${schedule.id}`}
                        value={findings}
                        onChange={(event) =>
                          setFindings(event.currentTarget.value)
                        }
                      />
                      <button
                        type="submit"
                        disabled={submitting || !findings.trim()}
                      >
                        {submitting
                          ? ko.inspection.round.submitting
                          : ko.inspection.round.submit}
                      </button>
                      {completionError ? (
                        <p className="inspection-mechanic__error" role="alert">
                          {completionError}
                        </p>
                      ) : null}
                    </form>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
