// UI-M4 전자결재 — pure aggregation/formatting over the workflow-engine run/task
// surfaces. No network here so the row/label/tone logic is unit-testable.
//
// 결재함 (inbox) = my waiting tasks (/api/v1/workflow-tasks?assignee=me);
// 상신함 (my requests) = runs I initiated (/api/v1/workflow-runs/mine).
// A run/task carries no issued code from the engine — the design's AP- object
// code is derived from the run id for display (the real route key stays the
// full uuid, via objectRegistry.approval.route).

import type {
  WorkflowRunListItem,
  WorkflowTaskSummary,
} from "../../api/types";
import type { Tone } from "../../components/console/primitives";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { safeLabel } from "../../lib/utils";

/** The `required_policy` a finalize (종결) human task carries. Author finalize is
 * owner-checked; delegate finalize is policy-gated (backend guard_policy). */
export const FINALIZE_POLICY = "approval_finalize";

/** Design AP- object code for a run, derived from its uuid (the engine issues no
 * code). Display only — routing/pinning always uses the full run id. */
export function apCode(runId: string): string {
  const head = runId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `AP-${head}`;
}

/** Chip tone for a run status (RunStatus). */
export function runStatusTone(status: string): Tone {
  switch (status) {
    case "SUCCEEDED":
      return "ok";
    case "WAITING":
      return "warn";
    case "FAILED":
    case "DEAD_LETTERED":
      return "danger";
    case "CANCELLED":
      return "neutral";
    default:
      return "info";
  }
}

/** Chip tone for a waiting-task status (WaitingTaskStatus). */
export function taskStatusTone(status: string): Tone {
  switch (status) {
    case "APPROVED":
      return "ok";
    case "OPEN":
      return "warn";
    case "CLAIMED":
      return "info";
    case "REJECTED":
      return "danger";
    default:
      return "neutral";
  }
}

/** Chip tone for a node-step status in the run timeline. */
export function stepStatusTone(status: string): Tone {
  if (status.includes("SUCC") || status === "APPROVED") return "ok";
  if (status.includes("FAIL") || status === "REJECTED") return "danger";
  if (status.includes("WAIT") || status === "OPEN") return "warn";
  if (status === "RUNNING" || status === "CLAIMED") return "info";
  return "neutral";
}

function labelFor(
  map: Record<string, string> | undefined,
  status: string,
): string {
  return map?.[status] ?? status;
}

export function runStatusLabel(status: string): string {
  return labelFor(ko.eApprovals.runStatus, status);
}

export function taskStatusLabel(status: string): string {
  return labelFor(ko.eApprovals.taskStatus, status);
}

/** A 결재함 row's one primary action opens (pins) the run detail panel — the
 * single decision surface where claim / 승인·반려·거부 / 종결 happen (반려·거부
 * need a comment, so no decision is a bare row button). Design: 상세 보기의
 * 기본은 핀 패널 (DESIGN.md §4.7). */
export type InboxAction = { type: "open"; runId: string };

export interface InboxRow {
  id: string;
  taskId: string;
  runId: string;
  code: string;
  title: string;
  status: string;
  statusTone: Tone;
  /** A finalize (종결) task vs. a decide (검토/승인) task. */
  isFinalize: boolean;
  detail: string;
  dueLabel?: string;
  dueTime: number;
  actionLabel: string;
  action: InboxAction;
}

export interface RequestRow {
  id: string;
  runId: string;
  code: string;
  title: string;
  status: string;
  statusTone: Tone;
  detail: string;
  startedTime: number;
}

function dueTimeOf(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function startedTimeOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : 0;
}

/** 결재함: my actionable waiting tasks. Mirrors the overview inbox filter — an
 * OPEN task (claimable) or one I already hold (CLAIMED by me). Deadline-first. */
export function buildInboxRows(
  tasks: WorkflowTaskSummary[],
  myUserId: string | undefined,
): InboxRow[] {
  return tasks
    .filter(
      (task) =>
        task.status === "OPEN" ||
        (task.status === "CLAIMED" && task.claimed_by === myUserId),
    )
    .map((task) => {
      const isFinalize = task.required_policy === FINALIZE_POLICY;
      const claimedByMe = task.status === "CLAIMED";
      const action: InboxAction = { type: "open", runId: task.run_id };
      const actionLabel = isFinalize
        ? ko.eApprovals.actions.finalize
        : ko.eApprovals.actions.decide;
      return {
        id: `task-${task.task_id}`,
        taskId: task.task_id,
        runId: task.run_id,
        code: apCode(task.run_id),
        title: safeLabel(task.title),
        status: task.status,
        statusTone: taskStatusTone(task.status),
        isFinalize,
        detail: isFinalize
          ? ko.eApprovals.rows.finalizeWaiting
          : claimedByMe
            ? ko.eApprovals.rows.claimedByMe
            : ko.eApprovals.rows.openTask,
        dueLabel: task.due_at
          ? ko.eApprovals.rows.due.replace(
              "{time}",
              formatKoreanDateTime(task.due_at),
            )
          : undefined,
        dueTime: dueTimeOf(task.due_at),
        actionLabel,
        action,
      };
    })
    .sort((a, b) => a.dueTime - b.dueTime);
}

/** 상신함: runs I initiated, newest first. */
export function buildRequestRows(runs: WorkflowRunListItem[]): RequestRow[] {
  return runs
    .map((run) => ({
      id: `run-${run.run_id}`,
      runId: run.run_id,
      code: apCode(run.run_id),
      title: run.object_type
        ? safeLabel(run.object_type)
        : ko.eApprovals.rows.untitledRequest,
      status: run.status,
      statusTone: runStatusTone(run.status),
      detail: ko.eApprovals.rows.submittedAt.replace(
        "{time}",
        formatKoreanDateTime(run.started_at),
      ),
      startedTime: startedTimeOf(run.started_at),
    }))
    .sort((a, b) => b.startedTime - a.startedTime);
}
