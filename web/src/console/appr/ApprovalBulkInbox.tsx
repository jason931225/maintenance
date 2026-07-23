import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { StatusChip } from "../components";
import {
  ApprWorkflowApiError,
  createApprWorkflowApi,
  type ApprWorkflowApi,
  type WorkflowWaitingTask,
} from "./composeApi";

const PAGE_SIZE = 50;

type Outcome =
  | { state: "approved"; taskStatus: string; runStatus: string }
  | { state: "failed" | "unknown"; message: string };

type Receipt = Record<string, Outcome>;

export interface ApprovalBulkInboxProps {
  api?: ApprWorkflowApi;
  bearerToken?: string;
  currentUserId?: string;
}

const sectionStyle: CSSProperties = { display: "grid", gap: "var(--sp-4)", padding: "var(--sp-5)", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--surface)", boxShadow: "var(--shadow)" };
const toolbarStyle: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-3)" };
const buttonStyle: CSSProperties = { minHeight: 34, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink)", padding: "0 var(--sp-4)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-strong)", cursor: "pointer" };
const primaryButtonStyle: CSSProperties = { ...buttonStyle, background: "var(--signal)", color: "var(--accent-tx)" };
const disabledButtonStyle: CSSProperties = { ...buttonStyle, cursor: "not-allowed", opacity: 0.55 };

function newOperationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${String(Date.now())}-${String(Math.random()).slice(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApprWorkflowApiError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "No confirmed result after cancellation. Retry uses the same idempotency key.";
  return "No confirmed result. Retry uses the same idempotency key.";
}

function capabilityMessage(task: WorkflowWaitingTask): string | undefined {
  if (task.bulk_decision?.decidable) return undefined;
  return task.bulk_decision?.reason ?? "SERVER_CAPABILITY_UNAVAILABLE";
}

/**
 * A bounded orchestration over the audited per-task decision endpoint. The
 * workflow service, rather than the browser, owns eligibility. Each task keeps
 * its immutable idempotency identity until the service confirms a terminal
 * result, including across a cancellation or an interleaved new operation.
 */
export function ApprovalBulkInbox({ api, bearerToken }: ApprovalBulkInboxProps) {
  const workflowApi = useMemo(() => api ?? createApprWorkflowApi({ bearerToken }), [api, bearerToken]);
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const executionRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const currentTaskRef = useRef<string | undefined>(undefined);
  const keyByTaskRef = useRef<Record<string, string>>({});
  const [tasks, setTasks] = useState<WorkflowWaitingTask[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedTasks, setSelectedTasks] = useState<Record<string, WorkflowWaitingTask>>({});
  const [receipt, setReceipt] = useState<Receipt>({});
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [readState, setReadState] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const load = useCallback(async (nextOffset = 0) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setReadState("loading");
    try {
      const page = await workflowApi.listWaitingTasks({ limit: PAGE_SIZE, offset: nextOffset });
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setTasks(page.items);
      setOffset(page.offset);
      setTotal(page.total);
      setReadState("ready");
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current) setReadState("error");
    }
  }, [workflowApi]);

  useEffect(() => {
    mountedRef.current = true;
    void load(0);
    return () => {
      mountedRef.current = false;
      executionRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  const rows = useMemo(() => tasks.map((task) => ({ task, message: capabilityMessage(task) })), [tasks]);
  const selectedRows = useMemo(() => [...selected].map((id) => selectedTasks[id]).filter((task): task is WorkflowWaitingTask => task !== undefined), [selected, selectedTasks]);
  const unresolvedIds = useMemo(() => Object.entries(receipt).flatMap(([id, outcome]) => outcome.state === "approved" ? [] : [id]), [receipt]);
  const freshSelected = useMemo(() => selectedRows.filter((task) => task.bulk_decision?.decidable && !keyByTaskRef.current[task.task_id]), [selectedRows]);

  function toggle(task: WorkflowWaitingTask) {
    if (running || !task.bulk_decision?.decidable) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(task.task_id)) next.delete(task.task_id); else next.add(task.task_id);
      return next;
    });
    setSelectedTasks((previous) => previous[task.task_id] ? previous : { ...previous, [task.task_id]: task });
  }

  async function approve(ids: string[], retrying: boolean) {
    if (running) return;
    const candidates = ids.map((id) => selectedTasks[id] ?? tasks.find((task) => task.task_id === id)).filter((task): task is WorkflowWaitingTask => task !== undefined && task.bulk_decision?.decidable === true);
    const actionable = candidates.filter((task) => retrying ? Boolean(keyByTaskRef.current[task.task_id]) : !keyByTaskRef.current[task.task_id]);
    if (actionable.length === 0) return;

    const execution = executionRef.current + 1;
    executionRef.current = execution;
    const controller = new AbortController();
    controllerRef.current = controller;
    setCancelled(false);
    setRunning(true);
    const unresolved = new Set<string>();
    for (const task of actionable) {
      if (!mountedRef.current || execution !== executionRef.current || controller.signal.aborted) { unresolved.add(task.task_id); break; }
      currentTaskRef.current = task.task_id;
      const existingKey = keyByTaskRef.current[task.task_id];
      const idempotencyKey = existingKey ?? `approval-bulk-${newOperationId()}-${task.task_id}`;
      if (!existingKey) keyByTaskRef.current[task.task_id] = idempotencyKey;
      try {
        const result = await workflowApi.decideTask(task.task_id, "approve", { idempotencyKey, signal: controller.signal });
        if (!mountedRef.current || execution !== executionRef.current) return;
        setReceipt((previous) => ({ ...previous, [task.task_id]: { state: "approved", taskStatus: result.taskStatus, runStatus: result.runStatus } }));
      } catch (error) {
        if (!mountedRef.current || execution !== executionRef.current) return;
        const unknown = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        unresolved.add(task.task_id);
        setReceipt((previous) => ({ ...previous, [task.task_id]: { state: unknown ? "unknown" : "failed", message: errorMessage(error) } }));
        if (unknown) break;
      }
    }
    if (!mountedRef.current || execution !== executionRef.current) return;
    currentTaskRef.current = undefined;
    controllerRef.current = undefined;
    setRunning(false);
    setSelected(unresolved);
    void load(offset);
  }

  function cancel() {
    if (!running) return;
    const taskId = currentTaskRef.current;
    controllerRef.current?.abort();
    executionRef.current += 1;
    currentTaskRef.current = undefined;
    if (taskId) {
      setReceipt((previous) => ({ ...previous, [taskId]: { state: "unknown", message: "No confirmed result after cancellation. Retry uses the same idempotency key." } }));
      setSelected((previous) => new Set([...previous, taskId]));
    }
    setRunning(false);
    setCancelled(true);
  }

  return <section className="console" style={sectionStyle} aria-labelledby="approval-bulk-inbox-title">
    <div style={toolbarStyle}><div><h2 id="approval-bulk-inbox-title" style={{ margin: 0, fontSize: "var(--text-card-title)" }}>Approval inbox</h2><p style={{ margin: "var(--sp-1) 0 0", color: "var(--steel)", fontSize: "var(--text-sm)" }}>Bulk approval sends one audited, idempotent decision per workflow-authorized task.</p></div><button type="button" style={running ? disabledButtonStyle : buttonStyle} onClick={() => { void load(offset); }} disabled={running || readState === "loading"}>Refresh</button></div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }} aria-live="polite"><StatusChip tone="info">{selectedRows.length} selected</StatusChip>{cancelled ? <StatusChip tone="warn">Cancelled. The in-flight result is unconfirmed until retried.</StatusChip> : null}</div>
    {readState === "error" ? <div role="alert"><StatusChip tone="danger">The approval inbox could not be loaded.</StatusChip> <button type="button" style={buttonStyle} onClick={() => { void load(offset); }}>Retry loading</button></div> : null}
    {readState === "loading" && tasks.length === 0 ? <p style={{ margin: 0, color: "var(--steel)" }}>Loading approval tasks…</p> : null}
    {readState === "ready" && rows.length === 0 ? <p style={{ margin: 0, color: "var(--steel)" }}>There are no workflow-authorized approval tasks.</p> : null}
    {rows.length > 0 ? <ul style={{ display: "grid", gap: "var(--sp-2)", listStyle: "none", margin: 0, padding: 0 }} aria-label="Approval tasks">{rows.map(({ task, message }) => <li key={task.task_id} style={{ display: "grid", gap: "var(--sp-2)", padding: "var(--sp-3)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-md)", background: "var(--muted)" }}><div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)", alignItems: "start" }}><input id={`approval-select-${task.task_id}`} type="checkbox" checked={selected.has(task.task_id)} disabled={Boolean(message) || running} aria-describedby={message ? `approval-guard-${task.task_id}` : undefined} onChange={() => { toggle(task); }} /><div style={{ display: "grid", gap: "var(--sp-1)", minWidth: 0, flex: "1 1 18rem" }}><label htmlFor={`approval-select-${task.task_id}`} style={{ color: "var(--ink)", fontWeight: "var(--fw-strong)", cursor: message || running ? "default" : "pointer" }}>{task.title}</label><span style={{ color: "var(--steel)", fontSize: "var(--text-sm)" }}>{task.waiting_key} · {task.assignee_role_key ?? "personal inbox"}</span>{task.due_at ? <span style={{ color: "var(--steel)", fontSize: "var(--text-xs)" }}>Due {new Date(task.due_at).toLocaleString()}</span> : null}</div><StatusChip tone={task.status === "CLAIMED" ? "info" : "neutral"}>{task.status}</StatusChip></div>{message ? <p id={`approval-guard-${task.task_id}`} style={{ margin: 0, color: "var(--danger-tx)", fontSize: "var(--text-sm)" }}>{message}</p> : null}{receipt[task.task_id] ? <OutcomeStatus outcome={receipt[task.task_id]} /> : null}</li>)}</ul> : null}
    {total > PAGE_SIZE ? <nav aria-label="Approval inbox pages" style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}><button type="button" style={offset === 0 || running ? disabledButtonStyle : buttonStyle} disabled={offset === 0 || running} onClick={() => { void load(Math.max(0, offset - PAGE_SIZE)); }}>Previous</button><span style={{ color: "var(--steel)", fontSize: "var(--text-sm)" }}>Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span><button type="button" style={offset + PAGE_SIZE >= total || running ? disabledButtonStyle : buttonStyle} disabled={offset + PAGE_SIZE >= total || running} onClick={() => { void load(offset + PAGE_SIZE); }}>Next</button></nav> : null}
    {Object.keys(receipt).length > 0 ? <section aria-label="Latest approval operation receipt" style={{ display: "grid", gap: "var(--sp-2)", padding: "var(--sp-3)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-md)" }}><div style={toolbarStyle}><strong>Latest approval operation receipt</strong><button type="button" style={buttonStyle} onClick={() => { setReceipt({}); }}>Dismiss receipt</button></div>{Object.entries(receipt).map(([id, outcome]) => <div key={id}><code>{id}</code> <OutcomeStatus outcome={outcome} /></div>)}</section> : null}
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}><button type="button" style={freshSelected.length === 0 || running ? disabledButtonStyle : primaryButtonStyle} disabled={freshSelected.length === 0 || running} onClick={() => { void approve(freshSelected.map((task) => task.task_id), false); }}>Approve selected ({freshSelected.length})</button><button type="button" style={selected.size === 0 || running ? disabledButtonStyle : buttonStyle} disabled={selected.size === 0 || running} onClick={() => { setSelected(new Set()); }}>Clear selection</button>{running ? <button type="button" style={buttonStyle} onClick={cancel}>Cancel remaining</button> : null}{unresolvedIds.length > 0 && !running ? <button type="button" style={buttonStyle} onClick={() => { void approve(unresolvedIds, true); }}>Retry unresolved ({unresolvedIds.length})</button> : null}</div>
  </section>;
}

function OutcomeStatus({ outcome }: { outcome: Outcome }) {
  if (outcome.state === "approved") return <StatusChip tone="ok">Approved · {outcome.taskStatus} · {outcome.runStatus}</StatusChip>;
  return <StatusChip tone={outcome.state === "unknown" ? "warn" : "danger"}>{outcome.message}</StatusChip>;
}
