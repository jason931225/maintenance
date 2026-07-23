import { CalendarPlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { LoadMoreButton } from "../components/shell/LoadMoreButton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import {
  AsyncCombobox,
  Combobox,
  type ComboboxOption,
} from "../components/ui/combobox";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
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
const SCHEDULES_PAGE_SIZE = 200;

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
  const [equipmentOption, setEquipmentOption] = useState<ComboboxOption>();
  // The schedule whose "complete round" form is open, plus the last-completed
  // notice. There is one open round form at a time so the list stays compact.
  const [completingId, setCompletingId] = useState<string>();
  const [roundNotice, setRoundNotice] = useState<string>();
  // A filter/date refresh may finish after a newer request. Keep only the
  // newest server response so the visible branch-scoped list never rewinds.
  const scheduleRequestVersion = useRef(0);
  const scopeEpoch = useRef(0);
  useEffect(() => {
    scopeEpoch.current += 1;
    return () => {
      scopeEpoch.current += 1;
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
      try {
        const response = await api.GET("/api/v1/inspections/schedules", {
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
    [api, rangeStart, rangeEnd],
  );

  const loadMore = useCallback(async () => {
    if (schedules === undefined) return;
    const requestVersion = ++scheduleRequestVersion.current;
    const epoch = scopeEpoch.current;
    setLoadingMore(true);
    try {
      const response = await api.GET("/api/v1/inspections/schedules", {
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

  const branchOptions = useMemo<ComboboxOption[]>(
    () => branches.map((branch) => ({ id: branch.id, label: branch.name })),
    [branches],
  );

  const mechanicOptions = useMemo<ComboboxOption[]>(
    () =>
      mechanics.map((user) => ({
        id: user.id,
        label: user.display_name,
        sublabel: user.phone ?? undefined,
      })),
    [mechanics],
  );

  const searchEquipment = useCallback(
    async (query: string): Promise<ComboboxOption[]> => {
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
    outcome: InspectionRoundOutcome,
    findings: string,
    note: string,
  ): Promise<boolean> {
    const epoch = scopeEpoch.current;
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
      if (!response.data || epoch !== scopeEpoch.current) return false;
      setRoundNotice(ko.inspection.round.done);
      setCompletingId(undefined);
      await load();
      return true;
    } catch {
      return false;
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
    <>
      <PageHeader
        title={ko.inspection.title}
        description={ko.inspection.description}
      />
      <div className="grid max-w-6xl gap-5">
        <Card className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="inspection-range-start"
              >
                {ko.inspection.rangeStart}
              </label>
              <Input
                id="inspection-range-start"
                type="date"
                value={rangeStart}
                onChange={(event) => {
                  setRangeStart(event.currentTarget.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="inspection-range-end"
              >
                {ko.inspection.rangeEnd}
              </label>
              <Input
                id="inspection-range-end"
                type="date"
                value={rangeEnd}
                onChange={(event) => {
                  setRangeEnd(event.currentTarget.value);
                }}
              />
            </div>
            <Button
              type="button"
              onClick={() => {
                void load();
              }}
            >
              <RefreshCw aria-hidden="true" size={16} />
              {ko.inspection.refresh}
            </Button>
          </div>

          {loadError ? (
            <PageError
              message={ko.inspection.loadFailed}
              status={loadError === "denied" ? 403 : undefined}
              onRetry={() => {
                void load();
              }}
            />
          ) : null}
          {roundNotice ? (
            <p role="status" className="text-sm font-medium text-brand-teal">
              {roundNotice}
            </p>
          ) : null}
          {!loadError && schedules === undefined ? (
            <SkeletonCards count={3} lines={2} />
          ) : null}
          {schedules && schedules.length === 0 ? (
            <p className="rounded-md border border-dashed border-line bg-muted-panel p-3 text-sm text-steel">
              {ko.inspection.empty}
            </p>
          ) : null}
          {schedules && schedules.length > 0 ? (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-ink">
                  {ko.inspection.listTitle}
                </h2>
                <Badge>
                  {formatListCount(scheduleTotal ?? schedules.length)}
                </Badge>
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
                  <Button
                    key={filter}
                    type="button"
                    size="sm"
                    variant={
                      scheduleFilter === filter ? "default" : "secondary"
                    }
                    aria-pressed={scheduleFilter === filter}
                    onClick={() => {
                      setScheduleFilter(filter);
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.72fr)]">
                <ul className="grid gap-2" aria-label={ko.inspection.listTitle}>
                  {visibleSchedules.map((schedule) => (
                    <li
                      key={schedule.id}
                      className="grid gap-3 rounded-md border border-line p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <button
                          type="button"
                          className="grid min-w-0 flex-1 gap-1 text-left focus:outline-none focus:ring-2 focus:ring-brand-teal focus:ring-offset-2"
                          aria-pressed={selectedScheduleId === schedule.id}
                          onClick={() => {
                            setSelectedScheduleId(schedule.id);
                          }}
                        >
                          <span className="font-medium text-ink">
                            {safeLabel(
                              schedule.management_no,
                              schedule.model,
                              ko.common.noNumber,
                            )}
                            {schedule.model && schedule.management_no
                              ? ` · ${schedule.model}`
                              : ""}
                          </span>
                          <span className="text-sm text-steel">
                            {schedule.site_name} ·{" "}
                            {ko.inspection.cycles[schedule.cycle]} ·{" "}
                            {schedule.due_date} ·{" "}
                            {ko.inspection.fields.mechanic}:{" "}
                            {safeLabel(schedule.mechanic_display_name)}
                          </span>
                        </button>
                        <div className="flex items-center gap-2">
                          {schedule.status === "SCHEDULED" &&
                          isInspectionOverdue(schedule, businessDate) ? (
                            <Badge className="border-red-300 bg-red-50 text-red-800">
                              {ko.inspection.overdue}
                            </Badge>
                          ) : (
                            <Badge>
                              {ko.inspection.statuses[schedule.status]}
                            </Badge>
                          )}
                          {schedule.status === "SCHEDULED" &&
                          schedule.mechanic_id === session?.user_id ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
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
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {completingId === schedule.id ? (
                        <InspectionRoundForm
                          scheduleId={schedule.id}
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
                <LoadMoreButton
                  onClick={() => {
                    void loadMore();
                  }}
                  isLoading={loadingMore}
                  loaded={schedules.length}
                  total={scheduleTotal}
                />
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card className="grid gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">
              {ko.inspection.createTitle}
            </h2>
          </div>
          {notice ? (
            <p role="status" className="text-sm font-medium text-brand-teal">
              {notice}
            </p>
          ) : null}
          {createError ? <PageError message={createError} /> : null}
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="ins-branch"
              >
                {ko.inspection.fields.branch}
              </label>
              <Combobox
                id="ins-branch"
                options={branchOptions}
                value={form.branch_id}
                onChange={(v) => {
                  setField("branch_id", v);
                }}
                placeholder={ko.inspection.fields.branchPlaceholder}
              />
            </div>
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="ins-equipment"
              >
                {ko.inspection.fields.equipment}
              </label>
              <AsyncCombobox
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
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="ins-mechanic"
              >
                {ko.inspection.fields.mechanic}
              </label>
              <Combobox
                id="ins-mechanic"
                options={mechanicOptions}
                value={form.mechanic_id}
                onChange={(v) => {
                  setField("mechanic_id", v);
                }}
                placeholder={ko.inspection.fields.mechanicPlaceholder}
              />
            </div>
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="ins-cycle"
              >
                {ko.inspection.fields.cycle}
              </label>
              <Select
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
              </Select>
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
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createDisabled}>
                <CalendarPlus aria-hidden="true" size={16} />
                {creating ? ko.inspection.creating : ko.inspection.create}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
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
    <div className="grid gap-2">
      <label className="text-sm font-medium text-steel" htmlFor={id}>
        {label}
      </label>
      <Input
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
  onComplete: (
    scheduleId: string,
    outcome: InspectionRoundOutcome,
    findings: string,
    note: string,
  ) => Promise<boolean>;
  onCancel: () => void;
}

function InspectionRoundForm({
  scheduleId,
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
    const ok = await onComplete(scheduleId, outcome, findings.trim(), note);
    setSubmitting(false);
    if (!ok) setError(t.failed);
  }

  return (
    <form
      className="grid gap-3 rounded-md border border-line bg-muted-panel p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm font-semibold text-ink">{t.title}</p>
      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor={`round-outcome-${scheduleId}`}
        >
          {t.outcomeLabel}
        </label>
        <Select
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
        </Select>
      </div>
      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor={`round-findings-${scheduleId}`}
        >
          {t.findingsLabel}
        </label>
        <Textarea
          id={`round-findings-${scheduleId}`}
          placeholder={t.findingsPlaceholder}
          value={findings}
          onChange={(event) => {
            setFindings(event.currentTarget.value);
          }}
        />
      </div>
      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor={`round-note-${scheduleId}`}
        >
          {t.noteLabel}
        </label>
        <Input
          id={`round-note-${scheduleId}`}
          placeholder={t.notePlaceholder}
          value={note}
          onChange={(event) => {
            setNote(event.currentTarget.value);
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={submitting}
          onClick={onCancel}
        >
          {t.cancel}
        </Button>
        <Button type="submit" disabled={submitting || !findings.trim()}>
          {submitting ? t.submitting : t.submit}
        </Button>
      </div>
    </form>
  );
}
