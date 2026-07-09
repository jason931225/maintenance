// UI-M4 전자결재 — the run-detail + decision surface rendered inside the pinned
// object panel (DESIGN.md §4.7: 상세 보기의 기본은 핀 패널). Fetches the engine run
// detail (head + node-step timeline + current waiting tasks) and offers the real
// engine transitions on the actionable task: claim / 승인·반려·거부 (decide) /
// 종결 (author or 대행 delegate finalize) / 사후 반려 (post-finalization rejection).
//
// SoD (deny-by-omission): a run I initiated never offers me the 승인 control — the
// backend #205 guard blocks self-approval, and the server 403 is surfaced as the
// guardrail toast when the omission cannot be detected client-side.

import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  WorkflowRunDetailResponse,
  WorkflowTaskSummary,
} from "../../api/types";
import type { ConsoleApiClient } from "../../api/client";
import { Chip } from "../../components/console/primitives";
import { emitConsoleToast } from "../../components/shell/useConsoleToast";
import { AuthContext } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { cn } from "../../lib/utils";
import {
  FINALIZE_POLICY,
  runStatusLabel,
  runStatusTone,
  stepStatusTone,
  taskStatusLabel,
  taskStatusTone,
} from "./approvals-data";
import { emitApprovalsChanged } from "./changed-event";

type FetchState = "loading" | "idle" | "error";

function idemKey(): string {
  return crypto.randomUUID();
}

function decisionLabel(decision: unknown): string | undefined {
  if (decision === "approve") return ko.eApprovals.decision.approve;
  if (decision === "reject") return ko.eApprovals.decision.reject;
  if (decision === "return") return ko.eApprovals.decision.return;
  return undefined;
}

/** Read `outcome.decision` from a node step's opaque outcome payload. */
function outcomeDecision(outcome: Record<string, unknown> | undefined): string | undefined {
  const value = outcome?.["decision"];
  return typeof value === "string" ? value : undefined;
}

export function ApprovalDetailPanel({ runId }: { runId: string }) {
  const auth = useContext(AuthContext);
  const api = auth?.api;
  const myUserId = auth?.session?.user_id;

  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const [detail, setDetail] = useState<WorkflowRunDetailResponse | undefined>();
  const [state, setState] = useState<FetchState>("loading");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!api) {
      setState("idle");
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const isCurrent = () => mountedRef.current && requestRef.current === requestId;
    setState("loading");
    const response = await api
      .GET("/api/v1/workflow-runs/{run_id}", {
        params: { path: { run_id: runId } },
      })
      .catch(() => undefined);
    if (!isCurrent()) return;
    if (!response?.data) {
      setState("error");
      return;
    }
    setDetail(response.data);
    setState("idle");
  }, [api, runId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  /** Run one engine mutation, then toast + refresh the list + reload this panel.
   * A 403 self-approval denial surfaces the guardrail message (SoD). */
  const act = useCallback(
    async (
      call: (client: ConsoleApiClient) => Promise<{ response: Response; data?: unknown } | undefined>,
      successMessage: string,
    ) => {
      if (!api || busy) return;
      setBusy(true);
      let result: { response: Response; data?: unknown } | undefined;
      try {
        result = await call(api).catch(() => undefined);
      } finally {
        if (mountedRef.current) setBusy(false);
      }
      if (!mountedRef.current) return;
      if (result?.data) {
        setComment("");
        emitConsoleToast({ message: successMessage });
        emitApprovalsChanged();
        void load();
        return;
      }
      const status = result?.response.status;
      emitConsoleToast({
        message:
          status === 403
            ? ko.eApprovals.toasts.forbidden
            : ko.eApprovals.toasts.actionFailed,
      });
    },
    [api, busy, load],
  );

  const claim = (task: WorkflowTaskSummary) => {
    void act(
      (client) =>
        client.POST("/api/v1/workflow-tasks/{task_id}/claim", {
          params: { path: { task_id: task.task_id } },
          body: { idempotency_key: idemKey() },
        }),
      ko.eApprovals.toasts.claimed,
    );
  };

  const decide = (
    task: WorkflowTaskSummary,
    decision: "approve" | "reject" | "return",
  ) => {
    const trimmed = comment.trim();
    if ((decision === "reject" || decision === "return") && trimmed.length === 0) {
      emitConsoleToast({ message: ko.eApprovals.toasts.commentRequired });
      return;
    }
    void act(
      (client) =>
        client.POST("/api/v1/workflow-tasks/{task_id}/decide", {
          params: { path: { task_id: task.task_id } },
          body: {
            decision,
            comment: trimmed.length > 0 ? trimmed : undefined,
            idempotency_key: idemKey(),
          },
        }),
      decision === "approve"
        ? ko.eApprovals.toasts.approved
        : decision === "return"
          ? ko.eApprovals.toasts.returned
          : ko.eApprovals.toasts.rejected,
    );
  };

  const finalize = (task: WorkflowTaskSummary, mode: "author" | "delegate") => {
    const trimmed = comment.trim();
    if (mode === "delegate" && trimmed.length === 0) {
      emitConsoleToast({ message: ko.eApprovals.toasts.reasonRequired });
      return;
    }
    void act(
      (client) =>
        client.POST("/api/v1/workflow-tasks/{task_id}/finalize", {
          params: { path: { task_id: task.task_id } },
          body: {
            mode,
            reason: mode === "delegate" ? trimmed : undefined,
            idempotency_key: idemKey(),
          },
        }),
      ko.eApprovals.toasts.finalized,
    );
  };

  const postRejection = () => {
    const trimmed = comment.trim();
    if (trimmed.length === 0) {
      emitConsoleToast({ message: ko.eApprovals.toasts.reasonRequired });
      return;
    }
    void act(
      (client) =>
        client.POST("/api/v1/workflow-runs/{run_id}/post-finalization-rejection", {
          params: { path: { run_id: runId } },
          body: { reason: trimmed, idempotency_key: idemKey() },
        }),
      ko.eApprovals.toasts.postRejected,
    );
  };

  if (state === "loading" && !detail) {
    return (
      <p role="status" className="text-[12px] font-semibold text-console-steel">
        {ko.page.loading}
      </p>
    );
  }
  if (state === "error" || !detail) {
    return (
      <div className="grid gap-2">
        <p role="alert" className="text-[12px] font-semibold text-console-warn-tx">
          {ko.page.loadFailed}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="justify-self-start rounded-[7px] border border-console-border bg-console-surface px-2.5 py-1 text-[12px] font-bold text-console-ink hover:bg-console-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
        >
          {ko.eApprovals.actions.retry}
        </button>
      </div>
    );
  }

  const run = detail.run;
  const iAmInitiator = Boolean(myUserId) && run.initiated_by === myUserId;
  const isTerminal = run.status === "SUCCEEDED";

  return (
    <div className="grid gap-4 text-[12px]">
      <section aria-label={ko.eApprovals.detail.headLabel} className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Chip>
          {iAmInitiator ? (
            <Chip tone="neutral">{ko.eApprovals.detail.mine}</Chip>
          ) : null}
        </div>
        <dl className="grid gap-1">
          <FieldRow label={ko.eApprovals.detail.startedAt} value={formatKoreanDateTime(run.started_at)} />
          <FieldRow label={ko.eApprovals.detail.updatedAt} value={formatKoreanDateTime(run.updated_at)} />
        </dl>
      </section>

      <section aria-label={ko.eApprovals.detail.timelineLabel} className="grid gap-1.5">
        <h3 className="text-[11px] font-extrabold uppercase text-console-faint">
          {ko.eApprovals.detail.timelineLabel}
        </h3>
        {detail.timeline.length === 0 ? (
          <p className="text-console-steel">{ko.eApprovals.detail.timelineEmpty}</p>
        ) : (
          <ol className="grid gap-1.5">
            {detail.timeline.map((step, index) => {
              const decision = decisionLabel(outcomeDecision(step.outcome));
              return (
                <li
                  key={`${step.node_key}-${String(step.attempt)}-${String(index)}`}
                  className="flex flex-wrap items-center gap-2 rounded-[7px] border border-console-border-soft bg-console-canvas px-2 py-1.5"
                >
                  <Chip tone={stepStatusTone(step.status)} className="px-1.5">
                    {step.status}
                  </Chip>
                  <span className="font-mono text-[11px] font-bold text-console-ink">
                    {step.node_key}
                  </span>
                  {decision ? (
                    <span className="text-console-steel">{decision}</span>
                  ) : null}
                  {step.finished_at ? (
                    <span className="ml-auto text-console-faint">
                      {formatKoreanDateTime(step.finished_at)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-label={ko.eApprovals.detail.actionsLabel} className="grid gap-2">
        <h3 className="text-[11px] font-extrabold uppercase text-console-faint">
          {ko.eApprovals.detail.actionsLabel}
        </h3>

        {detail.waiting_tasks.map((task) => {
          const isFinalize = task.required_policy === FINALIZE_POLICY;
          const claimedByMe = task.status === "CLAIMED" && task.claimed_by === myUserId;
          return (
            <div
              key={task.task_id}
              className="grid gap-2 rounded-[7px] border border-console-border bg-console-surface px-2.5 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={taskStatusTone(task.status)} className="px-1.5">
                  {taskStatusLabel(task.status)}
                </Chip>
                <span className="font-mono text-[11px] font-bold text-console-ink">
                  {task.waiting_key}
                </span>
              </div>

              {isFinalize ? (
                iAmInitiator ? (
                  <ActionRow
                    disabled={busy}
                    primaryLabel={ko.eApprovals.actions.finalize}
                    onPrimary={() => {
                      finalize(task, "author");
                    }}
                    primaryTone="ok"
                  />
                ) : (
                  <>
                    <CommentBox
                      value={comment}
                      onChange={setComment}
                      label={ko.eApprovals.detail.reasonLabel}
                    />
                    <ActionRow
                      disabled={busy}
                      primaryLabel={ko.eApprovals.actions.delegateFinalize}
                      onPrimary={() => {
                        finalize(task, "delegate");
                      }}
                      primaryTone="warn"
                    />
                  </>
                )
              ) : iAmInitiator ? null : task.status === "OPEN" ? (
                <ActionRow
                  disabled={busy}
                  primaryLabel={ko.eApprovals.actions.claim}
                  onPrimary={() => {
                    claim(task);
                  }}
                  primaryTone="info"
                />
              ) : claimedByMe ? (
                <>
                  <CommentBox
                    value={comment}
                    onChange={setComment}
                    label={ko.eApprovals.detail.commentLabel}
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <ActionButton
                      disabled={busy}
                      tone="ok"
                      onClick={() => {
                        decide(task, "approve");
                      }}
                    >
                      {ko.eApprovals.decision.approve}
                    </ActionButton>
                    <ActionButton
                      disabled={busy}
                      tone="warn"
                      onClick={() => {
                        decide(task, "return");
                      }}
                    >
                      {ko.eApprovals.decision.return}
                    </ActionButton>
                    <ActionButton
                      disabled={busy}
                      tone="danger"
                      onClick={() => {
                        decide(task, "reject");
                      }}
                    >
                      {ko.eApprovals.decision.reject}
                    </ActionButton>
                  </div>
                </>
              ) : null}
            </div>
          );
        })}

        {isTerminal ? (
          <div className="grid gap-2 rounded-[7px] border border-console-border bg-console-surface px-2.5 py-2">
            <CommentBox
              value={comment}
              onChange={setComment}
              label={ko.eApprovals.detail.reasonLabel}
            />
            <ActionRow
              disabled={busy}
              primaryLabel={ko.eApprovals.actions.postReject}
              onPrimary={postRejection}
              primaryTone="danger"
            />
          </div>
        ) : null}

        {detail.waiting_tasks.length === 0 && !isTerminal ? (
          <p className="text-console-steel">{ko.eApprovals.detail.noActions}</p>
        ) : null}
      </section>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] gap-2">
      <dt className="text-[11px] font-extrabold uppercase text-console-faint">{label}</dt>
      <dd className="min-w-0 break-words text-console-ink">{value}</dd>
    </div>
  );
}

function CommentBox({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-extrabold uppercase text-console-faint">{label}</span>
      <textarea
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        rows={2}
        className="w-full rounded-[7px] border border-console-border bg-console-canvas px-2 py-1.5 text-[12px] text-console-ink placeholder:text-console-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
      />
    </label>
  );
}

const ACTION_TONE: Record<"ok" | "warn" | "danger" | "info", string> = {
  ok: "border-console-ok-bd bg-console-ok-bg text-console-ok-tx",
  warn: "border-console-warn-bd bg-console-warn-bg text-console-warn-tx",
  danger: "border-console-danger-bd bg-console-danger-bg text-console-danger-tx",
  info: "border-console-info-bd bg-console-info-bg text-console-info-tx",
};

function ActionButton({
  tone,
  disabled,
  onClick,
  children,
}: {
  tone: "ok" | "warn" | "danger" | "info";
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "min-h-8 rounded-[7px] border px-2.5 text-[12px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal disabled:opacity-50",
        ACTION_TONE[tone],
      )}
    >
      {children}
    </button>
  );
}

function ActionRow({
  primaryLabel,
  onPrimary,
  primaryTone,
  disabled,
}: {
  primaryLabel: string;
  onPrimary: () => void;
  primaryTone: "ok" | "warn" | "danger" | "info";
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <ActionButton tone={primaryTone} disabled={disabled} onClick={onPrimary}>
        {primaryLabel}
      </ActionButton>
    </div>
  );
}
