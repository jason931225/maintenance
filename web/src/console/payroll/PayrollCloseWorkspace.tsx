import { useCallback, useEffect, useRef, useState } from "react";
import type { components } from "@maintenance/api-client-ts";
import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import "../tokens.css";
import "./PayrollCloseWorkspace.css";

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
const copy = ko.payroll.closeWorkspace;

const tone = (s: string) =>
  s === "BLOCKED_LEGAL_GATE" || s === "VOID"
    ? "danger"
    : s === "STAGED" || s === "READY_FOR_REVIEW"
      ? "warn"
      : "ok";
const hours = (n: number | null | undefined) =>
  n == null ? copy.hours.unavailable : copy.hours.value(n);
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
function nullableFiniteNumber(
  value: unknown,
): value is number | null | undefined {
  return value == null || (typeof value === "number" && Number.isFinite(value));
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
  return (
    <div className="console payroll-close">
      <section className="payroll-close__card">
        <div className="payroll-close__header">
          <div>
            <p className="payroll-close__eyebrow">{copy.list.eyebrow}</p>
            <h2 className="payroll-close__title">{copy.list.title}</h2>
            <p className="payroll-close__description">
              {copy.list.description}
            </p>
          </div>
          <button
            className="payroll-close__button"
            type="button"
            onClick={() => void loadRuns()}
            disabled={runsState === "loading"}
          >
            {copy.list.refresh}
          </button>
        </div>
        {runsState === "loading" && !runs.length ? (
          <div className="payroll-close__skeleton" aria-busy="true" />
        ) : null}
        {runsState === "denied" ? (
          <div className="payroll-close__error" role="alert">
            <p>{copy.list.denied}</p>
          </div>
        ) : null}
        {runsState === "error" ? (
          <div className="payroll-close__error" role="alert">
            <p>{copy.list.error}</p>
            <button
              className="payroll-close__button"
              type="button"
              onClick={() => void loadRuns()}
            >
              {ko.page.retry}
            </button>
          </div>
        ) : null}
        {runsState === "ready" && !runs.length ? (
          <p className="payroll-close__empty">{copy.list.empty}</p>
        ) : null}
        {runs.length ? (
          <>
            <div className="payroll-close__table-wrap">
              <table className="payroll-close__table">
                <thead>
                  <tr>
                    <th>{copy.columns.period}</th>
                    <th>{copy.columns.status}</th>
                    <th>{copy.columns.calculation}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="payroll-close__row">
                      <td>
                        <button
                          className="payroll-close__button payroll-close__row-action"
                          type="button"
                          aria-label={copy.list.detailAria(
                            run.source_label,
                            copy.statuses[run.status],
                          )}
                          onClick={() => void loadDetail(run)}
                        >
                          <span className="payroll-close__row-label">
                            {run.source_label}
                          </span>
                          <span className="payroll-close__meta">
                            {run.period_start} ~ {run.period_end}
                          </span>
                        </button>
                      </td>
                      <td>
                        <span
                          className={`payroll-close__status payroll-close__status--${tone(run.status)}`}
                        >
                          {copy.statuses[run.status]}
                        </span>
                      </td>
                      <td>
                        {run.calculation_enabled
                          ? copy.calculation.enabled
                          : copy.calculation.blocked}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runs.length < total ? (
              <button
                className="payroll-close__button"
                type="button"
                onClick={() => void loadRuns(true)}
                disabled={runsState === "loading"}
              >
                {copy.list.loadMore}
              </button>
            ) : null}
          </>
        ) : null}
      </section>
      {detail.kind === "loading" ? (
        <section className="payroll-close__card" aria-busy="true">
          <div className="payroll-close__skeleton" />
        </section>
      ) : null}
      {detail.kind === "denied" ? (
        <section className="payroll-close__card">
          <div className="payroll-close__error" role="alert">
            <p>{copy.detail.denied}</p>
          </div>
        </section>
      ) : null}
      {detail.kind === "error" ? (
        <section className="payroll-close__card">
          <div className="payroll-close__error" role="alert">
            <p>{copy.detail.error}</p>
            <button
              className="payroll-close__button"
              type="button"
              onClick={() => void loadDetail(detail.run)}
            >
              {ko.page.retry}
            </button>
          </div>
        </section>
      ) : null}
      {detail.kind === "ready" ? (
        <section className="payroll-close__card">
          <div>
            <p className="payroll-close__eyebrow">{copy.detail.eyebrow}</p>
            <h2 className="payroll-close__title">{copy.detail.title}</h2>
            <p className="payroll-close__description">
              {detail.run.source_label} · {detail.run.period_start} ~{" "}
              {detail.run.period_end}
            </p>
          </div>
          {detail.lines.length ? (
            <div className="payroll-close__table-wrap">
              <table className="payroll-close__table">
                <thead>
                  <tr>
                    <th>{copy.columns.employee}</th>
                    <th>{copy.columns.regular}</th>
                    <th>{copy.columns.overtime}</th>
                    <th>{copy.columns.source}</th>
                    <th>{copy.columns.calculationStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <strong>{line.employee_display_name}</strong>
                        <p className="payroll-close__meta">
                          {line.employee_company}
                        </p>
                      </td>
                      <td>{hours(line.regular_hours)}</td>
                      <td>{hours(line.overtime_hours)}</td>
                      <td>
                        {line.gross_pay_source_present &&
                        line.net_pay_source_present &&
                        line.nts_tax_row_status === "VERIFIED_SOURCE_ROW"
                          ? copy.source.verified
                          : copy.source.incomplete}
                      </td>
                      <td>
                        <span
                          className={`payroll-close__status payroll-close__status--${tone(line.calculation_status)}`}
                        >
                          {copy.statuses[line.calculation_status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="payroll-close__empty">{copy.detail.empty}</p>
          )}
          {detail.nextOffset !== null ? (
            <button
              className="payroll-close__button"
              type="button"
              onClick={() => void loadDetail(detail.run, true)}
            >
              {copy.detail.loadMore}
            </button>
          ) : null}
          <p className="payroll-close__meta">{copy.detail.readOnlyNotice}</p>
        </section>
      ) : null}
    </div>
  );
}
