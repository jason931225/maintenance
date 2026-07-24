import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { components } from "@maintenance/api-client-ts";
import type { ConsoleApiClient } from "../../api/client";
import {
  DataTable,
  type DataTableColumn,
} from "../../components/ui/data-table";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { PageEmpty } from "../../components/states/PageEmpty";
import { PageError } from "../../components/states/PageError";
import { SkeletonTable } from "../../components/states/Skeleton";

type Run = components["schemas"]["PayrollRunSummary"];
type Line = components["schemas"]["PayrollLineSummary"];
type Detail = components["schemas"]["PayrollRunDetail"];
type State = "loading" | "ready" | "error" | "denied";
type DetailState =
  | { kind: "idle" }
  | { kind: "loading" | "error" | "denied"; run: Run }
  | {
      kind: "ready";
      run: Run;
      lines: Line[];
      total: number;
      nextOffset: number | null;
    };
const RUN_LIMIT = 50,
  LINE_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RUN_STATUSES = new Set([
  "STAGED",
  "BLOCKED_LEGAL_GATE",
  "READY_FOR_REVIEW",
  "APPROVED",
  "ISSUED",
  "VOID",
]);
const TAX_ROW_STATUSES = new Set([
  "REQUIRED_NOT_SUPPLIED",
  "SUPPLIED_UNVERIFIED",
  "VERIFIED_SOURCE_ROW",
]);
const LINE_STATUSES = new Set([
  "BLOCKED_LEGAL_GATE",
  "READY_FOR_REVIEW",
  "APPROVED",
  "ISSUED",
  "VOID",
]);
const labels: Record<string, string> = {
  STAGED: "산정 중",
  BLOCKED_LEGAL_GATE: "법정 게이트 차단",
  READY_FOR_REVIEW: "검토 대기",
  APPROVED: "승인됨",
  ISSUED: "발행됨",
  VOID: "무효",
};
const tone = (s: string) =>
  s === "BLOCKED_LEGAL_GATE" || s === "VOID"
    ? "border-red-200 bg-red-50 text-red-800"
    : s === "STAGED" || s === "READY_FOR_REVIEW"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-emerald-200 bg-emerald-50 text-emerald-800";
const hours = (n: number | null | undefined) =>
  n == null ? "—" : `${n.toFixed(1)}시간`;
const denied = (response: Response) =>
  response.status === 401 || response.status === 403;
function validRun(value: unknown): value is Run {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<Run>;
  return (
    typeof r.id === "string" &&
    UUID.test(r.id) &&
    typeof r.source_label === "string" &&
    typeof r.period_start === "string" &&
    typeof r.period_end === "string" &&
    typeof r.calculation_enabled === "boolean" &&
    typeof r.status === "string" &&
    RUN_STATUSES.has(r.status)
  );
}
function nullableFiniteNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}
function validLine(value: unknown): value is Line {
  if (typeof value !== "object" || value === null) return false;
  const l = value as Partial<Line>;
  return (
    typeof l.id === "string" &&
    UUID.test(l.id) &&
    typeof l.employee_display_name === "string" &&
    typeof l.employee_company === "string" &&
    typeof l.calculation_status === "string" &&
    LINE_STATUSES.has(l.calculation_status) &&
    typeof l.gross_pay_source_present === "boolean" &&
    typeof l.net_pay_source_present === "boolean" &&
    typeof l.nts_tax_row_status === "string" &&
    TAX_ROW_STATUSES.has(l.nts_tax_row_status) &&
    nullableFiniteNumber(l.regular_hours) &&
    nullableFiniteNumber(l.overtime_hours)
  );
}
function validPage(
  value: unknown,
  offset: number,
  limit: number,
  kind: "runs" | "lines",
  id?: string,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const items = kind === "runs" ? v.items : v.lines;
  const total = kind === "runs" ? v.total : v.lines_total;
  const gotLimit = kind === "runs" ? v.limit : v.lines_limit;
  const gotOffset = kind === "runs" ? v.offset : v.lines_offset;
  return (
    Array.isArray(items) &&
    typeof total === "number" &&
    Number.isSafeInteger(total) &&
    total >= 0 &&
    gotLimit === limit &&
    gotOffset === offset &&
    items.length <= limit &&
    offset <= total &&
    offset + items.length <= total &&
    (offset >= total || items.length > 0) &&
    (kind === "runs"
      ? items.every(validRun)
      : !!v.run &&
        validRun(v.run) &&
        v.run.id === id &&
        items.every(validLine)) &&
    new Set(
      items.map((item) =>
        typeof item === "object" && item !== null
          ? (item as { id?: unknown }).id
          : undefined,
      ),
    ).size === items.length
  );
}
function appendsWithoutDuplicateIds<T extends { id: string }>(
  existing: readonly T[],
  page: readonly T[],
): boolean {
  const known = new Set(existing.map((item) => item.id));
  return page.every((item) => !known.has(item.id));
}
export function PayrollCloseWorkspace({
  api,
  authorityKey,
}: {
  api: ConsoleApiClient;
  authorityKey: string;
}) {
  const [runs, setRuns] = useState<Run[]>([]),
    [total, setTotal] = useState(0),
    [runsState, setRunsState] = useState<State>("loading"),
    [detail, setDetail] = useState<DetailState>({ kind: "idle" });
  const runsRef = useRef<Run[]>([]),
    totalRef = useRef<number | null>(null),
    listReq = useRef<AbortController | null>(null),
    detailReq = useRef<AbortController | null>(null),
    listGen = useRef(0),
    detailGen = useRef(0);
  const cancelDetail = useCallback(() => {
    detailGen.current++;
    detailReq.current?.abort();
  }, []);
  const loadRuns = useCallback(
    async (more = false) => {
      listReq.current?.abort();
      cancelDetail();
      const controller = new AbortController();
      listReq.current = controller;
      const generation = ++listGen.current;
      const offset = more ? runsRef.current.length : 0;
      if (!more) {
        runsRef.current = [];
        totalRef.current = null;
        setRuns([]);
        setTotal(0);
        setDetail({ kind: "idle" });
      }
      setRunsState("loading");
      try {
        const response = await api.GET("/api/v1/payroll/runs", {
          params: { query: { limit: RUN_LIMIT, offset } },
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== listGen.current) return;
        if (
          !response.data ||
          !validPage(response.data, offset, RUN_LIMIT, "runs") ||
          (more && response.data.total !== totalRef.current) ||
          !appendsWithoutDuplicateIds(
            more ? runsRef.current : [],
            response.data.items,
          )
        ) {
          setRunsState(denied(response.response) ? "denied" : "error");
          return;
        }
        const page = response.data;
        const next = more ? [...runsRef.current, ...page.items] : page.items;
        runsRef.current = next;
        totalRef.current = page.total;
        setRuns(next);
        setTotal(page.total);
        setRunsState("ready");
      } catch {
        if (!controller.signal.aborted && generation === listGen.current)
          setRunsState("error");
      }
    },
    [api, cancelDetail],
  );
  const loadDetail = useCallback(
    async (run: Run, more = false) => {
      detailReq.current?.abort();
      const controller = new AbortController();
      detailReq.current = controller;
      const generation = ++detailGen.current;
      const prior = detail;
      const priorReady =
        prior.kind === "ready" && prior.run.id === run.id ? prior : undefined;
      const offset = more && priorReady ? priorReady.lines.length : 0;
      setDetail({ kind: "loading", run });
      try {
        const response = await api.GET("/api/v1/payroll/runs/{id}", {
          params: {
            path: { id: run.id },
            query: { limit: LINE_LIMIT, offset },
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== detailGen.current)
          return;
        if (
          !response.data ||
          !validPage(response.data, offset, LINE_LIMIT, "lines", run.id) ||
          (more && response.data.lines_total !== priorReady?.total) ||
          !appendsWithoutDuplicateIds(
            more && priorReady ? priorReady.lines : [],
            response.data.lines,
          )
        ) {
          setDetail({
            kind: denied(response.response) ? "denied" : "error",
            run,
          });
          return;
        }
        const d: Detail = response.data;
        const lines =
          more && priorReady ? [...priorReady.lines, ...d.lines] : d.lines;
        setDetail({
          kind: "ready",
          run: d.run,
          lines,
          total: d.lines_total,
          nextOffset: lines.length < d.lines_total ? lines.length : null,
        });
      } catch {
        if (!controller.signal.aborted && generation === detailGen.current)
          setDetail({ kind: "error", run });
      }
    },
    [api, detail],
  );
  useEffect(() => {
    void Promise.resolve().then(() => loadRuns());
    return () => {
      listReq.current?.abort();
      cancelDetail();
    };
  }, [api, authorityKey, cancelDetail, loadRuns]);
  const cols = useMemo<Array<DataTableColumn<Run>>>(
    () => [
      {
        key: "run",
        header: "지급 기간",
        cell: (r) => (
          <>
            <b>{r.source_label}</b>
            <p className="text-xs text-steel">
              {r.period_start} ~ {r.period_end}
            </p>
          </>
        ),
      },
      {
        key: "status",
        header: "마감 상태",
        cell: (r) => (
          <Badge className={tone(r.status)}>{labels[r.status]}</Badge>
        ),
      },
      {
        key: "calc",
        header: "산정",
        cell: (r) => (
          <span>{r.calculation_enabled ? "산정 가능" : "산정 차단"}</span>
        ),
      },
    ],
    [],
  );
  const lineCols: Array<DataTableColumn<Line>> = [
    {
      key: "employee",
      header: "직원",
      cell: (l) => (
        <>
          <b>{l.employee_display_name}</b>
          <p className="text-xs text-steel">{l.employee_company}</p>
        </>
      ),
    },
    { key: "regular", header: "정규", cell: (l) => hours(l.regular_hours) },
    { key: "overtime", header: "연장", cell: (l) => hours(l.overtime_hours) },
    {
      key: "source",
      header: "원천",
      cell: (l) => (
        <span>
          {l.gross_pay_source_present &&
          l.net_pay_source_present &&
          l.nts_tax_row_status === "VERIFIED_SOURCE_ROW"
            ? "확인된 원천 행"
            : "검증 또는 원천 누락"}
        </span>
      ),
    },
    {
      key: "status",
      header: "산정 상태",
      cell: (l) => (
        <Badge className={tone(l.calculation_status)}>
          {labels[l.calculation_status]}
        </Badge>
      ),
    },
  ];
  return (
    <div className="grid min-w-0 gap-4">
      <Card className="grid gap-3">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-steel">급여 · 마감 운영</p>
            <h2 className="text-lg font-bold">급여 마감 명부</h2>
            <p className="text-sm text-steel">
              감사되는 회차와 직원별 준비 상태를 읽기 전용으로 확인합니다.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void loadRuns()}
            disabled={runsState === "loading"}
          >
            새로고침
          </Button>
        </div>
        {runsState === "loading" && !runs.length ? (
          <SkeletonTable rows={4} cols={3} />
        ) : null}
        {runsState === "denied" ? (
          <PageError
            status={403}
            message="급여 회차 명부 열람 권한이 없습니다."
          />
        ) : null}
        {runsState === "error" ? (
          <PageError
            message="급여 회차 명부를 불러오지 못했습니다."
            onRetry={() => void loadRuns()}
          />
        ) : null}
        {runsState === "ready" && !runs.length ? (
          <PageEmpty message="현재 조회 가능한 급여 회차가 없습니다." />
        ) : null}
        {runs.length ? (
          <>
            <DataTable
              rows={runs}
              columns={cols}
              getRowKey={(r) => r.id}
              getRowAriaLabel={(r) =>
                `${r.source_label} ${labels[r.status]} 상세 열기`
              }
              onRowClick={(r) => void loadDetail(r)}
            />
            {runs.length < total ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void loadRuns(true)}
                disabled={runsState === "loading"}
              >
                회차 더 불러오기
              </Button>
            ) : null}
          </>
        ) : null}
      </Card>
      {detail.kind === "loading" ? (
        <Card aria-busy="true">
          <SkeletonTable rows={3} cols={5} />
        </Card>
      ) : null}
      {detail.kind === "denied" ? (
        <Card>
          <PageError
            status={403}
            message="이 급여 회차 상세 열람 권한이 없습니다."
          />
        </Card>
      ) : null}
      {detail.kind === "error" ? (
        <Card>
          <PageError
            message="급여 회차 상세를 불러오지 못했습니다."
            onRetry={() => void loadDetail(detail.run)}
          />
        </Card>
      ) : null}
      {detail.kind === "ready" ? (
        <Card className="grid gap-3">
          <div>
            <p className="text-xs font-bold text-steel">선택된 회차</p>
            <h2 className="text-lg font-bold">급여 회차 상세</h2>
            <p className="text-sm text-steel">
              {detail.run.source_label} · {detail.run.period_start} ~{" "}
              {detail.run.period_end}
            </p>
          </div>
          {detail.lines.length ? (
            <DataTable
              rows={detail.lines}
              columns={lineCols}
              getRowKey={(l) => l.id}
            />
          ) : (
            <PageEmpty message="이 회차에는 현재 조회 가능한 직원별 급여 준비 행이 없습니다." />
          )}
          {detail.nextOffset !== null ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void loadDetail(detail.run, true)}
            >
              직원 행 더 불러오기
            </Button>
          ) : null}
          <p className="text-xs text-steel">
            승인·발행·명세 배포 작업은 현재 읽기 API 계약에 포함되지 않아 이
            화면에서 실행하지 않습니다.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
