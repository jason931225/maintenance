import { useEffect, useId, useMemo, useState } from "react";

import { Dialog } from "../../components/ui/dialog";
import { attendanceStrings as text } from "../../i18n/attendance";

import {
  AttendanceTransportError,
  type AttendanceException,
  type AttendanceTransport,
  type CreateSubstitution,
  type Page,
  type SubstitutionCandidate,
} from "./attendanceApi";

type CandidateState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "denied" }
  | { state: "error" }
  | { state: "ready"; data: Page<SubstitutionCandidate> };

const CANDIDATE_LIMIT = 25;

function parseMinutes(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : undefined;
}

export function SubstitutionCandidateDialog({
  gap,
  transport,
  busy,
  onClose,
  onAssign,
}: {
  gap: AttendanceException;
  transport: AttendanceTransport;
  busy: boolean;
  onClose: () => void;
  onAssign: (input: CreateSubstitution) => void;
}) {
  const [query, setQuery] = useState("");
  const [site, setSite] = useState(gap.team ?? "");
  const [role, setRole] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [offset, setOffset] = useState(0);
  const [candidates, setCandidates] = useState<CandidateState>({
    state: "idle",
  });
  const fromMinutes = parseMinutes(from);
  const toMinutes = parseMinutes(to);
  const window = useMemo(
    () =>
      fromMinutes !== undefined &&
      toMinutes !== undefined &&
      toMinutes > fromMinutes
        ? { fromMinutes, toMinutes }
        : undefined,
    [fromMinutes, toMinutes],
  );
  const hasValidWindow = window !== undefined;
  const candidateQuery = useMemo(() => {
    if (!window) return undefined;
    return {
      covered_employee_id: gap.employee_id,
      cover_date: gap.work_date,
      from_minutes: window.fromMinutes,
      to_minutes: window.toMinutes,
      search: query.trim() || undefined,
      limit: CANDIDATE_LIMIT,
      offset,
    };
  }, [gap.employee_id, gap.work_date, offset, query, window]);
  const siteId = useId();
  const roleId = useId();
  const fromId = useId();
  const toId = useId();
  const searchId = useId();

  useEffect(() => {
    if (!candidateQuery) return;
    const controller = new AbortController();
    setCandidates({ state: "loading" });
    void transport
      .listSubstitutionCandidates(candidateQuery, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setCandidates({ state: "ready", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setCandidates({
          state:
            cause instanceof AttendanceTransportError && cause.status === 403
              ? "denied"
              : "error",
        });
      });
    return () => controller.abort();
  }, [transport, candidateQuery, retry]);

  const visibleCandidates = hasValidWindow
    ? candidates
    : ({ state: "idle" } as const);

  const windowMessage = useMemo(() => {
    if (!from && !to) return text.sub.candidateWindow;
    return hasValidWindow ? undefined : text.sub.invalidWindow;
  }, [from, to, hasValidWindow]);

  const assign = (candidate: SubstitutionCandidate) => {
    if (!site.trim() || !role.trim() || !window) {
      setFieldError(window ? text.actions.required : text.sub.invalidWindow);
      return;
    }
    setFieldError(undefined);
    onAssign({
      site: site.trim(),
      role: role.trim(),
      cover_date: gap.work_date,
      from_minutes: window.fromMinutes,
      to_minutes: window.toMinutes,
      covered_employee_id: gap.employee_id,
      reason_kind: "NO_SHOW",
      reason_detail: gap.detail,
      worker_employee_id: candidate.employee_id,
      exception_id: gap.id,
    });
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnScrimClick={!busy}
      label={text.sub.title}
      className="attendance__modal"
    >
      <div className="attendance__modalhead">
        <span className="attendance__modaltitle">{text.sub.title}</span>
        <span className="attendance__chip attendance__chip--danger">{gap.employee_name} · {text.sub.gapReason}</span>
        <span className="attendance__count">{gap.work_date}</span>
      </div>
      <p className="attendance__exdetail">{gap.detail}</p>
      <label className="attendance__field" htmlFor={siteId}>
        {text.sub.site}
        <input
          id={siteId}
          value={site}
          required
          onChange={(event) => {
            setSite(event.target.value);
          }}
        />
      </label>
      <label className="attendance__field" htmlFor={roleId}>
        {text.sub.role}
        <input
          id={roleId}
          value={role}
          required
          onChange={(event) => {
            setRole(event.target.value);
          }}
        />
      </label>
      <div className="attendance__modalhead">
        <label className="attendance__field" htmlFor={fromId}>
          {text.sub.from}
          <input
            id={fromId}
            type="time"
            value={from}
            required
            onChange={(event) => {
              setFrom(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label className="attendance__field" htmlFor={toId}>
          {text.sub.to}
          <input
            id={toId}
            type="time"
            value={to}
            required
            onChange={(event) => {
              setTo(event.target.value);
              setOffset(0);
            }}
          />
        </label>
      </div>
      <label className="attendance__field" htmlFor={searchId}>
        {text.sub.poolSearch}
        <input
          id={searchId}
          type="search"
          value={query}
          disabled={!hasValidWindow || busy}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      {fieldError && <span className="attendance__fielderror" role="alert">{fieldError}</span>}
      {windowMessage && <p role="status" className="attendance__status">{windowMessage}</p>}
      {visibleCandidates.state === "loading" && <p role="status" className="attendance__status">{text.loading}</p>}
      {visibleCandidates.state === "denied" && <p role="status" className="attendance__status">{text.sub.candidatesDenied}</p>}
      {visibleCandidates.state === "error" && <div className="attendance__alert" role="alert"><span>{text.sub.candidatesError}</span><button type="button" className="attendance__ghostbtn" disabled={busy} onClick={() => { setRetry((value) => value + 1); }}>{text.sub.retryCandidates}</button></div>}
      {visibleCandidates.state === "ready" && (visibleCandidates.data.items.length === 0 ? <p role="status" className="attendance__status">{text.sub.empty}</p> : <><div role="list">{visibleCandidates.data.items.map((candidate) => <div key={candidate.employee_id} role="listitem" className="attendance__poolrow"><span className="attendance__poolname">{candidate.employee_name}</span><button type="button" className="attendance__actionbtn" disabled={busy} onClick={() => { assign(candidate); }}>{text.sub.assign}</button></div>)}</div><div className="attendance__modalactions">{visibleCandidates.data.offset > 0 && <button type="button" className="attendance__ghostbtn" disabled={busy} onClick={() => { setOffset(Math.max(0, visibleCandidates.data.offset - visibleCandidates.data.limit)); }}>{text.sub.previousCandidates}</button>}{visibleCandidates.data.offset + visibleCandidates.data.limit < visibleCandidates.data.total && <button type="button" className="attendance__ghostbtn" disabled={busy} onClick={() => { setOffset(visibleCandidates.data.offset + visibleCandidates.data.limit); }}>{text.sub.nextCandidates}</button>}</div></>)}
      <div className="attendance__modalactions"><button type="button" className="attendance__ghostbtn" disabled={busy} onClick={() => { if (!busy) onClose(); }}>{text.sub.cancel}</button></div>
    </Dialog>
  );
}
