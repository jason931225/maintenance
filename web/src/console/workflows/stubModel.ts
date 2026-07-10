import { ko } from "../../i18n/ko";
import type { WorkflowAutoModel } from "./types";

const T = ko.console.workflows;

export function createWorkflowAutoStubModel(): WorkflowAutoModel {
  return {
    workflows: [
      {
        id: "wf-attendance-exception",
        name: T.samples.workflow.name,
        active: true,
        version: 3,
        runs: 42,
        lastRun: T.samples.workflow.lastRun,
        lastResult: "ok",
        blocks: [
          {
            id: "wf-attendance-trigger",
            kind: "trigger",
            title: T.samples.blocks.trigger.title,
            detail: T.samples.blocks.trigger.detail,
            chips: [T.samples.blocks.trigger.chip],
          },
          {
            id: "wf-attendance-condition",
            kind: "condition",
            title: T.samples.blocks.condition.title,
            detail: T.samples.blocks.condition.detail,
            chips: [T.samples.blocks.condition.chip],
          },
          {
            id: "wf-attendance-branch",
            kind: "branch",
            title: T.samples.blocks.branch.title,
            detail: T.samples.blocks.branch.detail,
            chips: [T.samples.blocks.branch.chip],
          },
          {
            id: "wf-attendance-action",
            kind: "action",
            title: T.samples.blocks.action.title,
            detail: T.samples.blocks.action.detail,
            chips: [T.samples.blocks.action.chip],
          },
        ],
        runLog: [
          {
            id: "run-attendance-latest",
            at: T.samples.runLog.at,
            actor: T.samples.runLog.actor,
            status: "succeeded",
            label: T.samples.runLog.label,
            generatedObjects: ["AP-184"],
          },
        ],
        pendingRevision: {
          version: 4,
          stagedBy: T.samples.publish.stagedBy,
          status: "pending_review",
        },
      },
    ],
    schedules: [
      {
        id: "sch-attendance-close",
        name: T.samples.schedule.name,
        active: true,
        cron: "0 17 * * *",
        cronLabel: T.samples.schedule.cronLabel,
        nextRun: T.samples.schedule.nextRun,
        lastRun: T.samples.schedule.lastRun,
        lastResult: "warn",
        runLog: [
          {
            id: "run-schedule-latest",
            at: T.samples.scheduleRun.at,
            actor: T.samples.scheduleRun.actor,
            status: "running",
            label: T.samples.scheduleRun.label,
          },
        ],
      },
    ],
  };
}
