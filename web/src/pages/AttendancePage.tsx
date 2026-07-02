import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConsoleApiClient } from "../api/client";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
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
type ReadState = "loading" | "idle" | "error";

interface CreateEmployeeAttendanceRecordRequest {
  kind: AttendanceKind;
  idempotency_key: string;
  note?: string;
}

interface EmployeeAttendanceRecord {
  id: string;
  employee_id: string;
  employee_display_name: string;
  kind: AttendanceKind;
  occurred_at: string;
  work_date: string;
  state_after: string;
  note?: string | null;
  payroll_material_ref_id: string;
  payroll_link_status: string;
  duplicate: boolean;
}

interface EmployeeAttendanceRecordPage {
  items: EmployeeAttendanceRecord[];
  total: number;
  limit: number;
  offset: number;
}

type AttendanceApi = ConsoleApiClient & {
  GET(
    path: "/api/v1/hr/attendance-records/me",
    options?: { params?: { query?: { limit?: number; offset?: number } } },
  ): Promise<{ data?: EmployeeAttendanceRecordPage; response: Response }>;
  POST(
    path: "/api/v1/hr/attendance-records/me",
    options: { body: CreateEmployeeAttendanceRecordRequest },
  ): Promise<{ data?: EmployeeAttendanceRecord; response: Response }>;
};

export function AttendancePage() {
  const { api, session } = useAuth();
  const attendanceApi = api as AttendanceApi;
  const t = ko.attendance;
  const [state, setState] = useState<ReadState>("loading");
  const [status, setStatus] = useState<number>();
  const [items, setItems] = useState<EmployeeAttendanceRecord[]>([]);
  const [action, setAction] = useState<AttendanceKind>();

  const loadRecords = useCallback(async () => {
    setState("loading");
    setStatus(undefined);
    const response = await attendanceApi
      .GET("/api/v1/hr/attendance-records/me", {
        params: { query: { limit: 50, offset: 0 } },
      })
      .catch((error: unknown) => {
        setStatus(errorStatus(error));
        return undefined;
      });

    if (!response?.data) {
      setStatus(response?.response.status);
      setState("error");
      return;
    }

    setStatus(response.response.status);
    setItems(response.data.items);
    setState("idle");
  }, [attendanceApi]);

  useEffect(() => {
    void Promise.resolve().then(loadRecords);
  }, [loadRecords]);

  const latest = items.length > 0 ? items[0] : undefined;
  const currentState = latest?.state_after ?? "OFF_DUTY";
  const currentLabel = stateLabel(currentState);
  const idPrefix = session?.user_id ?? "employee";

  const handleRecord = useCallback(
    async (kind: AttendanceKind) => {
      setAction(kind);
      setStatus(undefined);
      const response = await attendanceApi
        .POST("/api/v1/hr/attendance-records/me", {
          body: {
            kind,
            idempotency_key: `${idPrefix}-${kind}-${String(Date.now())}`,
          },
        })
        .catch((error: unknown) => {
          setStatus(errorStatus(error));
          return undefined;
        });
      setAction(undefined);

      if (!response?.data) {
        setStatus(response?.response.status);
        setState("error");
        return;
      }

      setStatus(response.response.status);
      await loadRecords();
    },
    [attendanceApi, idPrefix, loadRecords],
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

          <div className="grid gap-2 sm:grid-cols-5">
            {ATTENDANCE_KINDS.map((kind) => (
              <Button
                key={kind}
                type="button"
                variant={kind === "CLOCK_IN" ? "default" : "secondary"}
                aria-label={t.actions[kind]}
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

          {history.length === 0 && state !== "loading" ? (
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
                      {t.columns.payroll}
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
                        {record.payroll_link_status === "LINKED"
                          ? t.linked
                          : t.linkPending}
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

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}
