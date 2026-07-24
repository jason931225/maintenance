import { useCallback, useEffect, useMemo, useState } from "react";

import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";
import { DataTable, type DataTableColumn } from "../../components/ui/data-table";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { PageEmpty } from "../../components/states/PageEmpty";
import { PageError } from "../../components/states/PageError";
import { SkeletonTable } from "../../components/states/Skeleton";

type PayrollRun = components["schemas"]["PayrollRunSummary"];
type PayrollRunDetail = components["schemas"]["PayrollRunDetail"];
type PayrollLine = components["schemas"]["PayrollLineSummary"];
type RunStatus = PayrollRun["status"];
type DetailState =
  | { kind: "idle" }
  | { kind: "loading"; run: PayrollRun }
  | { kind: "ready"; detail: PayrollRunDetail }
  | { kind: "error"; run: PayrollRun; status?: number };

type PayrollCloseWorkspaceProps = {
  /** Authenticated generated API transport. The route owns auth/session injection. */
  api: ConsoleApiClient;
};

const RUN_LIMIT = 50;
const LINES_LIMIT = 500;

const runStatusLabel: Record<RunStatus, string> = {
  STAGED: "산정 중",
  BLOCKED_LEGAL_GATE: "법정 게이트 차단",
  READY_FOR_REVIEW: "검토 대기",
  APPROVED: "승인됨",
  ISSUED: "발행됨",
  VOID: "무효",
};

const lineStatusLabel: Record<PayrollLine["calculation_status"], string> = {
  BLOCKED_LEGAL_GATE: "법정 게이트 차단",
  READY_FOR_REVIEW: "검토 대기",
  APPROVED: "승인됨",
  ISSUED: "발행됨",
  VOID: "무효",
};

function toneForStatus(status: RunStatus | PayrollLine["calculation_status"]) {
  if (status === "BLOCKED_LEGAL_GATE" || status === "VOID") {
    return "border-red-200 bg-red-50 text-red-800";
  }
  if (status === "READY_FOR_REVIEW" || status === "STAGED") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
}

function formatHours(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}시간`;
}

function sourceReadiness(line: PayrollLine) {
  if (!line.gross_pay_source_present || !line.net_pay_source_present) {
    return "원천 누락";
  }
  return line.nts_tax_row_status === "VERIFIED_SOURCE_ROW"
    ? "확인된 원천 행"
    : "검증 대기 원천 행";
}

function formatPeriod(run: PayrollRun) {
  return `${run.period_start} ~ ${run.period_end}`;
}

function requestStatus(response: Response) {
  return response.status === 401 || response.status === 403 ? response.status : undefined;
}

/**
 * Read-only close-to-payslip workspace. It deliberately exposes no approval,
 * issuance, or publication control until a corresponding write endpoint exists.
 */
export function PayrollCloseWorkspace({ api }: PayrollCloseWorkspaceProps) {
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error" | "denied">("loading");
  const [detailState, setDetailState] = useState<DetailState>({ kind: "idle" });

  const loadRuns = useCallback(async () => {
    setListState("loading");
    setDetailState({ kind: "idle" });
    try {
      const response = await api.GET("/api/v1/payroll/runs", {
        params: { query: { limit: RUN_LIMIT, offset: 0 } },
      });
      if (!response.data) {
        setListState(requestStatus(response.response) ? "denied" : "error");
        return;
      }
      setRuns(response.data.items);
      setListState("ready");
    } catch {
      setListState("error");
    }
  }, [api]);

  const loadDetail = useCallback(
    async (run: PayrollRun) => {
      setDetailState({ kind: "loading", run });
      try {
        const response = await api.GET("/api/v1/payroll/runs/{id}", {
          params: { path: { id: run.id }, query: { limit: LINES_LIMIT, offset: 0 } },
        });
        if (!response.data || response.data.run.id !== run.id) {
          setDetailState({ kind: "error", run, status: requestStatus(response.response) });
          return;
        }
        setDetailState({ kind: "ready", detail: response.data });
      } catch {
        setDetailState({ kind: "error", run });
      }
    },
    [api],
  );

  useEffect(() => {
    void Promise.resolve().then(loadRuns);
  }, [loadRuns]);

  const runColumns = useMemo<Array<DataTableColumn<PayrollRun>>>(
    () => [
      {
        key: "period",
        header: "지급 기간",
        cell: (run) => (
          <div className="min-w-40">
            <p className="font-semibold text-ink">{run.source_label}</p>
            <p className="mt-1 text-xs text-steel">{formatPeriod(run)}</p>
          </div>
        ),
      },
      {
        key: "status",
        header: "마감 상태",
        cell: (run) => (
          <Badge className={toneForStatus(run.status)}>{runStatusLabel[run.status]}</Badge>
        ),
      },
      {
        key: "calculation",
        header: "산정",
        cell: (run) => (
          <span className={run.calculation_enabled ? "font-semibold text-emerald-800" : "font-semibold text-red-800"}>
            {run.calculation_enabled ? "산정 가능" : "산정 차단"}
          </span>
        ),
      },
      {
        key: "updated",
        header: "최근 갱신",
        cell: (run) => <time dateTime={run.updated_at}>{run.updated_at.slice(0, 10)}</time>,
      },
    ],
    [],
  );

  return (
    <div className="grid min-w-0 gap-4">
      <Card aria-labelledby="payroll-close-heading" className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold tracking-wide text-steel">급여 · 마감 운영</p>
            <h2 id="payroll-close-heading" className="text-lg font-bold text-ink">급여 마감 명부</h2>
            <p className="max-w-3xl text-sm text-steel">
              회차와 직원별 원천·근태 준비 상태를 감사되는 읽기 전용 계약으로 확인합니다.
            </p>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => { void loadRuns(); }} disabled={listState === "loading"}>
            새로고침
          </Button>
        </div>

        {listState === "loading" ? <SkeletonTable rows={4} cols={4} /> : null}
        {listState === "denied" ? (
          <PageError message="급여 회차 명부 열람 권한이 없습니다." status={403} />
        ) : null}
        {listState === "error" ? (
          <PageError
            message="급여 회차 명부를 불러오지 못했습니다."
            onRetry={() => { void loadRuns(); }}
          />
        ) : null}
        {listState === "ready" && runs.length === 0 ? (
          <PageEmpty message="현재 조회 가능한 급여 회차가 없습니다." />
        ) : null}
        {listState === "ready" && runs.length > 0 ? (
          <DataTable
            rows={runs}
            columns={runColumns}
            getRowKey={(run) => run.id}
            getRowAriaLabel={(run) => `${run.source_label} ${runStatusLabel[run.status]} 상세 열기`}
            onRowClick={(run) => { void loadDetail(run); }}
          />
        ) : null}
      </Card>

      <PayrollRunDetailPanel detailState={detailState} onRetry={loadDetail} />
    </div>
  );
}

function PayrollRunDetailPanel({
  detailState,
  onRetry,
}: {
  detailState: DetailState;
  onRetry: (run: PayrollRun) => Promise<void>;
}) {
  if (detailState.kind === "idle") return null;
  if (detailState.kind === "loading") {
    return <Card aria-busy="true"><SkeletonTable rows={4} cols={5} /></Card>;
  }
  if (detailState.kind === "error") {
    const denied = detailState.status === 401 || detailState.status === 403;
    return (
      <Card>
        <PageError
          message={denied ? "이 급여 회차 상세 열람 권한이 없습니다." : "급여 회차 상세를 불러오지 못했습니다."}
          status={detailState.status}
          onRetry={denied ? undefined : () => { void onRetry(detailState.run); }}
        />
      </Card>
    );
  }

  const { detail } = detailState;
  const columns: Array<DataTableColumn<PayrollLine>> = [
    {
      key: "employee",
      header: "직원",
      cell: (line) => <><p className="font-semibold text-ink">{line.employee_display_name}</p><p className="text-xs text-steel">{line.employee_company}</p></>,
    },
    { key: "regular", header: "정규", cell: (line) => formatHours(line.regular_hours) },
    { key: "overtime", header: "연장", cell: (line) => formatHours(line.overtime_hours) },
    {
      key: "source",
      header: "원천",
      cell: (line) => <span className={sourceReadiness(line) === "확인된 원천 행" ? "font-semibold text-emerald-800" : "font-semibold text-amber-900"}>{sourceReadiness(line)}</span>,
    },
    {
      key: "status",
      header: "산정 상태",
      cell: (line) => <Badge className={toneForStatus(line.calculation_status)}>{lineStatusLabel[line.calculation_status]}</Badge>,
    },
  ];

  return (
    <Card aria-labelledby="payroll-run-detail-heading" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold tracking-wide text-steel">선택된 회차</p>
          <h2 id="payroll-run-detail-heading" className="text-lg font-bold text-ink">급여 회차 상세</h2>
          <p className="text-sm text-steel">{detail.run.source_label} · {formatPeriod(detail.run)}</p>
        </div>
        <Badge className={toneForStatus(detail.run.status)}>{runStatusLabel[detail.run.status]}</Badge>
      </div>
      {detail.lines.length === 0 ? (
        <PageEmpty message="이 회차에는 현재 조회 가능한 직원별 급여 준비 행이 없습니다." />
      ) : (
        <DataTable
          rows={detail.lines}
          columns={columns}
          getRowKey={(line) => line.id}
          footer={
            <p className="border-t border-line px-4 py-3 text-xs text-steel">
              현재 {detail.lines_offset + 1}–{detail.lines_offset + detail.lines.length} / {detail.lines_total}명 표시 · 승인·발행·명세 배포 작업은 현재 읽기 API 계약에 포함되지 않아 이 화면에서 실행하지 않습니다.
            </p>
          }
        />
      )}
    </Card>
  );
}
