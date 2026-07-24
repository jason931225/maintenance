import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { useAuth } from "../../context/auth";
import { StatusChip } from "../components";
import {
  DISPATCH_QUEUE_STATUSES,
  forceAssignP1Dispatch,
  getP1Dispatch,
  isDispatchAccessDenied,
  listDispatchQueue,
  listP1DispatchCandidates,
  listP1DispatchResponses,
  respondToP1Dispatch,
  type DispatchCandidate,
  type DispatchQueueItem,
  type DispatchQueueStatus,
  type P1DispatchResponse,
  type P1DispatchSummary,
} from "./dispatchApi";

import "./dispatchConsole.css";

type LoadState = "loading" | "ready" | "error" | "denied";

type DispatchDetail = {
  summary: P1DispatchSummary;
  candidates: DispatchCandidate[];
  responses: P1DispatchResponse[];
};

const statusLabels: Record<DispatchQueueStatus, string> = {
  RECEIVED: "Received",
  UNASSIGNED: "Unassigned",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  PART_WAITING: "Part waiting",
  DELAYED: "Delayed",
};

function formatTime(value: string | undefined): string {
  if (!value) return "Not set";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function statusTone(status: string): "ok" | "warn" | "danger" | "neutral" {
  if (status === "DELAYED" || status === "MANAGER_FORCE_PENDING") return "danger";
  if (status === "UNASSIGNED" || status === "PART_WAITING" || status === "BROADCASTING") return "warn";
  if (status === "ASSIGNED" || status === "IN_PROGRESS" || status === "AUTO_ASSIGNED") return "ok";
  return "neutral";
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="dispatch-console__error" role="alert">
      <p>{message}</p>
      <button type="button" onClick={retry}>Retry dispatch queue</button>
    </div>
  );
}

function DetailView({
  detail,
  mutation,
  onRespond,
  onForceAssign,
}: {
  detail: DispatchDetail | null;
  mutation: string | null;
  onRespond: (response: "ACCEPT" | "DECLINE") => void;
  onForceAssign: (mechanicId: string) => void;
}) {
  const [candidateId, setCandidateId] = useState("");

  if (!detail) {
    return <p className="dispatch-console__empty" role="status">Select a dispatch queue row to inspect its live P1 state.</p>;
  }

  const forceAssignable = detail.summary.status === "MANAGER_FORCE_PENDING" && candidateId.length > 0;
  return (
    <section className="dispatch-console__detail" aria-labelledby="dispatch-detail-heading">
      <div className="dispatch-console__section-heading">
        <div>
          <h2 id="dispatch-detail-heading">P1 dispatch</h2>
          <p>Work order {detail.summary.work_order_id}</p>
        </div>
        <StatusChip tone={statusTone(detail.summary.status)}>{detail.summary.status}</StatusChip>
      </div>
      <dl className="dispatch-console__facts">
        <div><dt>Accept window</dt><dd>{formatTime(detail.summary.accept_window_ends_at)}</dd></div>
        <div><dt>Broadcast response</dt><dd>{detail.summary.accepted_count} accepted · {detail.summary.declined_count} declined / {detail.summary.target_count} requested</dd></div>
        <div><dt>Manual call</dt><dd>{detail.summary.manual_call_required ? "Required by dispatch policy" : "Not required"}</dd></div>
        {detail.summary.auto_assigned_mechanic_id && <div><dt>Assigned mechanic</dt><dd>{detail.summary.auto_assigned_mechanic_id}</dd></div>}
      </dl>

      <div className="dispatch-console__actions" aria-label="Dispatch response controls">
        <button type="button" disabled={mutation !== null} onClick={() => { onRespond("ACCEPT"); }}>Accept broadcast</button>
        <button type="button" disabled={mutation !== null} onClick={() => { onRespond("DECLINE"); }}>Decline broadcast</button>
      </div>

      <section aria-labelledby="dispatch-candidates-heading">
        <h3 id="dispatch-candidates-heading">Ranked candidates</h3>
        {detail.candidates.length === 0 ? <p className="dispatch-console__empty" role="status">No candidates are currently authorized for this dispatch.</p> : (
          <div className="dispatch-console__table-wrap">
            <table>
              <thead><tr><th scope="col">Select</th><th scope="col">Mechanic</th><th scope="col">Score</th><th scope="col">Ranking basis</th><th scope="col">Response</th></tr></thead>
              <tbody>{detail.candidates.map((candidate) => (
                <tr key={candidate.mechanic_id}>
                  <td><input aria-label={`Select mechanic ${candidate.mechanic_id}`} type="radio" name="dispatch-candidate" value={candidate.mechanic_id} checked={candidateId === candidate.mechanic_id} onChange={(event) => { setCandidateId(event.target.value); }} /></td>
                  <td>{candidate.mechanic_id}</td>
                  <td>{(candidate.score_milli / 1000).toFixed(3)}</td>
                  <td>{candidate.score_reason}</td>
                  <td>{candidate.response ?? "No response"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {detail.summary.status === "MANAGER_FORCE_PENDING" && (
          <button type="button" className="dispatch-console__danger-action" disabled={!forceAssignable || mutation !== null} onClick={() => { onForceAssign(candidateId); }}>
            Force assign selected candidate
          </button>
        )}
      </section>

      <section aria-labelledby="dispatch-responses-heading">
        <h3 id="dispatch-responses-heading">Responses</h3>
        {detail.responses.length === 0 ? <p className="dispatch-console__empty" role="status">No authorized responses have been recorded.</p> : (
          <ul className="dispatch-console__response-list">{detail.responses.map((response) => (
            <li key={`${response.dispatch_id}:${response.user_id}`}><strong>{response.user_id}</strong><span>{response.response}</span><time dateTime={response.responded_at}>{formatTime(response.responded_at)}</time></li>
          ))}</ul>
        )}
      </section>
    </section>
  );
}

function QueueList({
  items,
  selectedId,
  onSelect,
}: {
  items: DispatchQueueItem[];
  selectedId: string | null;
  onSelect: (item: DispatchQueueItem) => void;
}) {
  if (items.length === 0) return <p className="dispatch-console__empty" role="status">No work orders match the selected dispatch statuses.</p>;
  return (
    <div className="dispatch-console__table-wrap">
      <table aria-label="Dispatch work order queue">
        <thead><tr><th scope="col">Work order</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">P1 state</th><th scope="col">Due</th></tr></thead>
        <tbody>{items.map((item) => (
          <tr key={item.work_order_id} aria-selected={selectedId === item.work_order_id}>
            <td><button type="button" className="dispatch-console__row-button" onClick={() => { onSelect(item); }}>{item.request_no}<span>{item.symptom}</span></button></td>
            <td>{item.priority}</td>
            <td><StatusChip tone={statusTone(item.status)}>{item.status}</StatusChip></td>
            <td>{item.dispatch ? <StatusChip tone={statusTone(item.dispatch.status)}>{item.dispatch.status}</StatusChip> : "No P1 broadcast"}</td>
            <td>{formatTime(item.target_due_at)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function DispatchConsoleBody() {
  const { api, session } = useAuth();
  return <DispatchConsole key={session?.client_session_incarnation ?? "dispatch-anonymous"} api={api} />;
}

export function DispatchConsole({ api }: { api: ConsoleApiClient }) {
  const statusLegendId = useId();
  const [statuses, setStatuses] = useState<DispatchQueueStatus[]>(["UNASSIGNED", "DELAYED"]);
  const [items, setItems] = useState<DispatchQueueItem[]>([]);
  const [nextAfter, setNextAfter] = useState<string | undefined>();
  const [stats, setStats] = useState({ unassigned_count: 0, sla_due_count: 0 });
  const [queueState, setQueueState] = useState<LoadState>("loading");
  const [queueRetry, setQueueRetry] = useState(0);
  const [selected, setSelected] = useState<DispatchQueueItem | null>(null);
  const [detail, setDetail] = useState<DispatchDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("ready");
  const [detailRetry, setDetailRetry] = useState(0);
  const [mutation, setMutation] = useState<string | null>(null);
  const queueEpoch = useRef(0);
  const selectionEpoch = useRef(0);
  const detailEpoch = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++queueEpoch.current;
    void listDispatchQueue(api, { status: statuses }, controller.signal).then((page) => {
      if (controller.signal.aborted || epoch !== queueEpoch.current) return;
      setItems(page.items);
      setNextAfter(page.next_after);
      setStats(page.stats);
      setQueueState("ready");
      setSelected((current) => page.items.find((item) => item.work_order_id === current?.work_order_id) ?? null);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || epoch !== queueEpoch.current) return;
      setItems([]);
      setNextAfter(undefined);
      setSelected(null);
      setDetail(null);
      setQueueState(isDispatchAccessDenied(error) ? "denied" : "error");
    });
    return () => { controller.abort(); };
  }, [api, queueRetry, statuses]);

  useEffect(() => {
    const dispatchId = selected?.dispatch?.id;
    if (!dispatchId) return;
    const controller = new AbortController();
    const epoch = ++detailEpoch.current;
    const selectionAtStart = selectionEpoch.current;
    void Promise.all([
      getP1Dispatch(api, dispatchId, controller.signal),
      listP1DispatchCandidates(api, dispatchId, controller.signal),
      listP1DispatchResponses(api, dispatchId, controller.signal),
    ]).then(([summary, candidates, responses]) => {
      if (controller.signal.aborted || epoch !== detailEpoch.current || selectionAtStart !== selectionEpoch.current) return;
      setDetail({ summary, candidates, responses });
      setDetailState("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted || epoch !== detailEpoch.current || selectionAtStart !== selectionEpoch.current) return;
      setDetail(null);
      setDetailState(isDispatchAccessDenied(error) ? "denied" : "error");
    });
    return () => { controller.abort(); };
  }, [api, detailRetry, selected]);

  function refreshQueue() {
    setQueueState("loading");
    setQueueRetry((value) => value + 1);
  }

  function retryDetail() {
    setDetailState("loading");
    setDetailRetry((value) => value + 1);
  }

  function toggleStatus(status: DispatchQueueStatus) {
    setQueueState("loading");
    setStatuses((current) => current.includes(status) ? current.filter((value) => value !== status) : [...current, status]);
  }

  function select(item: DispatchQueueItem) {
    selectionEpoch.current += 1;
    setDetail(null);
    setDetailState(item.dispatch ? "loading" : "ready");
    setSelected(item);
  }

  async function loadMore() {
    if (!nextAfter || queueState === "loading") return;
    const controller = new AbortController();
    const epoch = ++queueEpoch.current;
    setQueueState("loading");
    try {
      const page = await listDispatchQueue(api, { status: statuses, after: nextAfter }, controller.signal);
      if (epoch !== queueEpoch.current) return;
      setItems((current) => [...current, ...page.items.filter((next) => !current.some((item) => item.work_order_id === next.work_order_id))]);
      setNextAfter(page.next_after);
      setStats(page.stats);
      setQueueState("ready");
    } catch (error: unknown) {
      if (epoch !== queueEpoch.current) return;
      setQueueState(isDispatchAccessDenied(error) ? "denied" : "error");
    }
  }

  async function mutate(action: "ACCEPT" | "DECLINE" | "FORCE", mechanicId?: string) {
    const dispatchId = detail?.summary.id;
    const selectionAtStart = selectionEpoch.current;
    if (!dispatchId || mutation !== null) return;
    setMutation(action);
    try {
      if (action === "FORCE") {
        if (!mechanicId) return;
        await forceAssignP1Dispatch(api, dispatchId, mechanicId);
      } else {
        await respondToP1Dispatch(api, dispatchId, action);
      }
      if (selectionAtStart === selectionEpoch.current) {
        refreshQueue();
        retryDetail();
      }
    } finally {
      if (selectionAtStart === selectionEpoch.current) setMutation(null);
    }
  }

  const headingStyle: CSSProperties = { margin: 0 };
  return (
    <section className="dispatch-console" aria-labelledby="dispatch-console-heading">
      <header className="dispatch-console__header">
        <div><h1 id="dispatch-console-heading" style={headingStyle}>Dispatch operations</h1><p>Live, branch-authorized work-order queue and P1 emergency dispatch state.</p></div>
        <dl className="dispatch-console__stats"><div><dt>Unassigned</dt><dd>{stats.unassigned_count}</dd></div><div><dt>SLA due</dt><dd>{stats.sla_due_count}</dd></div></dl>
      </header>
      <fieldset className="dispatch-console__filters" aria-describedby={statusLegendId}>
        <legend>Queue status</legend><p id={statusLegendId}>Filter the server-backed queue; cursor pagination retains the backend ordering.</p>
        <div>{DISPATCH_QUEUE_STATUSES.map((status) => <label key={status}><input type="checkbox" checked={statuses.includes(status)} onChange={() => { toggleStatus(status); }} />{statusLabels[status]}</label>)}</div>
      </fieldset>
      <div className="dispatch-console__layout">
        <section className="dispatch-console__panel" aria-labelledby="dispatch-queue-heading">
          <div className="dispatch-console__section-heading"><h2 id="dispatch-queue-heading">Work-order queue</h2><button type="button" onClick={refreshQueue} disabled={queueState === "loading"}>Refresh</button></div>
          {queueState === "denied" ? <p className="dispatch-console__empty" role="alert">Your current role is not authorized to read the dispatch queue.</p> : queueState === "error" ? <ErrorState message="The dispatch queue could not be loaded." retry={refreshQueue} /> : queueState === "loading" && items.length === 0 ? <p className="dispatch-console__empty" role="status">Loading dispatch queue…</p> : <QueueList items={items} selectedId={selected?.work_order_id ?? null} onSelect={select} />}
          {nextAfter && queueState === "ready" && <button type="button" className="dispatch-console__more" onClick={() => { void loadMore(); }}>Load next queue page</button>}
        </section>
        <aside className="dispatch-console__panel" aria-live="polite">
          {detailState === "loading" ? <p className="dispatch-console__empty" role="status">Loading selected P1 dispatch…</p> : detailState === "denied" ? <p className="dispatch-console__empty" role="alert">Your current role is not authorized to inspect this P1 dispatch.</p> : detailState === "error" ? <ErrorState message="The selected P1 dispatch could not be loaded." retry={retryDetail} /> : selected && !selected.dispatch ? <p className="dispatch-console__empty" role="status">This work order has no active P1 dispatch.</p> : <DetailView key={detail?.summary.id ?? "no-dispatch"} detail={detail} mutation={mutation} onRespond={(response) => { void mutate(response); }} onForceAssign={(mechanicId) => { void mutate("FORCE", mechanicId); }} />}
        </aside>
      </div>
    </section>
  );
}
