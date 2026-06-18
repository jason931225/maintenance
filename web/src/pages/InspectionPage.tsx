import { CalendarPlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  CreateInspectionScheduleRequest,
  InspectionCycle,
  InspectionScheduleSummary,
} from "../api/types";
import { useAuth } from "../context/auth";
import { PageError } from "../components/states/PageError";
import { PageHeader } from "../components/shell/PageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { ko } from "../i18n/ko";

const CYCLES: InspectionCycle[] = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
  "CUSTOM",
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
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
    interval_days: "30",
    due_date: today(),
    note: "",
  };
}

export function InspectionPage() {
  const { api } = useAuth();
  const [rangeStart, setRangeStart] = useState(today);
  const [rangeEnd, setRangeEnd] = useState(() => plusDays(30));
  const [schedules, setSchedules] = useState<InspectionScheduleSummary[]>();
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [createError, setCreateError] = useState<string>();

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const response = await api.GET("/api/v1/inspections/schedules", {
        params: { query: { due_start: rangeStart, due_end: rangeEnd } },
      });
      if (response.data) {
        setSchedules(response.data);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    }
  }, [api, rangeStart, rangeEnd]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleCreate() {
    setCreating(true);
    setNotice(undefined);
    setCreateError(undefined);
    try {
      const body: CreateInspectionScheduleRequest = {
        branch_id: form.branch_id.trim(),
        equipment_id: form.equipment_id.trim(),
        mechanic_id: form.mechanic_id.trim(),
        cycle: form.cycle,
        interval_days: Number(form.interval_days),
        due_date: form.due_date,
        note: form.note.trim() || null,
      };
      const response = await api.POST("/api/v1/inspections/schedules", { body });
      if (response.data) {
        setNotice(ko.inspection.createSuccess);
        setForm(emptyForm());
        await load();
      } else {
        setCreateError(ko.inspection.createFailed);
      }
    } catch {
      setCreateError(ko.inspection.createFailed);
    } finally {
      setCreating(false);
    }
  }

  const createDisabled =
    creating ||
    !form.branch_id.trim() ||
    !form.equipment_id.trim() ||
    !form.mechanic_id.trim() ||
    !form.due_date ||
    Number.isNaN(Number(form.interval_days));

  return (
    <>
      <PageHeader
        title={ko.inspection.title}
        description={ko.inspection.description}
      />
      <div className="grid max-w-4xl gap-5">
        <Card className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-slate-700"
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
                className="text-sm font-medium text-slate-700"
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

          {loadError ? <PageError message={ko.inspection.loadFailed} /> : null}
          {schedules && schedules.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
              {ko.inspection.empty}
            </p>
          ) : null}
          {schedules && schedules.length > 0 ? (
            <div className="grid gap-2">
              <h2 className="text-base font-semibold text-slate-950">
                {ko.inspection.listTitle}
              </h2>
              <ul className="grid gap-2">
                {schedules.map((schedule) => (
                  <li
                    key={schedule.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 p-3"
                  >
                    <div className="grid gap-1">
                      <span className="font-medium text-slate-950">
                        {schedule.management_no ?? schedule.equipment_id}
                        {schedule.model ? ` · ${schedule.model}` : ""}
                      </span>
                      <span className="text-sm text-slate-600">
                        {schedule.site_name} ·{" "}
                        {ko.inspection.cycles[schedule.cycle]} ·{" "}
                        {schedule.due_date}
                      </span>
                    </div>
                    {schedule.status === "SCHEDULED" &&
                    schedule.due_date < today() ? (
                      <Badge className="border-red-300 bg-red-50 text-red-800">
                        {ko.inspection.overdue}
                      </Badge>
                    ) : (
                      <Badge>{ko.inspection.statuses[schedule.status]}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card className="grid gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              {ko.inspection.createTitle}
            </h2>
          </div>
          {notice ? (
            <p role="status" className="text-sm font-medium text-emerald-700">
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
            <Field
              id="ins-branch"
              label={ko.inspection.fields.branchId}
              value={form.branch_id}
              onChange={(v) => {
                setField("branch_id", v);
              }}
            />
            <Field
              id="ins-equipment"
              label={ko.inspection.fields.equipmentId}
              value={form.equipment_id}
              onChange={(v) => {
                setField("equipment_id", v);
              }}
            />
            <Field
              id="ins-mechanic"
              label={ko.inspection.fields.mechanicId}
              value={form.mechanic_id}
              onChange={(v) => {
                setField("mechanic_id", v);
              }}
            />
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-slate-700"
                htmlFor="ins-cycle"
              >
                {ko.inspection.fields.cycle}
              </label>
              <Select
                id="ins-cycle"
                value={form.cycle}
                onChange={(event) => {
                  setField(
                    "cycle",
                    event.currentTarget.value as InspectionCycle,
                  );
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
      <label className="text-sm font-medium text-slate-700" htmlFor={id}>
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
