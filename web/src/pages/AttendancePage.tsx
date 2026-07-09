import { useCallback, useEffect, useMemo, useState } from "react";

import { PageHeader } from "../components/shell/PageHeader";
import { PinButton } from "../components/shell/workspace/PinButton";
import { RefreshButton } from "../components/shell/RefreshButton";
import { attendanceRecordToPin } from "../features/workspace/adapters";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { formatKoreanDateTime } from "../lib/datetime";

const ATTENDANCE_KINDS = [
  "CLOCK_IN",
  "OUT_FOR_WORK",
  "BUSINESS_TRIP",
  "RETURNED",
  "CLOCK_OUT",
] as const;

type AttendanceKind = (typeof ATTENDANCE_KINDS)[number];
type AttendanceState =
  | "CLOCKED_IN"
  | "OUT_FOR_WORK"
  | "BUSINESS_TRIP"
  | "OFF_DUTY";
type ReadState = "loading" | "idle" | "error";
type ApiResult<T> = { data?: T; response: Response };

interface CreateEmployeeAttendanceRecordRequest {
  kind: AttendanceKind;
  idempotency_key: string;
}

interface EmployeeAttendanceRecord {
  id: string;
  kind: AttendanceKind;
  occurred_at: string;
  state_after: AttendanceState;
  note?: string | null;
  payroll_material_ref_id: string;
  duplicate: boolean;
}

interface EmployeeAttendanceRecordPage {
  items: EmployeeAttendanceRecord[];
}

interface RecordFailure {
  kind: AttendanceKind;
  idempotencyKey: string;
  status?: number;
}

interface AttendancePageProps {
  active?: boolean;
}

export function AttendancePage({ active = true }: AttendancePageProps = {}) {
  const { api, session } = useAuth();
  const t = ko.attendance;
  const [state, setState] = useState<ReadState>("loading");
  const [status, setStatus] = useState<number>();
  const [items, setItems] = useState<EmployeeAttendanceRecord[]>([]);
  const [action, setAction] = useState<AttendanceKind>();
  const [recordFailure, setRecordFailure] = useState<RecordFailure>();
  const [replayedRecordId, setReplayedRecordId] = useState<string>();
  const loadRecords = useCallback(async () => {
    setState("loading");
    setStatus(undefined);
    let failureStatus: number | undefined;
    const response = (await api
      .GET("/api/v1/hr/attendance-records/me", {
        params: { query: { limit: 50, offset: 0 } },
      })
      .catch((error: unknown) => {
        failureStatus = errorStatus(error);
        return undefined;
      })) as ApiResult<EmployeeAttendanceRecordPage> | undefined;

    if (response?.data === undefined) {
      setStatus(response ? response.response.status : failureStatus);
      setState("error");
      return;
    }

    setStatus(response.response.status);
    setItems(response.data.items);
    setState("idle");
  }, [api]);

  useEffect(() => {
    if (!active) return;
    void Promise.resolve().then(loadRecords);
  }, [active, loadRecords]);

  const latest = items.length > 0 ? items[0] : undefined;
  const currentState = latest?.state_after ?? "OFF_DUTY";
  const currentLabel = stateLabel(currentState);
  const idPrefix = session?.user_id ?? "employee";

  const handleRecord = useCallback(
    async (kind: AttendanceKind) => {
      const idempotencyKey =
        recordFailure?.kind === kind
          ? recordFailure.idempotencyKey
          : `${idPrefix}-${kind}-${String(Date.now())}`;
      const body: CreateEmployeeAttendanceRecordRequest = {
        kind,
        idempotency_key: idempotencyKey,
      };
      let failureStatus: number | undefined;

      setAction(kind);
      setStatus(undefined);
      setRecordFailure(undefined);
      setReplayedRecordId(undefined);

      const response = (await api
        .POST("/api/v1/hr/attendance-records/me", { body })
        .catch((error: unknown) => {
          failureStatus = errorStatus(error);
          return undefined;
        })) as ApiResult<EmployeeAttendanceRecord> | undefined;
      setAction(undefined);

      if (response?.data === undefined) {
        setRecordFailure({
          kind,
          idempotencyKey,
          status: response ? response.response.status : failureStatus,
        });
        return;
      }

      setStatus(response.response.status);
      setReplayedRecordId(response.data.duplicate ? response.data.id : undefined);
      await loadRecords();
    },
    [api, idPrefix, loadRecords, recordFailure],
  );

  const history = useMemo(() => items.slice(0, 10), [items]);

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadRecords();
            }}
            isLoading={state === "loading"}
          />
        }
      />

      <div className="grid max-w-5xl gap-5">
        {state === "error" ? (
          <PageError
            message={t.loadFailed}
            status={status}
            onRetry={() => {
              void loadRecords();
            }}
          />
        ) : null}

        <Card className="grid gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-steel">{t.currentState}</p>
              <h2 className="mt-1 text-2xl font-semibold text-ink">
                {currentLabel}
              </h2>
              <p className="mt-1 text-sm text-steel">
                {latest
                  ? t.latestMeta
                      .replace("{kind}", kindLabel(latest.kind))
                      .replace(
                        "{time}",
                        formatKoreanDateTime(latest.occurred_at),
                      )
                  : t.noLatest}
              </p>
            </div>
            {latest ? (
              <div className="rounded-lg border border-brand-teal/20 bg-brand-teal/5 px-3 py-2 text-sm text-brand-teal">
                <p className="font-semibold">{t.payrollLinked}</p>
                <p className="mt-1 text-xs">{latest.payroll_material_ref_id}</p>
              </div>
            ) : null}
          </div>
          {recordFailure ? (
            <div
              role="alert"
              className="grid gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              <p className="font-semibold">
                {t.recordFailed.replace("{kind}", kindLabel(recordFailure.kind))}
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={Boolean(action)}
                onClick={() => {
                  void handleRecord(recordFailure.kind);
                }}
              >
                {t.retryRecord.replace("{kind}", kindLabel(recordFailure.kind))}
              </Button>
              {recordFailure.status ? (
                <p className="text-xs">HTTP {recordFailure.status}</p>
              ) : null}
            </div>
          ) : null}

          {replayedRecordId ? (
            <p className="rounded-lg border border-brand-teal/20 bg-brand-teal/5 px-3 py-2 text-sm font-semibold text-brand-teal">
              {t.duplicateReplay}
            </p>
          ) : null}


          <div className="grid gap-2 sm:grid-cols-5">
            {ATTENDANCE_KINDS.map((kind) => (
              <Button
                key={kind}
                type="button"
                variant={kind === "CLOCK_IN" ? "default" : "secondary"}

                disabled={Boolean(action)}
                onClick={() => {
                  void handleRecord(kind);
                }}
              >
                {action === kind ? t.recording : t.actions[kind]}
              </Button>
            ))}
          </div>

          <p className="text-sm text-steel">{t.legalNotice}</p>
        </Card>

        <Card className="grid gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">{t.historyTitle}</h2>
            <p className="text-sm text-steel">{t.historyDescription}</p>
          </div>

          {history.length === 0 && state === "idle" ? (
            <PageEmpty message={t.empty} />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead>
                  <tr className="text-left text-steel">
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t.columns.kind}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t.columns.occurredAt}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t.columns.stateAfter}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t.columns.note}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t.columns.payroll}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      <span className="sr-only">{t.pinColumn}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.map((record) => (
                    <tr key={record.id}>
                      <td className="px-3 py-2 font-medium text-ink">
                        {kindLabel(record.kind)}
                      </td>
                      <td className="px-3 py-2 text-steel">
                        {formatKoreanDateTime(record.occurred_at)}
                      </td>
                      <td className="px-3 py-2 text-steel">
                        {stateLabel(record.state_after)}
                      </td>
                      <td className="px-3 py-2 text-steel">
                        {noteLabel(record.note)}
                      </td>
                      <td className="px-3 py-2 text-steel">
                        {t.linked}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <PinButton
                          object={attendanceRecordToPin({
                            code: record.payroll_material_ref_id,
                            kindLabel: kindLabel(record.kind),
                            occurredLabel: formatKoreanDateTime(record.occurred_at),
                            stateLabel: stateLabel(record.state_after),
                            note: noteLabel(record.note),
                          })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function kindLabel(kind: string): string {
  const labels = ko.attendance.kinds as Record<string, string | undefined>;
  return labels[kind] ?? kind;
}

function stateLabel(state: string): string {
  const labels = ko.attendance.states as Record<string, string | undefined>;
  return labels[state] ?? state;
}

function noteLabel(note: string | null | undefined): string {
  return note?.trim() || ko.attendance.noNote;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}
