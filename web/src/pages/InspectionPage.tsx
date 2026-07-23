import { CalendarPlus, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ButtonHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import type {
  BranchSummary,
  CompleteInspectionRoundRequest,
  CreateInspectionScheduleRequest,
  InspectionCycle,
  InspectionRoundOutcome,
  InspectionScheduleSummary,
  UserSummary,
} from "../api/types";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { SUCCESS_DISMISS_MS, useAutoDismiss } from "../lib/useAutoDismiss";
import { formatListCount, safeLabel, todayInSeoul } from "../lib/utils";
import { InspectionScheduleDetail } from "../console/inspection/InspectionScheduleDetail";
import {
  type InspectionScheduleFilter,
  filterInspectionSchedules,
  inspectionScheduleMetrics,
  isInspectionOverdue,
} from "../console/inspection/inspectionModel";
import "../console/inspection/inspection.css";

/** Schedule page size; matches the backend default and keeps the list bounded. */
const SCHEDULES_PAGE_SIZE = 100;

const ROUND_OUTCOMES: InspectionRoundOutcome[] = [
  "COMPLETED",
  "FOLLOW_UP_REQUIRED",
];

const CYCLES: InspectionCycle[] = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
  "CUSTOM",
];

/**
 * Default 주기(일) for a chosen 주기. Picking 월/분기/년 auto-fills a sensible
 * interval (31/92/365) instead of leaving the stale default 30 (#19.22); 기타
 * (CUSTOM) keeps whatever the operator typed.
 */
const CYCLE_INTERVAL_DAYS: Partial<Record<InspectionCycle, number>> = {
  DAILY: 1,
  WEEKLY: 7,
  MONTHLY: 31,
  QUARTERLY: 92,
  YEARLY: 365,
};

function today(): string {
  return todayInSeoul();
}

function plusDays(days: number): string {
  // Anchor the offset to the Seoul business date; noon UTC keeps the Y-M-D
  // stable across timezones so the due-date suggestion never slips a day.
  return plusDaysFrom(todayInSeoul(), days);
}

function plusDaysFrom(date: string, days: number): string {
  // Offset a YYYY-MM-DD date by `days`; noon UTC keeps the Y-M-D stable across
  // timezones so the result never slips a day.
  const base = new Date(`${date}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

interface FormState {
  branch_id: string;
  equipment_id: string;
  mechanic_id: string;
  cycle: InspectionCycle;
  interval_days: string;
  due_date: string;
  note: string;
}

function emptyForm(): FormState {
  return {
    branch_id: "",
    equipment_id: "",
    mechanic_id: "",
    cycle: "MONTHLY",
    // Mirror the MONTHLY default so the field is consistent with the cycle from
    // the start (auto-fills on cycle change; CUSTOM lets the operator override).
    interval_days: String(CYCLE_INTERVAL_DAYS.MONTHLY),
    due_date: today(),
    note: "",
  };
}

export function InspectionPage() {
  const { api, session } = useAuth();
  const [rangeStart, setRangeStart] = useState(today);
  const [rangeEnd, setRangeEnd] = useState(() => plusDays(30));
  const [schedules, setSchedules] = useState<InspectionScheduleSummary[]>();
  const [scheduleTotal, setScheduleTotal] = useState<number>();
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>();
  const [scheduleFilter, setScheduleFilter] =
    useState<InspectionScheduleFilter>("ALL");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [loadError, setLoadError] = useState<"retry" | "denied">();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  // Picker option sources for the create form: branches + mechanics are small
  // and preloaded for client-side filtering; equipment is searched on demand.
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [mechanics, setMechanics] = useState<UserSummary[]>([]);
  // The equipment option the admin picked, kept so the human label renders for
  // the already-selected id (the search endpoint is a per-query typeahead).
  const [equipmentOption, setEquipmentOption] = useState<ConsoleOption>();
  // The schedule whose "complete round" form is open, plus the last-completed
  // notice. There is one open round form at a time so the list stays compact.
  const [completingId, setCompletingId] = useState<string>();
  const [roundNotice, setRoundNotice] = useState<string>();
  // A filter/date refresh may finish after a newer request. Keep only the
  // newest server response so the visible branch-scoped list never rewinds.
  const scheduleRequestVersion = useRef(0);
  const completionRequestVersion = useRef(0);
  const scopeEpoch = useRef(0);
  useEffect(() => {
    scopeEpoch.current += 1;
    completionRequestVersion.current += 1;
    return () => {
      scopeEpoch.current += 1;
      completionRequestVersion.current += 1;
    };
  }, [api, session?.user_id]);
  // Transient success confirmations clear themselves so they do not linger.
  const clearRoundNotice = useCallback(() => {
    setRoundNotice(undefined);
  }, []);
  useAutoDismiss(roundNotice, clearRoundNotice, SUCCESS_DISMISS_MS);
  const clearNotice = useCallback(() => {
    setNotice(undefined);
  }, []);
  useAutoDismiss(notice, clearNotice, SUCCESS_DISMISS_MS);

  const load = useCallback(
    async (range?: { start: string; end: string }) => {
      const requestVersion = ++scheduleRequestVersion.current;
      const epoch = scopeEpoch.current;
      setLoadError(undefined);
      setLoadingMore(false);
      setLoadMoreError(false);
      try {
        const response = await api.GET("/api/v1/inspections/schedules", {
          headers: { "Cache-Control": "no-cache" },
          params: {
            query: {
              due_start: range?.start ?? rangeStart,
              due_end: range?.end ?? rangeEnd,
              limit: SCHEDULES_PAGE_SIZE,
              offset: 0,
            },
          },
        });
        if (
          requestVersion !== scheduleRequestVersion.current ||
          epoch !== scopeEpoch.current
        )
          return;
        if (response.data) {
          const page = response.data;
          setSchedules(page.items);
          setScheduleTotal(page.total);
          setSelectedScheduleId((current) =>
            page.items.some((schedule) => schedule.id === current)
              ? current
              : page.items[0]?.id,
          );
        } else {
          setLoadError(response.response.status === 403 ? "denied" : "retry");
        }
      } catch {
        if (
          requestVersion === scheduleRequestVersion.current &&
          epoch === scopeEpoch.current
        )
          setLoadError("retry");
      }
    },
    [api, rangeStart, rangeEnd, session?.user_id],
  );

  const loadMore = useCallback(async () => {
    if (schedules === undefined) return;
    const requestVersion = ++scheduleRequestVersion.current;
    const epoch = scopeEpoch.current;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const response = await api.GET("/api/v1/inspections/schedules", {
        headers: { "Cache-Control": "no-cache" },
        params: {
          query: {
            due_start: rangeStart,
            due_end: rangeEnd,
            limit: SCHEDULES_PAGE_SIZE,
            offset: schedules.length,
          },
        },
      });
      if (
        requestVersion !== scheduleRequestVersion.current ||
        epoch !== scopeEpoch.current
      )
        return;
      if (response.data) {
        const next = response.data;
        setSchedules((current) => {
          const existing = current ?? [];
          const seen = new Set(existing.map((schedule) => schedule.id));
          return [
            ...existing,
            ...next.items.filter((schedule) => !seen.has(schedule.id)),
          ];
        });
        setScheduleTotal(next.total);
      } else {
        setLoadMoreError(true);
      }
    } catch {
      if (
        requestVersion === scheduleRequestVersion.current &&
        epoch === scopeEpoch.current
      ) {
        setLoadMoreError(true);
      }
    } finally {
      if (
        requestVersion === scheduleRequestVersion.current &&
        epoch === scopeEpoch.current
      )
        setLoadingMore(false);
    }
  }, [api, rangeStart, rangeEnd, schedules]);

  useEffect(() => {
    // Defer to a microtask so the initial fetch's setState isn't called
    // synchronously inside the effect body (react-hooks/set-state-in-effect);
    // the arrow drops the `.then` value so `load()`'s optional range stays unset.
    void Promise.resolve().then(() => load());
  }, [load]);

  // Load the branch + mechanic option sources once for the create-form pickers.
  const loadOptions = useCallback(async () => {
    const epoch = scopeEpoch.current;
    const [branchRes, userRes] = await Promise.all([
      api.GET("/api/v1/branches").catch(() => undefined),
      api
        .GET("/api/v1/users", {
          params: { query: { include_inactive: false } },
        })
        .catch(() => undefined),
    ]);
    if (epoch !== scopeEpoch.current) return;
    if (branchRes?.data) setBranches(branchRes.data);
    if (userRes?.data) {
      setMechanics(
        userRes.data.items.filter((user) => user.roles.includes("MECHANIC")),
      );
    }
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(loadOptions);
  }, [loadOptions]);

  const branchOptions = useMemo<ConsoleOption[]>(
    () => branches.map((branch) => ({ id: branch.id, label: branch.name })),
    [branches],
  );

  const mechanicOptions = useMemo<ConsoleOption[]>(
    () =>
      mechanics.map((user) => ({
        id: user.id,
        label: user.display_name,
        sublabel: user.phone ?? undefined,
      })),
    [mechanics],
  );

  const searchEquipment = useCallback(
    async (query: string): Promise<ConsoleOption[]> => {
      const response = await api
        .GET("/api/v1/equipment", { params: { query: { q: query, limit: 8 } } })
        .catch(() => undefined);
      return (response?.data?.items ?? []).map((item) => ({
        id: item.id,
        label: safeLabel(item.management_no, item.equipment_no),
        sublabel: [item.model, item.customer.name, item.site.name]
          .filter(Boolean)
          .join(" · "),
      }));
    },
    [api],
  );

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleCreate() {
    const epoch = scopeEpoch.current;
    setCreating(true);
    setNotice(undefined);
    setCreateError(undefined);
    const dueDate = form.due_date;
    try {
      const body: CreateInspectionScheduleRequest = {
        branch_id: form.branch_id.trim(),
        equipment_id: form.equipment_id.trim(),
        mechanic_id: form.mechanic_id.trim(),
        cycle: form.cycle,
        interval_days: Number(form.interval_days),
        due_date: dueDate,
        note: form.note.trim() || null,
      };
      const response = await api.POST("/api/v1/inspections/schedules", {
        body,
      });
      if (epoch !== scopeEpoch.current) return;
      if (response.data) {
        setNotice(ko.inspection.createSuccess);
        setForm(emptyForm());
        setEquipmentOption(undefined);
        // Snap the visible window to include the new due_date so a schedule
        // created outside the current [start, end) range is immediately visible
        // (#19.22). The backend window is half-open, so end must be due_date + 1.
        const nextStart = dueDate < rangeStart ? dueDate : rangeStart;
        const nextEnd =
          dueDate >= rangeEnd ? plusDaysFrom(dueDate, 1) : rangeEnd;
        setRangeStart(nextStart);
        setRangeEnd(nextEnd);
        await load({ start: nextStart, end: nextEnd });
      } else {
        setCreateError(ko.inspection.createFailed);
      }
    } catch {
      if (epoch === scopeEpoch.current) {
        setCreateError(ko.inspection.createFailed);
      }
    } finally {
      if (epoch === scopeEpoch.current) setCreating(false);
    }
  }

  async function completeRound(
    scheduleId: string,
    mechanicId: string,
    outcome: InspectionRoundOutcome,
    findings: string,
    note: string,
  ): Promise<"done" | "failed" | "superseded"> {
    // The server is authoritative and rejects an actor other than the assigned
    // mechanic. Keep the UI operation bound to that same identity as well, so a
    // stale form cannot submit after an auth-session transition.
    if (!session?.user_id || session.user_id !== mechanicId) return "superseded";
    const epoch = scopeEpoch.current;
    const requestVersion = ++completionRequestVersion.current;
    const ownsCompletion = () =>
      epoch === scopeEpoch.current &&
      requestVersion === completionRequestVersion.current;
    setRoundNotice(undefined);
    try {
      const body: CompleteInspectionRoundRequest = {
        outcome,
        findings,
        note: note.trim() || null,
      };
      const response = await api.POST(
        "/api/v1/inspections/schedules/{schedule_id}/rounds",
        { params: { path: { schedule_id: scheduleId } }, body },
      );
      if (!ownsCompletion()) return "superseded";
      if (!response.data) return "failed";
      setRoundNotice(ko.inspection.round.done);
      setCompletingId(undefined);
      await load();
      return ownsCompletion() ? "done" : "superseded";
    } catch {
      return ownsCompletion() ? "failed" : "superseded";
    }
  }

  const createDisabled =
    creating ||
    !form.branch_id.trim() ||
    !form.equipment_id.trim() ||
    !form.mechanic_id.trim() ||
    !form.due_date ||
    Number.isNaN(Number(form.interval_days));

  const businessDate = today();
  const visibleSchedules = useMemo(
    () =>
      filterInspectionSchedules(schedules ?? [], scheduleFilter, businessDate),
    [businessDate, scheduleFilter, schedules],
  );
  const scheduleMetrics = useMemo(
    () => inspectionScheduleMetrics(schedules ?? [], businessDate),
    [businessDate, schedules],
  );
  const selectedSchedule = useMemo(
    () =>
      visibleSchedules.find((schedule) => schedule.id === selectedScheduleId),
    [selectedScheduleId, visibleSchedules],
  );

  return (
    <main
      className="console inspection-page"
      aria-labelledby="inspection-title"
    >
      <header className="inspection-page__header">
        <h1 id="inspection-title">{ko.inspection.title}</h1>
        <p>{ko.inspection.description}</p>
      </header>
      <div className="inspection-manager">
        <section className="inspection-panel">
          <div className="inspection-range">
            <div className="inspection-field">
              <label
                className="inspection-label"
                htmlFor="inspection-range-start"
              >
                {ko.inspection.rangeStart}
              </label>
              <ConsoleInput
                id="inspection-range-start"
                type="date"
                value={rangeStart}
                onChange={(event) => {
                  setRangeStart(event.currentTarget.value);
                }}
              />
            </div>
            <div className="inspection-field">
              <label
                className="inspection-label"
                htmlFor="inspection-range-end"
              >
                {ko.inspection.rangeEnd}
              </label>
              <ConsoleInput
                id="inspection-range-end"
                type="date"
                value={rangeEnd}
                onChange={(event) => {
                  setRangeEnd(event.currentTarget.value);
                }}
              />
            </div>
            <ConsoleButton
              type="button"
              onClick={() => {
                void load();
              }}
            >
              <RefreshCw aria-hidden="true" size={16} />
              {ko.inspection.refresh}
            </ConsoleButton>
          </div>

          {loadError ? (
            <ConsoleError
              message={
                loadError === "denied"
                  ? ko.page.permissionDenied
                  : ko.inspection.loadFailed
              }
              retry={loadError === "retry" ? () => void load() : undefined}
            />
          ) : null}
          {roundNotice ? (
            <p role="status" className="inspection-notice">
              {roundNotice}
            </p>
          ) : null}
          {!loadError && schedules === undefined ? (
            <p className="inspection-loading" role="status">
              {ko.common.loading}
            </p>
          ) : null}
          {schedules && schedules.length === 0 ? (
            <p className="inspection-empty">{ko.inspection.empty}</p>
          ) : null}
          {schedules && schedules.length > 0 ? (
            <div className="inspection-list-section">
              <div className="inspection-list-header">
                <h2 className="inspection-list-title">
                  {ko.inspection.listTitle}
                </h2>
                <span className="inspection-count">
                  {formatListCount(schedules.length, { total: scheduleTotal })}
                </span>
              </div>
              <div className="inspection-summary">
                <Metric
                  label={ko.inspection.statuses.SCHEDULED}
                  value={scheduleMetrics.scheduled}
                />
                <Metric
                  label={ko.inspection.overdue}
                  value={scheduleMetrics.overdue}
                  danger
                />
                <Metric
                  label={ko.inspection.statuses.COMPLETED}
                  value={scheduleMetrics.completed}
                />
              </div>
              <div className="inspection-filter-bar">
                {(
                  [
                    ["ALL", ko.inspection.listTitle],
                    ["SCHEDULED", ko.inspection.statuses.SCHEDULED],
                    ["OVERDUE", ko.inspection.overdue],
                    ["COMPLETED", ko.inspection.statuses.COMPLETED],
                  ] as const
                ).map(([filter, label]) => (
                  <ConsoleButton
                    key={filter}
                    type="button"
                    data-secondary={scheduleFilter !== filter || undefined}
                    aria-pressed={scheduleFilter === filter}
                    onClick={() => {
                      setScheduleFilter(filter);
                    }}
                  >
                    {label}
                  </ConsoleButton>
                ))}
              </div>
              <div className="inspection-list-grid">
                <ul
                  className="inspection-list"
                  aria-label={ko.inspection.listTitle}
                >
                  {visibleSchedules.map((schedule) => (
                    <li key={schedule.id} className="inspection-list-row">
                      <div className="inspection-list-row__head">
                        <button
                          type="button"
                          className="inspection-list-row__select"
                          aria-pressed={selectedScheduleId === schedule.id}
                          onClick={() => {
                            setSelectedScheduleId(schedule.id);
                          }}
                        >
                          <span className="inspection-list-row__title">
                            {safeLabel(
                              schedule.management_no,
                              schedule.model,
                              ko.common.noNumber,
                            )}
                            {schedule.model && schedule.management_no
                              ? ` · ${schedule.model}`
                              : ""}
                          </span>
                          <span className="inspection-list-row__meta">
                            {schedule.site_name} ·{" "}
                            {ko.inspection.cycles[schedule.cycle]} ·{" "}
                            {schedule.due_date} ·{" "}
                            {ko.inspection.fields.mechanic}:{" "}
                            {safeLabel(schedule.mechanic_display_name)}
                          </span>
                        </button>
                        <div className="inspection-list-row__actions">
                          {schedule.status === "SCHEDULED" &&
                          isInspectionOverdue(schedule, businessDate) ? (
                            <span className="inspection-chip inspection-chip--danger">
                              {ko.inspection.overdue}
                            </span>
                          ) : (
                            <span className="inspection-chip">
                              {ko.inspection.statuses[schedule.status]}
                            </span>
                          )}
                          {schedule.status === "SCHEDULED" &&
                          schedule.mechanic_id === session?.user_id ? (
                            <ConsoleButton
                              type="button"
                              data-secondary
                              aria-label={`${safeLabel(schedule.management_no, schedule.model, ko.common.noNumber)} ${ko.inspection.round.complete}`}
                              onClick={() => {
                                setRoundNotice(undefined);
                                setCompletingId((current) =>
                                  current === schedule.id
                                    ? undefined
                                    : schedule.id,
                                );
                              }}
                            >
                              {ko.inspection.round.complete}
                            </ConsoleButton>
                          ) : null}
                        </div>
                      </div>
                      {completingId === schedule.id ? (
                        <InspectionRoundForm
                          scheduleId={schedule.id}
                          mechanicId={schedule.mechanic_id}
                          onComplete={completeRound}
                          onCancel={() => {
                            setCompletingId(undefined);
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
                {visibleSchedules.length === 0 ? (
                  <p className="inspection-filter-empty" role="status">
                    {ko.inspection.empty}
                  </p>
                ) : null}
                {selectedSchedule ? (
                  <InspectionScheduleDetail
                    schedule={selectedSchedule}
                    overdue={isInspectionOverdue(
                      selectedSchedule,
                      businessDate,
                    )}
                  />
                ) : null}
              </div>
              {scheduleTotal !== undefined &&
              schedules.length < scheduleTotal ? (
                <div className="inspection-more">
                  {loadMoreError ? (
                    <p className="inspection-round-form__error" role="alert">
                      {ko.inspection.loadFailed}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="inspection-button"
                    disabled={loadingMore}
                    aria-label={ko.common.loadMoreAria
                      .replace("{loaded}", String(schedules.length))
                      .replace("{total}", String(scheduleTotal))
                      .replaceAll("{unit}", ko.common.countUnit)}
                    onClick={() => {
                      void loadMore();
                    }}
                  >
                    {loadingMore ? ko.common.loadingMore : ko.common.loadMore}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="inspection-panel">
          <div>
            <h2 className="inspection-panel__title">
              {ko.inspection.createTitle}
            </h2>
          </div>
          {notice ? (
            <p role="status" className="inspection-notice">
              {notice}
            </p>
          ) : null}
          {createError ? <ConsoleError message={createError} /> : null}
          <form
            className="inspection-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <div className="inspection-field">
              <label className="inspection-label" htmlFor="ins-branch">
                {ko.inspection.fields.branch}
              </label>
              <ConsoleCombobox
                id="ins-branch"
                options={branchOptions}
                value={form.branch_id}
                onChange={(v) => {
                  setField("branch_id", v);
                }}
                placeholder={ko.inspection.fields.branchPlaceholder}
              />
            </div>
            <div className="inspection-field">
              <label className="inspection-label" htmlFor="ins-equipment">
                {ko.inspection.fields.equipment}
              </label>
              <AsyncConsoleCombobox
                key={form.equipment_id}
                id="ins-equipment"
                search={searchEquipment}
                value={form.equipment_id}
                selectedOption={equipmentOption}
                onChange={(v) => {
                  setField("equipment_id", v);
                  if (!v) setEquipmentOption(undefined);
                }}
                onSelectOption={setEquipmentOption}
                placeholder={ko.inspection.fields.equipmentPlaceholder}
              />
            </div>
            <div className="inspection-field">
              <label className="inspection-label" htmlFor="ins-mechanic">
                {ko.inspection.fields.mechanic}
              </label>
              <ConsoleCombobox
                id="ins-mechanic"
                options={mechanicOptions}
                value={form.mechanic_id}
                onChange={(v) => {
                  setField("mechanic_id", v);
                }}
                placeholder={ko.inspection.fields.mechanicPlaceholder}
              />
            </div>
            <div className="inspection-field">
              <label className="inspection-label" htmlFor="ins-cycle">
                {ko.inspection.fields.cycle}
              </label>
              <ConsoleSelect
                id="ins-cycle"
                value={form.cycle}
                onChange={(event) => {
                  const cycle = event.currentTarget.value as InspectionCycle;
                  // Auto-fill 주기(일) for fixed cycles; 기타(CUSTOM) is manual,
                  // so leave whatever the operator typed.
                  const days = CYCLE_INTERVAL_DAYS[cycle];
                  setForm((prev) => ({
                    ...prev,
                    cycle,
                    interval_days:
                      days === undefined ? prev.interval_days : String(days),
                  }));
                }}
              >
                {CYCLES.map((cycle) => (
                  <option key={cycle} value={cycle}>
                    {ko.inspection.cycles[cycle]}
                  </option>
                ))}
              </ConsoleSelect>
            </div>
            <Field
              id="ins-interval"
              label={ko.inspection.fields.intervalDays}
              type="number"
              value={form.interval_days}
              onChange={(v) => {
                setField("interval_days", v);
              }}
            />
            <Field
              id="ins-due-date"
              label={ko.inspection.fields.dueDate}
              type="date"
              value={form.due_date}
              onChange={(v) => {
                setField("due_date", v);
              }}
            />
            <Field
              id="ins-note"
              label={ko.inspection.fields.note}
              value={form.note}
              onChange={(v) => {
                setField("note", v);
              }}
            />
            <div className="inspection-create-submit">
              <ConsoleButton type="submit" disabled={createDisabled}>
                <CalendarPlus aria-hidden="true" size={16} />
                {creating ? ko.inspection.creating : ko.inspection.create}
              </ConsoleButton>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}

type ConsoleOption = {
  id: string;
  label: string;
  sublabel?: string;
};

function ConsoleButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={["inspection-button", className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}

function ConsoleInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={["inspection-input", className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}

function ConsoleTextarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={["inspection-input", "inspection-textarea", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}

function ConsoleSelect({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={["inspection-input", className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}

function ConsoleError({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="inspection-error" role="alert">
      <p>{message}</p>
      {retry ? (
        <ConsoleButton type="button" data-secondary onClick={retry}>
          {ko.page.retry}
        </ConsoleButton>
      ) : null}
    </div>
  );
}

function ConsoleCombobox({
  id,
  options,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  options: ConsoleOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <ConsoleSelect
      id={id}
      value={value}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
          {option.sublabel ? ` · ${option.sublabel}` : ""}
        </option>
      ))}
    </ConsoleSelect>
  );
}

function AsyncConsoleCombobox({
  id,
  search,
  value,
  selectedOption,
  onChange,
  onSelectOption,
  placeholder,
}: {
  id: string;
  search: (query: string) => Promise<ConsoleOption[]>;
  value: string;
  selectedOption?: ConsoleOption;
  onChange: (value: string) => void;
  onSelectOption: (option: ConsoleOption | undefined) => void;
  placeholder: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState(selectedOption?.label ?? "");
  const [options, setOptions] = useState<ConsoleOption[]>([]);
  const requestVersion = useRef(0);

  async function find(nextQuery: string) {
    setQuery(nextQuery);
    onChange("");
    onSelectOption(undefined);
    if (!nextQuery.trim()) {
      setOptions([]);
      return;
    }
    const version = ++requestVersion.current;
    const results = await search(nextQuery);
    if (version === requestVersion.current) setOptions(results);
  }

  return (
    <div className="inspection-async-combobox">
      <ConsoleInput
        id={id}
        value={query}
        placeholder={placeholder}
        role="combobox"
        aria-controls={listId}
        aria-expanded={options.length > 0}
        onChange={(event) => {
          void find(event.currentTarget.value);
        }}
      />
      {options.length > 0 ? (
        <ul
          id={listId}
          className="inspection-async-combobox__options"
          role="listbox"
        >
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={value === option.id}
                onClick={() => {
                  onChange(option.id);
                  onSelectOption(option);
                  setQuery(option.label);
                  setOptions([]);
                }}
              >
                {option.label}
                {option.sublabel ? ` · ${option.sublabel}` : ""}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="inspection-metric">
      <p>{label}</p>
      <p className={danger ? "inspection-metric--danger" : undefined}>
        {value}
      </p>
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}

function Field({ id, label, value, onChange, type = "text" }: FieldProps) {
  return (
    <div className="inspection-field">
      <label className="inspection-label" htmlFor={id}>
        {label}
      </label>
      <ConsoleInput
        id={id}
        type={type}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}

interface InspectionRoundFormProps {
  scheduleId: string;
  mechanicId: string;
  onComplete: (
    scheduleId: string,
    mechanicId: string,
    outcome: InspectionRoundOutcome,
    findings: string,
    note: string,
  ) => Promise<"done" | "failed" | "superseded">;
  onCancel: () => void;
}

function InspectionRoundForm({
  scheduleId,
  mechanicId,
  onComplete,
  onCancel,
}: InspectionRoundFormProps) {
  const t = ko.inspection.round;
  const [outcome, setOutcome] = useState<InspectionRoundOutcome>("COMPLETED");
  const [findings, setFindings] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    if (!findings.trim()) return;
    setSubmitting(true);
    setError(undefined);
    const result = await onComplete(
      scheduleId,
      mechanicId,
      outcome,
      findings.trim(),
      note,
    );
    setSubmitting(false);
    if (result === "failed") setError(t.failed);
  }

  return (
    <form
      className="inspection-round-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="inspection-round-form__title">{t.title}</p>
      <div className="inspection-field">
        <label
          className="inspection-label"
          htmlFor={`round-outcome-${scheduleId}`}
        >
          {t.outcomeLabel}
        </label>
        <ConsoleSelect
          id={`round-outcome-${scheduleId}`}
          value={outcome}
          onChange={(event) => {
            setOutcome(event.currentTarget.value as InspectionRoundOutcome);
          }}
        >
          {ROUND_OUTCOMES.map((value) => (
            <option key={value} value={value}>
              {t.outcomes[value]}
            </option>
          ))}
        </ConsoleSelect>
      </div>
      <div className="inspection-field">
        <label
          className="inspection-label"
          htmlFor={`round-findings-${scheduleId}`}
        >
          {t.findingsLabel}
        </label>
        <ConsoleTextarea
          id={`round-findings-${scheduleId}`}
          placeholder={t.findingsPlaceholder}
          value={findings}
          onChange={(event) => {
            setFindings(event.currentTarget.value);
          }}
        />
      </div>
      <div className="inspection-field">
        <label
          className="inspection-label"
          htmlFor={`round-note-${scheduleId}`}
        >
          {t.noteLabel}
        </label>
        <ConsoleInput
          id={`round-note-${scheduleId}`}
          placeholder={t.notePlaceholder}
          value={note}
          onChange={(event) => {
            setNote(event.currentTarget.value);
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="inspection-round-form__error">
          {error}
        </p>
      ) : null}
      <div className="inspection-round-form__actions">
        <ConsoleButton
          type="button"
          data-secondary
          disabled={submitting}
          onClick={onCancel}
        >
          {t.cancel}
        </ConsoleButton>
        <ConsoleButton type="submit" disabled={submitting || !findings.trim()}>
          {submitting ? t.submitting : t.submit}
        </ConsoleButton>
      </div>
    </form>
  );
}
