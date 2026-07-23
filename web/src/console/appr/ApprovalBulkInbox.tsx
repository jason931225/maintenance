import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import {
  ApprWorkflowApiError,
  createApprWorkflowApi,
  type ApprWorkflowApi,
  type WorkflowWaitingTask,
} from "./composeApi";

const PAGE_SIZE = 50;
const T = ko.console.appr.bulkInbox;

type Outcome =
  | { state: "approved"; taskStatus: string; runStatus: string }
  | { state: "failed" | "unknown"; message: string };

type Receipt = Partial<Record<string, Outcome>>;
type PersistedOperation = { idempotencyKey: string; outcome: Outcome };
type PersistedApprovalOperations = { version: 1; expiresAt: number; operations: Record<string, PersistedOperation> };
const OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
const UNCONFIRMED_SUBMISSION = T.receipt.unconfirmed;

function receiptEntries(receipt: Receipt): Array<[string, Outcome]> {
  return Object.entries(receipt).filter((entry): entry is [string, Outcome] => entry[1] !== undefined);
}

export interface ApprovalBulkOperationContext {
  currentUserId?: string;
  currentOrgId?: string;
  clientSessionIncarnation?: string;
}

function operationStorageKey(context: ApprovalBulkOperationContext): string | undefined {
  const { currentOrgId, currentUserId, clientSessionIncarnation } = context;
  if (!currentOrgId || !currentUserId || !clientSessionIncarnation) return undefined;
  return `maintenance.approval-bulk.operations.v2.${encodeURIComponent(currentOrgId)}.${encodeURIComponent(currentUserId)}.${encodeURIComponent(clientSessionIncarnation)}`;
}

function securityContextFingerprint(context: ApprovalBulkOperationContext): string {
  return JSON.stringify([context.currentOrgId ?? null, context.currentUserId ?? null, context.clientSessionIncarnation ?? null]);
}

function hasCompleteOperationContext(context: ApprovalBulkOperationContext): boolean {
  return Boolean(context.currentOrgId && context.currentUserId && context.clientSessionIncarnation);
}

function loadOperations(context: ApprovalBulkOperationContext): PersistedApprovalOperations | undefined {
  const key = operationStorageKey(context);
  if (!key || typeof window === "undefined") return undefined;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<PersistedApprovalOperations> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.expiresAt !== "number" || !parsed.operations) {
      window.localStorage.removeItem(key);
      return undefined;
    }
    // An expired presentation receipt can be discarded only when every
    // operation is service-confirmed. Unknown/failed entries retain their
    // immutable idempotency identity until authoritative resolution.
    if (parsed.expiresAt <= Date.now() && Object.values(parsed.operations).every(({ outcome }) => outcome.state === "approved")) {
      window.localStorage.removeItem(key);
      return undefined;
    }
    return parsed as PersistedApprovalOperations;
  } catch {
    window.localStorage.removeItem(key);
    return undefined;
  }
}

function saveOperations(context: ApprovalBulkOperationContext, operations: Record<string, PersistedOperation>) {
  const key = operationStorageKey(context);
  if (!key || typeof window === "undefined") return;
  if (Object.keys(operations).length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify({ version: 1, expiresAt: Date.now() + OPERATION_TTL_MS, operations } satisfies PersistedApprovalOperations));
}

function persistOperation(context: ApprovalBulkOperationContext, taskId: string, idempotencyKey: string, outcome: Outcome) {
  const operations = { ...(loadOperations(context)?.operations ?? {}), [taskId]: { idempotencyKey, outcome } };
  saveOperations(context, operations);
}

export interface ApprovalBulkInboxProps {
  api?: ApprWorkflowApi;
  bearerToken?: string;
  currentUserId?: string;
  currentOrgId?: string;
  clientSessionIncarnation?: string;
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
  if (error instanceof DOMException && error.name === "AbortError") return T.receipt.cancelledUnconfirmed;
  return T.receipt.unconfirmed;
}

function capabilityMessage(task: WorkflowWaitingTask): string | undefined {
  if (task.bulk_decision.decidable) return undefined;
  return task.bulk_decision.reason ?? "SERVER_CAPABILITY_UNAVAILABLE";
}

/**
 * A bounded orchestration over the audited per-task decision endpoint. The
 * workflow service, rather than the browser, owns eligibility. Each task keeps
 * its immutable idempotency identity until the service confirms a terminal
 * result, including across a cancellation or an interleaved new operation.
 */
export function ApprovalBulkInbox({ api, bearerToken, currentUserId, currentOrgId, clientSessionIncarnation }: ApprovalBulkInboxProps) {
  const operationContext = useMemo<ApprovalBulkOperationContext>(() => ({ currentUserId, currentOrgId, clientSessionIncarnation }), [clientSessionIncarnation, currentOrgId, currentUserId]);
  const contextFingerprint = securityContextFingerprint(operationContext);
  const contextComplete = hasCompleteOperationContext(operationContext);
  const workflowApi = useMemo(() => api ?? createApprWorkflowApi({ bearerToken }), [api, bearerToken]);
  const mountedRef = useRef(false as boolean);
  const loadGenerationRef = useRef(0);
  const executionRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const currentTaskRef = useRef<string | undefined>(undefined);
  const persistedRef = useRef<PersistedApprovalOperations | undefined>(loadOperations(operationContext));
  const securityContextRef = useRef(contextFingerprint);
  const renderedContextRef = useRef(contextFingerprint);
  if (renderedContextRef.current !== contextFingerprint) {
    // A render with a different (including incomplete) identity must fence
    // old data before effects run; a discarded render can only fail closed.
    renderedContextRef.current = contextFingerprint;
    loadGenerationRef.current += 1;
    executionRef.current += 1;
    controllerRef.current?.abort();
  }
  const keyByTaskRef = useRef<Partial<Record<string, string>>>(Object.fromEntries(Object.entries(persistedRef.current?.operations ?? {}).map(([taskId, operation]) => [taskId, operation.idempotencyKey])));
  const [tasks, setTasks] = useState<WorkflowWaitingTask[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedTasks, setSelectedTasks] = useState<Partial<Record<string, WorkflowWaitingTask>>>({});
  const [receipt, setReceipt] = useState<Receipt>(() => Object.fromEntries(Object.entries(persistedRef.current?.operations ?? {}).map(([taskId, operation]) => [taskId, operation.outcome])));
  const [receiptContextFingerprint, setReceiptContextFingerprint] = useState(contextFingerprint);
  const [loadedContextFingerprint, setLoadedContextFingerprint] = useState<string | undefined>(undefined);
  const [receiptPresentationHidden, setReceiptPresentationHidden] = useState(false);
  const [pageCursors, setPageCursors] = useState<string[]>([""]);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [readState, setReadState] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const isMounted = () => mountedRef.current;

  const load = useCallback(async (cursor?: string) => {
    const requestFingerprint = contextFingerprint;
    if (!contextComplete) return;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setReadState("loading");
    try {
      const page = await workflowApi.listWaitingTasks({ limit: PAGE_SIZE, cursor });
      if (!isMounted() || generation !== loadGenerationRef.current || securityContextRef.current !== requestFingerprint || renderedContextRef.current !== requestFingerprint) return;
      setTasks(page.items);
      setHasMore(page.has_more);
      setNextCursor(page.next_cursor);
      setLoadedContextFingerprint(requestFingerprint);
      setReadState("ready");
    } catch {
      if (isMounted() && generation === loadGenerationRef.current && securityContextRef.current === requestFingerprint && renderedContextRef.current === requestFingerprint) {
        setLoadedContextFingerprint(requestFingerprint);
        setReadState("error");
      }
    }
  }, [contextComplete, contextFingerprint, workflowApi]);

  useEffect(() => {
    mountedRef.current = true;
    if (contextComplete) void load();
    return () => {
      mountedRef.current = false;
      executionRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [contextComplete, load]);

  // A role/persona switch can reuse this mounted component. Never carry a
  // prior user's receipt or idempotency key into that new security context.
  useEffect(() => {
    if (securityContextRef.current === contextFingerprint) return;
    // Context changes are a hard authority boundary: abort any old request,
    // invalidate its response generation, and hydrate only the new context.
    executionRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    currentTaskRef.current = undefined;
    setRunning(false);
    setCancelled(false);
    securityContextRef.current = contextFingerprint;
    const stored = contextComplete ? loadOperations(operationContext) : undefined;
    keyByTaskRef.current = Object.fromEntries(Object.entries(stored?.operations ?? {}).map(([taskId, operation]) => [taskId, operation.idempotencyKey]));
    setReceipt(Object.fromEntries(Object.entries(stored?.operations ?? {}).map(([taskId, operation]) => [taskId, operation.outcome])));
    setReceiptContextFingerprint(contextFingerprint);
    setLoadedContextFingerprint(undefined);
    setTasks([]);
    setHasMore(false);
    setNextCursor(undefined);
    setReceiptPresentationHidden(false);
    setSelected(new Set());
    setSelectedTasks({});
    setPageCursors([""]);
    setPageIndex(0);
    if (contextComplete) void load();
  }, [contextComplete, contextFingerprint, load, operationContext]);

  const rows = useMemo(() => tasks.map((task) => ({ task, message: capabilityMessage(task) })), [tasks]);
  const contextReady = contextComplete && loadedContextFingerprint === contextFingerprint && receiptContextFingerprint === contextFingerprint;
  const selectedRows = useMemo(() => [...selected].map((id) => selectedTasks[id]).filter((task): task is WorkflowWaitingTask => task !== undefined), [selected, selectedTasks]);
  const unresolvedIds = useMemo(() => receiptEntries(receipt).flatMap(([id, outcome]) => outcome.state === "approved" ? [] : [id]), [receipt]);
  const freshSelected = useMemo(() => selectedRows.filter((task) => task.bulk_decision.decidable && !keyByTaskRef.current[task.task_id]), [selectedRows]);

  function toggle(task: WorkflowWaitingTask) {
    if (running || !task.bulk_decision.decidable) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(task.task_id)) next.delete(task.task_id); else next.add(task.task_id);
      return next;
    });
    setSelectedTasks((previous) => previous[task.task_id] ? previous : { ...previous, [task.task_id]: task });
  }

  async function approve(ids: string[], retrying: boolean) {
    if (running || !contextComplete || renderedContextRef.current !== contextFingerprint) return;
    const candidates = ids.map((id) => selectedTasks[id] ?? tasks.find((task) => task.task_id === id)).filter((task): task is WorkflowWaitingTask => task !== undefined && task.bulk_decision.decidable);
    const actionable = candidates.filter((task) => retrying ? Boolean(keyByTaskRef.current[task.task_id]) : !keyByTaskRef.current[task.task_id]);
    if (actionable.length === 0) return;

    const execution = executionRef.current + 1;
    executionRef.current = execution;
    const executionContext = contextFingerprint;
    const controller = new AbortController();
    controllerRef.current = controller;
    setCancelled(false);
    setRunning(true);
    const unresolved = new Set<string>();
    for (const task of actionable) {
      if (!isMounted() || execution !== executionRef.current || securityContextRef.current !== executionContext || renderedContextRef.current !== executionContext || controller.signal.aborted) { unresolved.add(task.task_id); break; }
      currentTaskRef.current = task.task_id;
      const existingKey = keyByTaskRef.current[task.task_id];
      const idempotencyKey = existingKey ?? `approval-bulk-${newOperationId()}-${task.task_id}`;
      if (!existingKey) keyByTaskRef.current[task.task_id] = idempotencyKey;
      const unconfirmed: Outcome = { state: "unknown", message: UNCONFIRMED_SUBMISSION };
      // Write before issuing the request: a browser refresh/unmount may abort
      // the response path, but must never lose this immutable operation key.
      persistOperation(operationContext, task.task_id, idempotencyKey, unconfirmed);
      setReceipt((previous) => ({ ...previous, [task.task_id]: unconfirmed }));
      setReceiptPresentationHidden(false);
      try {
        const result = await workflowApi.decideTask(task.task_id, "approve", { idempotencyKey, signal: controller.signal });
        if (!isMounted() || execution !== executionRef.current || securityContextRef.current !== executionContext || renderedContextRef.current !== executionContext) return;
        setReceipt((previous) => ({ ...previous, [task.task_id]: { state: "approved", taskStatus: result.taskStatus, runStatus: result.runStatus } }));
      } catch (error) {
        if (!isMounted() || execution !== executionRef.current || securityContextRef.current !== executionContext || renderedContextRef.current !== executionContext) return;
        const unknown = error instanceof DOMException && error.name === "AbortError";
        unresolved.add(task.task_id);
        setReceipt((previous) => ({ ...previous, [task.task_id]: { state: unknown ? "unknown" : "failed", message: errorMessage(error) } }));
        if (unknown) break;
      }
    }
    if (!isMounted() || execution !== executionRef.current || securityContextRef.current !== executionContext || renderedContextRef.current !== executionContext) return;
    currentTaskRef.current = undefined;
    controllerRef.current = undefined;
    setRunning(false);
    setSelected(unresolved);
    void load(pageCursors[pageIndex] || undefined);
  }

  function cancel() {
    if (!running || !contextComplete || renderedContextRef.current !== contextFingerprint) return;
    const taskId = currentTaskRef.current;
    controllerRef.current?.abort();
    executionRef.current += 1;
    currentTaskRef.current = undefined;
    if (taskId) {
      const outcome: Outcome = { state: "unknown", message: T.receipt.cancelledUnconfirmed };
      const idempotencyKey = keyByTaskRef.current[taskId];
      if (idempotencyKey) persistOperation(operationContext, taskId, idempotencyKey, outcome);
      setReceipt((previous) => ({ ...previous, [taskId]: outcome }));
      setSelected((previous) => new Set([...previous, taskId]));
    }
    setRunning(false);
    setCancelled(true);
  }

  function dismissReceipt() {
    // Dismissal is presentation-only for unresolved operations. Their immutable
    // idempotency identity must survive until the service confirms a terminal
    // outcome, otherwise retry could duplicate a side effect.
    const remaining = receiptEntries(receipt).filter(([, outcome]) => outcome.state !== "approved");
    const unresolvedIds = new Set(remaining.map(([taskId]) => taskId));
    keyByTaskRef.current = Object.fromEntries(Object.entries(keyByTaskRef.current).filter(([taskId]) => unresolvedIds.has(taskId)));
    setReceipt(Object.fromEntries(remaining));
    setReceiptPresentationHidden(true);
  }

  useEffect(() => {
    // The old receipt may still be rendered during the context-switch commit;
    // never serialize it into the new tenant/session partition.
    if (!contextComplete || receiptContextFingerprint !== contextFingerprint || renderedContextRef.current !== contextFingerprint) return;
    const operations = receiptEntries(receipt).reduce<Record<string, PersistedOperation>>((stored, [taskId, outcome]) => {
      const idempotencyKey = keyByTaskRef.current[taskId];
      if (idempotencyKey) stored[taskId] = { idempotencyKey, outcome };
      return stored;
    }, {});
    saveOperations(operationContext, operations);
  }, [contextComplete, contextFingerprint, operationContext, receipt, receiptContextFingerprint]);

  return <section className="console" style={sectionStyle} aria-labelledby="approval-bulk-inbox-title">
    <div style={toolbarStyle}><div><h2 id="approval-bulk-inbox-title" style={{ margin: 0, fontSize: "var(--text-card-title)" }}>{T.title}</h2><p style={{ margin: "var(--sp-1) 0 0", color: "var(--steel)", fontSize: "var(--text-sm)" }}>{T.description}</p></div><button type="button" style={running || !contextReady ? disabledButtonStyle : buttonStyle} onClick={() => { void load(pageCursors[pageIndex] || undefined); }} disabled={running || !contextReady || readState === "loading"}>{T.refresh}</button></div>
    {!contextReady ? <p style={{ margin: 0, color: "var(--steel)" }}>{contextComplete ? T.contextLoading : T.contextUnavailable}</p> : <><div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }} aria-live="polite"><StatusChip tone="info">{T.selected(selectedRows.length)}</StatusChip>{cancelled ? <StatusChip tone="warn">{T.cancelled}</StatusChip> : null}</div>
    {readState === "error" ? <div role="alert"><StatusChip tone="danger">{T.loadFailed}</StatusChip> <button type="button" style={buttonStyle} onClick={() => { void load(pageCursors[pageIndex] || undefined); }}>{T.retryLoading}</button></div> : null}
    {readState === "loading" && tasks.length === 0 ? <p style={{ margin: 0, color: "var(--steel)" }}>{T.loadingTasks}</p> : null}
    {readState === "ready" && rows.length === 0 ? <p style={{ margin: 0, color: "var(--steel)" }}>{T.empty}</p> : null}
    {rows.length > 0 ? <ul style={{ display: "grid", gap: "var(--sp-2)", listStyle: "none", margin: 0, padding: 0 }} aria-label={T.tasksAria}>{rows.map(({ task, message }) => <li key={task.task_id} style={{ display: "grid", gap: "var(--sp-2)", padding: "var(--sp-3)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-md)", background: "var(--muted)" }}><div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)", alignItems: "start" }}><input id={`approval-select-${task.task_id}`} type="checkbox" checked={selected.has(task.task_id)} disabled={Boolean(message) || running} aria-describedby={message ? `approval-guard-${task.task_id}` : undefined} onChange={() => { toggle(task); }} /><div style={{ display: "grid", gap: "var(--sp-1)", minWidth: 0, flex: "1 1 18rem" }}><label htmlFor={`approval-select-${task.task_id}`} style={{ color: "var(--ink)", fontWeight: "var(--fw-strong)", cursor: message || running ? "default" : "pointer" }}>{task.title}</label><span style={{ color: "var(--steel)", fontSize: "var(--text-sm)" }}>{task.waiting_key} · {task.assignee_role_key ?? T.personalInbox}</span>{task.due_at ? <span style={{ color: "var(--steel)", fontSize: "var(--text-xs)" }}>{T.due(new Date(task.due_at).toLocaleString())}</span> : null}</div><StatusChip tone={task.status === "CLAIMED" ? "info" : "neutral"}>{task.status}</StatusChip></div>{message ? <p id={`approval-guard-${task.task_id}`} style={{ margin: 0, color: "var(--danger-tx)", fontSize: "var(--text-sm)" }}>{message}</p> : null}<MaybeOutcomeStatus outcome={receipt[task.task_id]} /></li>)}</ul> : null}
    {pageIndex > 0 || hasMore ? <nav aria-label={T.pagesAria} style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}><button type="button" style={pageIndex === 0 || running ? disabledButtonStyle : buttonStyle} disabled={pageIndex === 0 || running} onClick={() => { const previous = pageCursors[pageIndex - 1]; setPageIndex(pageIndex - 1); void load(previous || undefined); }}>{T.previous}</button><span style={{ color: "var(--steel)", fontSize: "var(--text-sm)" }}>{T.page(pageIndex + 1)}</span><button type="button" style={!hasMore || running ? disabledButtonStyle : buttonStyle} disabled={!hasMore || running} onClick={() => { const next = nextCursor; if (!next) return; const cursors = [...pageCursors.slice(0, pageIndex + 1), next]; setPageCursors(cursors); setPageIndex(pageIndex + 1); void load(next); }}>{T.next}</button></nav> : null}
    {Object.keys(receipt).length > 0 && !receiptPresentationHidden ? <section aria-label={T.receiptAria} style={{ display: "grid", gap: "var(--sp-2)", padding: "var(--sp-3)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-md)" }}><div style={toolbarStyle}><strong>{T.receiptTitle}</strong><button type="button" style={buttonStyle} onClick={dismissReceipt}>{T.dismissReceipt}</button></div>{receiptEntries(receipt).map(([id, outcome]) => <div key={id}><code>{id}</code> <OutcomeStatus outcome={outcome} /></div>)}</section> : null}
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}><button type="button" style={freshSelected.length === 0 || running ? disabledButtonStyle : primaryButtonStyle} disabled={freshSelected.length === 0 || running} onClick={() => { void approve(freshSelected.map((task) => task.task_id), false); }}>{T.approveSelected(freshSelected.length)}</button><button type="button" style={selected.size === 0 || running ? disabledButtonStyle : buttonStyle} disabled={selected.size === 0 || running} onClick={() => { setSelected(new Set()); }}>{T.clearSelection}</button>{running ? <button type="button" style={buttonStyle} onClick={cancel}>{T.cancelRemaining}</button> : null}{unresolvedIds.length > 0 && !running ? <button type="button" style={buttonStyle} onClick={() => { void approve(unresolvedIds, true); }}>{T.retryUnresolved(unresolvedIds.length)}</button> : null}</div></>}
  </section>;
}

function OutcomeStatus({ outcome }: { outcome: Outcome }) {
  if (outcome.state === "approved") return <StatusChip tone="ok">{T.receipt.approved(outcome.taskStatus, outcome.runStatus)}</StatusChip>;
  return <StatusChip tone={outcome.state === "unknown" ? "warn" : "danger"}>{outcome.message}</StatusChip>;
}

function MaybeOutcomeStatus({ outcome }: { outcome: Outcome | undefined }) {
  return outcome ? <OutcomeStatus outcome={outcome} /> : null;
}
