import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { Dialog } from "../../components/ui/dialog";
import { consoleScreenPath } from "../../console/shell/nav";
import { attendanceSelfServiceStrings as text } from "../../i18n/attendanceSelfService";

import {
  isValidOwnWeek52,
  type OwnAttendanceException,
  type OwnAttendanceExceptionPage,
  type OwnAttendanceExceptionQuery,
  type OwnAttendanceWeek52,
  type OwnExceptionStatus,
  type SelfServiceAttendanceApi,
} from "./selfServiceAttendanceApi";
import "./SelfServiceAttendancePanel.css";

const PAGE_SIZE = 50;
type ReadState<T> = { state: "loading" } | { state: "error" } | { state: "ready"; data: T };

export type SelfServiceAttendancePanelProps = {
  api: SelfServiceAttendanceApi;
  /** Remounts state synchronously whenever the authenticated subject changes. */
  sessionIdentity: string | undefined;
  /** Inactive console screens must not retain or issue background reads. */
  active: boolean;
  now?: () => Date;
};

function currentMonth(now: Date): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function statusClass(status: OwnExceptionStatus): string {
  return status === "OPEN" ? "self-attendance__status--open" : "self-attendance__status--resolved";
}

function toneClass(tone: "OK" | "WARN" | "DANGER"): string {
  return `self-attendance__tone--${tone.toLowerCase()}`;
}

/** Synchronous key fence keeps a former session's selection out of the next one. */
export function SelfServiceAttendancePanel(props: SelfServiceAttendancePanelProps) {
  return <SelfServiceAttendancePanelInner key={props.sessionIdentity ?? "no-session"} {...props} />;
}

function SelfServiceAttendancePanelInner({ api, active, now }: SelfServiceAttendancePanelProps) {
  const clock = now ?? (() => new Date());
  const maxMonth = currentMonth(clock());
  const [month, setMonth] = useState(maxMonth);
  const [status, setStatus] = useState<OwnExceptionStatus | undefined>("OPEN");
  const [offset, setOffset] = useState(0);
  const [exceptionRetry, setExceptionRetry] = useState(0);
  const [week52Retry, setWeek52Retry] = useState(0);
  const [exceptions, setExceptions] = useState<ReadState<OwnAttendanceExceptionPage>>({ state: "loading" });
  const [week52, setWeek52] = useState<ReadState<OwnAttendanceWeek52>>({ state: "loading" });
  const [selected, setSelected] = useState<OwnAttendanceException>();
  const monthId = useId();
  const statusId = useId();

  const query = useMemo<OwnAttendanceExceptionQuery>(() => ({
    month,
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    offset,
  }), [month, offset, status]);

  const retryExceptions = useCallback(() => { setExceptionRetry((value) => value + 1); }, []);
  const retryWeek52 = useCallback(() => { setWeek52Retry((value) => value + 1); }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void api.listOwnExceptions(query, controller.signal).then(
      (data) => { if (!controller.signal.aborted) { setExceptions({ state: "ready", data }); } },
      () => { if (!controller.signal.aborted) { setExceptions({ state: "error" }); } },
    );
    return () => { controller.abort(); };
  }, [api, active, exceptionRetry, query]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void api.getOwnWeek52(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) { setWeek52(isValidOwnWeek52(data) ? { state: "ready", data } : { state: "error" }); }
      },
      () => { if (!controller.signal.aborted) { setWeek52({ state: "error" }); } },
    );
    return () => { controller.abort(); };
  }, [api, active, week52Retry]);

  const changeMonth = (next: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(next) || next > maxMonth) return;
    setMonth(next);
    setOffset(0);
    setSelected(undefined);
  };
  const changeStatus = (next: string) => {
    setStatus(next === "" ? undefined : next as OwnExceptionStatus);
    setOffset(0);
    setSelected(undefined);
  };
  const exceptionCanGoNext = exceptions.state === "ready" && offset + PAGE_SIZE < exceptions.data.total;

  return (
    <section className="self-attendance" aria-label={text.title}>
      <div className="self-attendance__surface">
        <section className="self-attendance__exceptions" aria-labelledby="self-attendance-exceptions-title">
          <div className="self-attendance__head">
            <h2 className="self-attendance__title" id="self-attendance-exceptions-title">{text.exceptions}</h2>
            <div className="self-attendance__filters">
              <label htmlFor={monthId}>{text.month}<input id={monthId} aria-label={text.month} type="month" max={maxMonth} value={month} onChange={(event) => { changeMonth(event.target.value); }} /></label>
              <label htmlFor={statusId}>{text.status}<select id={statusId} aria-label={text.status} value={status ?? ""} onChange={(event) => { changeStatus(event.target.value); }}><option value="">{text.all}</option><option value="OPEN">{text.open}</option><option value="RESOLVED">{text.resolved}</option></select></label>
            </div>
          </div>
          <ExceptionContent state={exceptions} onRetry={retryExceptions} onSelect={setSelected} />
          {exceptions.state === "ready" && exceptions.data.total > PAGE_SIZE && <div className="self-attendance__pager"><button type="button" disabled={offset === 0} onClick={() => { setOffset((value) => Math.max(0, value - PAGE_SIZE)); }}>{text.previous}</button><button type="button" disabled={!exceptionCanGoNext} onClick={() => { setOffset((value) => value + PAGE_SIZE); }}>{text.next}</button></div>}
        </section>
        <section className="self-attendance__week" aria-labelledby="self-attendance-week-title">
          <div className="self-attendance__head"><h2 className="self-attendance__title" id="self-attendance-week-title">{text.week52}</h2></div>
          <Week52Content state={week52} onRetry={retryWeek52} />
        </section>
      </div>
      <Dialog open={selected !== undefined} onClose={() => { setSelected(undefined); }} label={text.detail} className="self-attendance__dialog">
        {selected && <div className="self-attendance__dialog-content"><h2>{text.detail}</h2><p>{text.date}: {selected.work_date}</p><p>{text.kind}: {text.kindLabel[selected.kind]}</p><p>{text.detailLabel}: {selected.detail}</p><button type="button" className="self-attendance__retry" onClick={() => { setSelected(undefined); }}>{text.close}</button></div>}
      </Dialog>
    </section>
  );
}

function ExceptionContent({ state, onRetry, onSelect }: { state: ReadState<OwnAttendanceExceptionPage>; onRetry: () => void; onSelect: (item: OwnAttendanceException) => void }) {
  if (state.state === "loading") return <div className="self-attendance__state" role="status">{text.loading}</div>;
  if (state.state === "error") return <div className="self-attendance__state" role="alert">{text.loadError}<button type="button" className="self-attendance__retry" onClick={onRetry}>{text.retry}</button></div>;
  if (state.data.items.length === 0) return <div className="self-attendance__state">{text.empty}</div>;
  return <div className="self-attendance__rows">{state.data.items.map((item) => <button type="button" className="self-attendance__row" key={item.id} onClick={() => { onSelect(item); }}><span className="self-attendance__date">{item.work_date}</span><span className="self-attendance__detail">{text.kindLabel[item.kind]} · {item.detail}</span><span className={`self-attendance__status ${statusClass(item.status)}`}>{text.statusLabel[item.status]}</span></button>)}</div>;
}

function Week52Content({ state, onRetry }: { state: ReadState<OwnAttendanceWeek52>; onRetry: () => void }) {
  if (state.state === "loading") return <div className="self-attendance__state" role="status">{text.loading}</div>;
  if (state.state === "error") return <div className="self-attendance__state" role="alert">{text.loadError}<button type="button" className="self-attendance__retry" onClick={onRetry}>{text.retry}</button></div>;
  if (state.data.status === "not_available") return <div className="self-attendance__state">{text.unavailable}<a className="self-attendance__support" href={consoleScreenPath("support")}>{text.support}</a></div>;
  const p = state.data.projection;
  const percent = Math.min(100, Math.max(0, (p.projected_hours / p.limit_hours) * 100));
  return <div className="self-attendance__weekbody"><div className="self-attendance__metric"><span className="self-attendance__metric-label">{text.progress}</span><strong className={`self-attendance__metric-value ${toneClass(p.tone)}`}>{text.hours(p.current_hours)}</strong><div className={`self-attendance__progress self-attendance__progress--${p.tone.toLowerCase()}`} role="progressbar" aria-label={text.progress} aria-valuemin={0} aria-valuemax={p.limit_hours} aria-valuenow={p.current_hours}><span style={{ width: `${String(percent)}%` }} /></div><span className="self-attendance__metric-label">{text.projected}: {text.hours(p.projected_hours)} · {text.limit}</span></div><a className="self-attendance__support" href={consoleScreenPath("support")}>{text.support}</a></div>;
}
