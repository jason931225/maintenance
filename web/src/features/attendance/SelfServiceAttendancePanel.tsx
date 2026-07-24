import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/ui/dialog";
import { consoleScreenPath } from "../../console/shell/nav";
import { attendanceSelfServiceStrings as text } from "../../i18n/attendanceSelfService";

import { isoMonth, weekStart } from "./attendanceModel";
import {
  isValidOwnWeek52,
  SelfServiceAttendanceTransportError,
  type OwnAttendanceException,
  type OwnAttendanceExceptionPage,
  type OwnAttendanceWeek52,
  type OwnExceptionStatus,
  type SelfServiceAttendanceApi,
} from "./selfServiceAttendanceApi";
import "./attendance.css";
import "./SelfServiceAttendancePanel.css";

const PAGE_SIZE = 50;
const WEEK_LIMIT = 52;
type ExState = { state: "loading" } | { state: "denied" } | { state: "error" } | { state: "ready"; data: OwnAttendanceExceptionPage; loadingMore: boolean };
type WeekState = { state: "loading" } | { state: "denied" } | { state: "error" } | { state: "ready"; data: OwnAttendanceWeek52 };
type Props = { api: SelfServiceAttendanceApi; sessionIdentity: string | undefined; active: boolean; now?: () => Date };

function previousMonth(month: string): string {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function nextMonth(month: string): string {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value, 1));
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(month: string): string { const [year, value] = month.split("-"); return text.monthLabel(year, value); }
function shortDate(value: string): string { const [, month, day] = value.split("-"); return `${String(Number(month))}/${String(Number(day))}`; }
function kstTime(value: string): string { return new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function exceptionTone(kind: OwnAttendanceException["kind"]): string { return kind === "NO_SHOW" ? "attendance__extype--danger" : kind === "UNAPPROVED_OVERTIME" ? "attendance__extype--info" : "attendance__extype--warn"; }
function errorState(cause: unknown): "denied" | "error" { return cause instanceof SelfServiceAttendanceTransportError && cause.status === 403 ? "denied" : "error"; }
function weekRange(start: string): string { const date = new Date(`${start}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 6); return `${shortDate(start)}–${String(date.getUTCMonth() + 1)}/${String(date.getUTCDate())}`; }

/** Inactive or unauthenticated mounts retain no private data in the tree. */
export function SelfServiceAttendancePanel(props: Props) {
  if (!props.active || !props.sessionIdentity) return null;
  return <SelfServiceAttendancePanelInner key={props.sessionIdentity} {...props} />;
}

function SelfServiceAttendancePanelInner({ api, now }: Props) {
  const clock = now ?? (() => new Date());
  const maxMonth = isoMonth(clock());
  const currentWeek = weekStart(clock());
  const [month, setMonth] = useState(maxMonth);
  const [status, setStatus] = useState<OwnExceptionStatus>("OPEN");
  const [offset, setOffset] = useState(0);
  const [exceptionRefresh, setExceptionRefresh] = useState(0);
  const [weekRefresh, setWeekRefresh] = useState(0);
  const [exceptions, setExceptions] = useState<ExState>({ state: "loading" });
  const [week, setWeek] = useState<WeekState>({ state: "loading" });
  const [selected, setSelected] = useState<OwnAttendanceException>();
  const exceptionGeneration = useRef(0);
  const weekGeneration = useRef(0);
  const request = useMemo(() => ({ month, status, limit: PAGE_SIZE, offset }), [month, offset, status]);

  useEffect(() => {
    const generation = ++exceptionGeneration.current;
    const controller = new AbortController();
    void api.listOwnExceptions(request, controller.signal).then(
      (data) => {
        if (controller.signal.aborted || exceptionGeneration.current !== generation) return;
        setExceptions((prior) => {
          if (offset > 0 && prior.state === "ready") {
            return { state: "ready", loadingMore: false, data: { ...data, items: [...prior.data.items, ...data.items] } };
          }
          return { state: "ready", loadingMore: false, data };
        });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted && exceptionGeneration.current === generation) setExceptions({ state: errorState(cause) });
      },
    );
    return () => { controller.abort(); };
  }, [api, exceptionRefresh, offset, request]);

  useEffect(() => {
    const generation = ++weekGeneration.current;
    const controller = new AbortController();
    void api.getOwnWeek52(currentWeek, controller.signal).then(
      (data) => { if (!controller.signal.aborted && weekGeneration.current === generation) setWeek(isValidOwnWeek52(data) ? { state: "ready", data } : { state: "error" }); },
      (cause: unknown) => { if (!controller.signal.aborted && weekGeneration.current === generation) setWeek({ state: errorState(cause) }); },
    );
    return () => { controller.abort(); };
  }, [api, currentWeek, weekRefresh]);

  const startExceptionLoad = useCallback((nextMonth: string, nextStatus: OwnExceptionStatus) => {
    exceptionGeneration.current += 1;
    setSelected(undefined);
    setExceptions({ state: "loading" });
    setMonth(nextMonth);
    setStatus(nextStatus);
    setOffset(0);
  }, []);
  const retryExceptions = useCallback(() => { exceptionGeneration.current += 1; setExceptions({ state: "loading" }); setExceptionRefresh((value) => value + 1); }, []);
  const retryWeek = useCallback(() => { weekGeneration.current += 1; setWeek({ state: "loading" }); setWeekRefresh((value) => value + 1); }, []);
  const loadMore = useCallback(() => {
    if (exceptions.state !== "ready" || exceptions.loadingMore || exceptions.data.items.length >= exceptions.data.total) return;
    exceptionGeneration.current += 1;
    setExceptions({ ...exceptions, loadingMore: true });
    setOffset((value) => value + PAGE_SIZE);
  }, [exceptions]);
  const openCount = exceptions.state === "ready" && status === "OPEN" ? exceptions.data.total : undefined;

  return <section className="attendanceSelf" aria-label={text.title}>
    <div className="attendance__card">
      <header className="attendance__cardhead">
        {openCount !== undefined && openCount > 0 && <span className="attendance__dot" aria-label={text.count(openCount)} />}
        <span className="attendance__cardtitle">{text.title}</span>
        {openCount !== undefined && <span className="attendance__count">{text.count(openCount)}</span>}
        <span className="attendance__spacer" />
        <div className="attendance__monthnav" aria-label={text.targetMonth}><button type="button" aria-label={text.previousMonth} onClick={() => { startExceptionLoad(previousMonth(month), "OPEN"); }}>‹</button><span className="attendance__monthlabel">{monthLabel(month)}</span><button type="button" aria-label={text.nextMonth} disabled={month >= maxMonth} onClick={() => { startExceptionLoad(nextMonth(month), "OPEN"); }}>›</button></div>
        <div className="attendance__seg" aria-label={text.status}><button type="button" className={`attendance__segbtn ${status === "OPEN" ? "attendance__segbtn--on" : ""}`} aria-pressed={status === "OPEN"} onClick={() => { if (status !== "OPEN") startExceptionLoad(month, "OPEN"); }}>{text.open}</button><button type="button" className={`attendance__segbtn ${status === "RESOLVED" ? "attendance__segbtn--on" : ""}`} aria-pressed={status === "RESOLVED"} onClick={() => { if (status !== "RESOLVED") startExceptionLoad(month, "RESOLVED"); }}>{text.resolved}</button></div>
      </header>
      <div className="attendanceSelf__body">
        <section className="attendanceSelf__exceptions" aria-label={text.exceptions}><ExceptionPane state={exceptions} onRetry={retryExceptions} onSelect={setSelected} onMore={loadMore} /></section>
        <section className="attendanceSelf__week" aria-label={text.week52}><WeekPane state={week} onRetry={retryWeek} /></section>
      </div>
    </div>
    <Dialog open={selected !== undefined} onClose={() => { setSelected(undefined); }} label={text.detail} className="attendance__modal">
      {selected && <div><div className="attendance__modalhead"><span className="attendance__modaltitle">{text.detail}</span><span className="attendance__chip">{selected.code}</span><span className="attendance__chip">{selected.status === "OPEN" ? text.open : text.resolved}</span></div><div className="attendance__field"><strong>{text.kind[selected.kind]}</strong><span>{text.workDate}: {shortDate(selected.work_date)}</span><span>{text.occurred}: {kstTime(selected.occurred_at)}</span><span>{text.created}: {kstTime(selected.created_at)}</span><p className="attendance__exdetail">{selected.detail}</p>{selected.evidence.length > 0 && <span>{text.evidence}: {selected.evidence.map((evidence) => `${evidence.name}${evidence.size ? ` (${evidence.size})` : ""}`).join(", ")}</span>}{selected.resolution && <span>{text.resolution}: {selected.resolution.action} · {selected.resolution.reason}{selected.resolution.ot_hours ? text.overtimeHours(selected.resolution.ot_hours) : ""} · {kstTime(selected.resolution.resolved_at)}</span>}</div><div className="attendance__modalactions"><button type="button" className="attendance__actionbtn" onClick={() => { setSelected(undefined); }}>{text.close}</button></div></div>}
    </Dialog>
  </section>;
}

function ExceptionPane({ state, onRetry, onSelect, onMore }: { state: ExState; onRetry: () => void; onSelect: (item: OwnAttendanceException) => void; onMore: () => void }) {
  if (state.state === "loading") return <p className="attendance__status" role="status">{text.loading}</p>;
  if (state.state === "denied") return <p className="attendance__alert" role="alert">{text.denied}</p>;
  if (state.state === "error") return <div className="attendance__alert" role="alert">{text.loadError}<button type="button" className="attendance__ghostbtn" onClick={onRetry}>{text.retry}</button></div>;
  return <><div className="attendance__sidelist">{state.data.items.length === 0 ? <p className="attendance__status">{text.empty}</p> : state.data.items.map((item) => <button key={item.id} type="button" className={`attendance__exrow attendanceSelf__row ${item.status === "RESOLVED" ? "attendance__exrow--resolved" : ""}`} onClick={() => { onSelect(item); }}><span className={`attendance__extype ${exceptionTone(item.kind)}`}>{text.kind[item.kind]}</span><span className="attendance__exbody"><span className="attendanceSelf__rowMeta">{item.code} · {shortDate(item.work_date)}</span><span className="attendance__exdetail">{item.detail}</span></span><span className="attendance__chip">{item.status === "OPEN" ? text.open : text.resolved}</span></button>)}</div>{state.data.items.length < state.data.total && <footer className="attendanceSelf__footer"><button type="button" className="attendance__ghostbtn" disabled={state.loadingMore} onClick={onMore}>{state.loadingMore ? text.loading : text.more}</button><span className="attendance__count">{String(state.data.items.length)} / {String(state.data.total)}</span></footer>}</>;
}

function WeekPane({ state, onRetry }: { state: WeekState; onRetry: () => void }) {
  if (state.state === "loading") return <p className="attendance__status" role="status">{text.loading}</p>;
  if (state.state === "denied") return <p className="attendance__alert" role="alert">{text.denied}</p>;
  if (state.state === "error") return <div className="attendance__alert" role="alert">{text.loadError}<button type="button" className="attendance__ghostbtn" onClick={onRetry}>{text.retry}</button></div>;
  if (state.data.status === "not_available") return <div className="attendanceSelf__footer"><p className="attendance__status">{text.unavailable}</p><a className="attendance__ghostbtn" href={consoleScreenPath("support")}>{text.support}</a></div>;
  const p = state.data.projection; const boundedHours = Math.min(WEEK_LIMIT, p.current_hours); const percent = (boundedHours / WEEK_LIMIT) * 100; const projected = Math.abs(p.projected_hours - p.current_hours) > 0.01; const ariaText = p.current_hours > WEEK_LIMIT ? `${text.hours(p.current_hours)} ${text.overLimit}` : text.hours(p.current_hours);
  return <div className="attendanceSelf__weekMetrics"><span className="attendanceSelf__rowMeta">{weekRange(p.week_start)}</span><span className={`attendance__chip attendance__chip--${p.tone === "OK" ? "ok" : p.tone === "WARN" ? "warn" : "danger"}`}>{text.tone[p.tone]}</span><div className="attendance__w52bar" role="progressbar" aria-label={text.week52} aria-valuemin={0} aria-valuemax={WEEK_LIMIT} aria-valuenow={boundedHours} aria-valuetext={ariaText}><span className={`attendance__w52fill attendance__w52fill--${p.tone.toLowerCase()}`} style={{ width: `${String(percent)}%` }} /><span className="attendance__w52limit" /></div><div className="attendance__w52hours"><strong className="attendance__w52cur">{text.current} {text.hours(p.current_hours)}</strong>{projected && <span>{text.projected} {text.hours(p.projected_hours)}</span>}<span>{text.limit}</span>{p.acknowledged_at && <span>{text.acknowledged} {kstTime(p.acknowledged_at)}</span>}</div></div>;
}
