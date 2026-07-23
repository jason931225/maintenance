import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { StatusChip } from "../components";
import {
  ApprWorkflowApiError,
  createApprWorkflowApi,
  type ApprWorkflowApi,
  type WorkflowWaitingTask,
} from "./composeApi";

const PAGE_SIZE = 10;

type Outcome =
  | { state: "approved"; taskStatus: string; runStatus: string }
  | { state: "failed"; message: string }
  | { state: "unknown"; message: string };

type Guard = "missingPolicy" | "notDecision" | "claimedByOther" | "notOpen";

export interface ApprovalBulkInboxProps {
  api?: ApprWorkflowApi;
  bearerToken?: string;
  currentUserId?: string;
}

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const buttonStyle: CSSProperties = {
  minHeight: 34,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--signal-deep)",
  background: "var(--signal)",
  color: "var(--accent-tx)",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  cursor: "not-allowed",
  opacity: 0.55,
};

function newOperationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `${String(Date.now())}-${String(Math.random()).slice(2)}`;
}

function guardFor(
  task: WorkflowWaitingTask,
  currentUserId?: string,
): Guard | undefined {
  if (!task.required_policy) return "missingPolicy";
  if (
    task.waiting_key === "finalize.author" ||
    task.waiting_key === "receipt.target"
  )
    return "notDecision";
  if (
    task.status === "CLAIMED" &&
    task.claimed_by &&
    task.claimed_by !== currentUserId
  )
    return "claimedByOther";
  if (task.status !== "OPEN" && task.status !== "CLAIMED") return "notOpen";
  return undefined;
}

function guardCopy(guard: Guard): string {
  switch (guard) {
    case "missingPolicy":
      return "This task has no server policy boundary and cannot be bulk decided.";
    case "notDecision":
      return "This is a finalization or receipt task and must remain individually reviewable.";
    case "claimedByOther":
      return "This task is claimed by another user.";
    case "notOpen":
      return "This task is no longer open for a decision.";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApprWorkflowApiError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError")
    return "No confirmed result after cancellation. Retry uses the same idempotency key.";
  return "No confirmed result. Retry uses the same idempotency key.";
}

/**
 * A bounded client orchestration over the existing per-task decision API. There
 * is no server batch endpoint, so each decision keeps its own audited,
 * idempotent mutation and per-item result. The inbox never invents monetary or
 * urgency eligibility from form payloads.
 */
export function ApprovalBulkInbox({
  api,
  bearerToken,
  currentUserId,
}: ApprovalBulkInboxProps) {
  const workflowApi = useMemo(
    () => api ?? createApprWorkflowApi({ bearerToken }),
    [api, bearerToken],
  );
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const executionRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const currentTaskRef = useRef<string | undefined>(undefined);
  const operationIdRef = useRef<string | undefined>(undefined);
  const [tasks, setTasks] = useState<WorkflowWaitingTask[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [page, setPage] = useState(0);
  const [readState, setReadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const load = useCallback(async () => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setReadState("loading");
    try {
      const next = await workflowApi.listWaitingTasks();
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return;
      setTasks(next);
      setSelected((previous) => {
        const visibleEligible = new Set(
          next
            .filter((task) => !guardFor(task, currentUserId))
            .map((task) => task.task_id),
        );
        return new Set([...previous].filter((id) => visibleEligible.has(id)));
      });
      setReadState("ready");
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current)
        setReadState("error");
    }
  }, [currentUserId, workflowApi]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      executionRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  const rows = useMemo(
    () => tasks.map((task) => ({ task, guard: guardFor(task, currentUserId) })),
    [currentUserId, tasks],
  );
  const eligibleRows = useMemo(() => rows.filter((row) => !row.guard), [rows]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visibleRows = rows.slice(
    page * PAGE_SIZE,
    page * PAGE_SIZE + PAGE_SIZE,
  );
  const selectedRows = useMemo(
    () => eligibleRows.filter(({ task }) => selected.has(task.task_id)),
    [eligibleRows, selected],
  );
  const retryableIds = useMemo(
    () =>
      Object.entries(outcomes).flatMap(([id, outcome]) =>
        outcome.state === "approved" ? [] : [id],
      ),
    [outcomes],
  );

  useEffect(() => {
    if (page >= pages) setPage(pages - 1);
  }, [page, pages]);

  function toggle(taskId: string) {
    if (running) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  async function approve(ids: string[], retrying = false) {
    const candidates = ids
      .map((id) => tasks.find((task) => task.task_id === id))
      .filter(
        (task): task is WorkflowWaitingTask =>
          task !== undefined && !guardFor(task, currentUserId),
      );
    if (candidates.length === 0 || running) return;

    const execution = executionRef.current + 1;
    executionRef.current = execution;
    const operationId = retrying ? operationIdRef.current : newOperationId();
    operationIdRef.current = operationId ?? newOperationId();
    const controller = new AbortController();
    controllerRef.current = controller;
    setCancelled(false);
    setRunning(true);

    const unresolved = new Set<string>();
    for (const task of candidates) {
      if (
        !mountedRef.current ||
        execution !== executionRef.current ||
        controller.signal.aborted
      ) {
        unresolved.add(task.task_id);
        break;
      }
      currentTaskRef.current = task.task_id;
      const idempotencyKey = `approval-bulk-${operationIdRef.current}-${task.task_id}`;
      try {
        const result = await workflowApi.decideTask(task.task_id, "approve", {
          idempotencyKey,
          signal: controller.signal,
        });
        if (!mountedRef.current || execution !== executionRef.current) return;
        setOutcomes((previous) => ({
          ...previous,
          [task.task_id]: {
            state: "approved",
            taskStatus: result.taskStatus,
            runStatus: result.runStatus,
          },
        }));
      } catch (error) {
        if (!mountedRef.current || execution !== executionRef.current) return;
        const unknown =
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        unresolved.add(task.task_id);
        setOutcomes((previous) => ({
          ...previous,
          [task.task_id]: {
            state: unknown ? "unknown" : "failed",
            message: errorMessage(error),
          },
        }));
        if (unknown) break;
      }
    }
    if (!mountedRef.current || execution !== executionRef.current) return;
    currentTaskRef.current = undefined;
    controllerRef.current = undefined;
    setRunning(false);
    setSelected(unresolved);
    void load();
  }

  function cancel() {
    if (!running) return;
    const taskId = currentTaskRef.current;
    controllerRef.current?.abort();
    executionRef.current += 1;
    currentTaskRef.current = undefined;
    if (taskId) {
      setOutcomes((previous) => ({
        ...previous,
        [taskId]: {
          state: "unknown",
          message:
            "No confirmed result after cancellation. Retry uses the same idempotency key.",
        },
      }));
      setSelected((previous) => new Set([...previous, taskId]));
    }
    setRunning(false);
    setCancelled(true);
  }

  return (
    <section
      className="console"
      style={sectionStyle}
      aria-labelledby="approval-bulk-inbox-title"
    >
      <div style={toolbarStyle}>
        <div>
          <h2
            id="approval-bulk-inbox-title"
            style={{ margin: 0, fontSize: "var(--text-card-title)" }}
          >
            Approval inbox
          </h2>
          <p
            style={{
              margin: "var(--sp-1) 0 0",
              color: "var(--steel)",
              fontSize: "var(--text-sm)",
            }}
          >
            Bulk approval sends one audited, idempotent decision per eligible
            task.
          </p>
        </div>
        <button
          type="button"
          style={running ? disabledButtonStyle : buttonStyle}
          onClick={() => {
            void load();
          }}
          disabled={running || readState === "loading"}
        >
          Refresh
        </button>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sp-2)",
          alignItems: "center",
        }}
        aria-live="polite"
      >
        <StatusChip tone="info">{selectedRows.length} selected</StatusChip>
        <StatusChip tone="neutral">
          Amount unavailable: this inbox does not expose an authoritative amount
          field.
        </StatusChip>
        {cancelled ? (
          <StatusChip tone="warn">
            Cancelled. The in-flight result is unconfirmed until retried.
          </StatusChip>
        ) : null}
      </div>

      {readState === "error" ? (
        <div
          role="alert"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--sp-3)",
            alignItems: "center",
          }}
        >
          <StatusChip tone="danger">
            The approval inbox could not be loaded.
          </StatusChip>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              void load();
            }}
          >
            Retry loading
          </button>
        </div>
      ) : null}

      {readState === "loading" && tasks.length === 0 ? (
        <p style={{ margin: 0, color: "var(--steel)" }}>
          Loading approval tasks…
        </p>
      ) : null}
      {readState === "ready" && rows.length === 0 ? (
        <p style={{ margin: 0, color: "var(--steel)" }}>
          There are no actionable approval tasks.
        </p>
      ) : null}

      {visibleRows.length > 0 ? (
        <ul
          style={{
            display: "grid",
            gap: "var(--sp-2)",
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
          aria-label="Approval tasks"
        >
          {visibleRows.map(({ task, guard }) => {
            const outcome = outcomes[task.task_id];
            const guardId = `approval-guard-${task.task_id}`;
            return (
              <li
                key={task.task_id}
                style={{
                  display: "grid",
                  gap: "var(--sp-2)",
                  padding: "var(--sp-3)",
                  border: "1px solid var(--border-soft)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--muted)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "var(--sp-3)",
                    alignItems: "start",
                  }}
                >
                  <input
                    id={`approval-select-${task.task_id}`}
                    type="checkbox"
                    checked={selected.has(task.task_id)}
                    disabled={Boolean(guard) || running}
                    aria-describedby={guard ? guardId : undefined}
                    onChange={() => {
                      toggle(task.task_id);
                    }}
                  />
                  <div
                    style={{
                      display: "grid",
                      gap: "var(--sp-1)",
                      minWidth: 0,
                      flex: "1 1 18rem",
                    }}
                  >
                    <label
                      htmlFor={`approval-select-${task.task_id}`}
                      style={{
                        color: "var(--ink)",
                        fontWeight: "var(--fw-strong)",
                        cursor: guard || running ? "default" : "pointer",
                      }}
                    >
                      {task.title}
                    </label>
                    <span
                      style={{
                        color: "var(--steel)",
                        fontSize: "var(--text-sm)",
                      }}
                    >
                      {task.waiting_key} ·{" "}
                      {task.assignee_role_key ?? "personal inbox"}
                    </span>
                    {task.due_at ? (
                      <span
                        style={{
                          color: "var(--steel)",
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        Due {new Date(task.due_at).toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                  <StatusChip
                    tone={task.status === "CLAIMED" ? "info" : "neutral"}
                  >
                    {task.status}
                  </StatusChip>
                </div>
                {guard ? (
                  <p
                    id={guardId}
                    style={{
                      margin: 0,
                      color: "var(--danger-tx)",
                      fontSize: "var(--text-sm)",
                    }}
                  >
                    {guardCopy(guard)}
                  </p>
                ) : null}
                {outcome ? <OutcomeStatus outcome={outcome} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {rows.length > PAGE_SIZE ? (
        <nav
          aria-label="Approval inbox pages"
          style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}
        >
          <button
            type="button"
            style={page === 0 || running ? disabledButtonStyle : buttonStyle}
            disabled={page === 0 || running}
            onClick={() => {
              setPage((value) => value - 1);
            }}
          >
            Previous
          </button>
          <span style={{ color: "var(--steel)", fontSize: "var(--text-sm)" }}>
            Page {page + 1} of {pages}
          </span>
          <button
            type="button"
            style={
              page + 1 === pages || running ? disabledButtonStyle : buttonStyle
            }
            disabled={page + 1 === pages || running}
            onClick={() => {
              setPage((value) => value + 1);
            }}
          >
            Next
          </button>
        </nav>
      ) : null}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sp-2)",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          style={
            selectedRows.length === 0 || running
              ? disabledButtonStyle
              : primaryButtonStyle
          }
          disabled={selectedRows.length === 0 || running}
          onClick={() => {
            void approve(selectedRows.map(({ task }) => task.task_id));
          }}
        >
          Approve selected ({selectedRows.length})
        </button>
        <button
          type="button"
          style={
            selected.size === 0 || running ? disabledButtonStyle : buttonStyle
          }
          disabled={selected.size === 0 || running}
          onClick={() => {
            setSelected(new Set());
          }}
        >
          Clear selection
        </button>
        {running ? (
          <button type="button" style={buttonStyle} onClick={cancel}>
            Cancel remaining
          </button>
        ) : null}
        {retryableIds.length > 0 && !running ? (
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              void approve(retryableIds, true);
            }}
          >
            Retry unresolved ({retryableIds.length})
          </button>
        ) : null}
      </div>
    </section>
  );
}

function OutcomeStatus({ outcome }: { outcome: Outcome }) {
  if (outcome.state === "approved")
    return (
      <StatusChip tone="ok">
        Approved · {outcome.taskStatus} · {outcome.runStatus}
      </StatusChip>
    );
  return (
    <StatusChip tone={outcome.state === "unknown" ? "warn" : "danger"}>
      {outcome.message}
    </StatusChip>
  );
}
