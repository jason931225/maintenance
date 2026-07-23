import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  InspectionScheduleSummary,
} from "../../api/types";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { safeLabel, todayInSeoul } from "../../lib/utils";
import { isInspectionOverdue } from "./inspectionModel";
import "./inspection.css";

const PAGE_SIZE = 100;

type LoadError = "retry" | "denied";

/**
 * Mechanic-only execution surface. Its source is the server-side `my-schedules`
 * projection, which binds rows to the authenticated principal; it intentionally
 * carries no schedule-management controls.
 */
export function MechanicInspectionWorkspace() {
  const { api, session } = useAuth();
  const sessionId = session?.user_id;
  const [schedules, setSchedules] = useState<InspectionScheduleSummary[]>();
  const [total, setTotal] = useState<number>();
  const [loadError, setLoadError] = useState<LoadError>();
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string>();
  const [findings, setFindings] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [completionError, setCompletionError] = useState<string>();
  const scopeEpoch = useRef(0);
  const listRequestVersion = useRef(0);
  const businessDate = todayInSeoul();
  const loadedSchedules = schedules ?? [];
  const canLoadMore = total !== undefined && loadedSchedules.length < total;

  useEffect(() => {
    scopeEpoch.current += 1;
    listRequestVersion.current += 1;
    return () => {
      scopeEpoch.current += 1;
      listRequestVersion.current += 1;
    };
  }, [api, sessionId]);

  const ownsListRequest = useCallback(
    (epoch: number, requestVersion: number) =>
      epoch === scopeEpoch.current &&
      requestVersion === listRequestVersion.current,
    [],
  );

  const load = useCallback(async () => {
    const epoch = scopeEpoch.current;
    const requestVersion = ++listRequestVersion.current;
    setLoadError(undefined);
    setLoadMoreError(false);
    setLoadingMore(false);
    try {
      const response = await api.GET("/api/v1/inspections/my-schedules", {
        headers: { "Cache-Control": "no-cache" },
        params: {
          query: {
            due_start: businessDate,
            due_end:
              String(Number(businessDate.slice(0, 4)) + 1) +
              businessDate.slice(4),
            limit: PAGE_SIZE,
            offset: 0,
          },
        },
      });
      if (!ownsListRequest(epoch, requestVersion)) return;
      if (response.data) {
        const page = response.data;
        setSchedules(page.items);
        setTotal(page.total);
        setOpenId((current) =>
          page.items.some((schedule) => schedule.id === current)
            ? current
            : undefined,
        );
      } else {
        setLoadError(response.response.status === 403 ? "denied" : "retry");
      }
    } catch {
      if (ownsListRequest(epoch, requestVersion)) setLoadError("retry");
    }
  }, [api, businessDate, ownsListRequest]);

  const loadMore = useCallback(async () => {
    if (!canLoadMore || schedules === undefined) return;
    const epoch = scopeEpoch.current;
    const requestVersion = ++listRequestVersion.current;
    const offset = schedules.length;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const response = await api.GET("/api/v1/inspections/my-schedules", {
        headers: { "Cache-Control": "no-cache" },
        params: {
          query: {
            due_start: businessDate,
            due_end:
              String(Number(businessDate.slice(0, 4)) + 1) +
              businessDate.slice(4),
            limit: PAGE_SIZE,
            offset,
          },
        },
      });
      if (!ownsListRequest(epoch, requestVersion)) return;
      if (!response.data) {
        setLoadMoreError(true);
        return;
      }
      const page = response.data;
      setSchedules((current) => {
        const existing = current ?? [];
        const ids = new Set(existing.map((schedule) => schedule.id));
        return [...existing, ...page.items.filter((item) => !ids.has(item.id))];
      });
      setTotal(page.total);
    } catch {
      if (ownsListRequest(epoch, requestVersion)) setLoadMoreError(true);
    } finally {
      if (ownsListRequest(epoch, requestVersion)) setLoadingMore(false);
    }
  }, [api, businessDate, canLoadMore, ownsListRequest, schedules]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, sessionId]);

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
              outcome: "COMPLETED",
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

  const loadMoreAria = useMemo(
    () =>
      ko.common.loadMoreAria
        .replace("{loaded}", String(loadedSchedules.length))
        .replace("{total}", String(total ?? 0))
        .replaceAll("{unit}", ko.common.countUnit),
    [loadedSchedules.length, total],
  );

  if (loadError) {
    return (
      <section className="inspection-mechanic" aria-live="polite">
        <p className="inspection-mechanic__error">
          {loadError === "denied"
            ? ko.page.permissionDenied
            : ko.inspection.loadFailed}
        </p>
        {loadError === "retry" ? (
          <button
            type="button"
            onClick={() => {
              void load();
            }}
          >
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
        <button
          type="button"
          onClick={() => {
            void load();
          }}
        >
          {ko.inspection.refresh}
        </button>
      </div>
      {schedules === undefined ? <p>{ko.common.loading}</p> : null}
      {schedules !== undefined && loadedSchedules.length === 0 ? (
        <p>{ko.inspection.empty}</p>
      ) : null}
      {total !== undefined ? (
        <p className="inspection-mechanic__count" aria-live="polite">
          {loadedSchedules.length} / {total} {ko.common.countUnit}
        </p>
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
                        onChange={(event) => {
                          setFindings(event.currentTarget.value);
                        }}
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
      {canLoadMore ? (
        <div className="inspection-mechanic__more">
          {loadMoreError ? (
            <p className="inspection-mechanic__error" role="alert">
              {ko.inspection.loadFailed}
            </p>
          ) : null}
          <button
            type="button"
            aria-label={loadMoreAria}
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? ko.common.loadingMore : ko.common.loadMore}
          </button>
        </div>
      ) : null}
    </section>
  );
}
