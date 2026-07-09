import { describe, expect, it } from "vitest";

import type {
  WorkflowRunListItem,
  WorkflowTaskSummary,
} from "../../api/types";
import {
  apCode,
  buildInboxRows,
  buildRequestRows,
  runStatusTone,
  taskStatusTone,
} from "./approvals-data";

const ME = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const RUN = "20000000-0000-4000-8000-000000000001";

function task(overrides: Partial<WorkflowTaskSummary>): WorkflowTaskSummary {
  return {
    task_id: "10000000-0000-4000-8000-000000000001",
    run_id: RUN,
    waiting_key: "review.hr",
    title: "지출결의 검토",
    required_policy: "approval_review",
    status: "OPEN",
    form_payload: {},
    ...overrides,
  };
}

function run(overrides: Partial<WorkflowRunListItem>): WorkflowRunListItem {
  return {
    run_id: RUN,
    status: "WAITING",
    definition_id: "30000000-0000-4000-8000-000000000001",
    definition_version: 1,
    started_at: "2026-07-09T09:00:00Z",
    updated_at: "2026-07-09T09:00:00Z",
    ...overrides,
  };
}

describe("apCode", () => {
  it("derives a stable AP- display code from the run uuid", () => {
    expect(apCode(RUN)).toBe("AP-20000000");
  });
});

describe("buildInboxRows", () => {
  it("opens the detail panel for an OPEN decide task (claim happens in the panel)", () => {
    const [row] = buildInboxRows([task({ status: "OPEN" })], ME);
    expect(row.action).toEqual({ type: "open", runId: RUN });
    expect(row.isFinalize).toBe(false);
  });

  it("opens the detail for a task I already hold", () => {
    const [row] = buildInboxRows(
      [task({ status: "CLAIMED", claimed_by: ME })],
      ME,
    );
    expect(row.action).toEqual({ type: "open", runId: RUN });
  });

  it("hides tasks claimed by someone else", () => {
    const rows = buildInboxRows(
      [task({ status: "CLAIMED", claimed_by: OTHER })],
      ME,
    );
    expect(rows).toHaveLength(0);
  });

  it("marks a finalize task and opens the detail to finalize", () => {
    const [row] = buildInboxRows(
      [task({ required_policy: "approval_finalize", waiting_key: "finalize.author" })],
      ME,
    );
    expect(row.isFinalize).toBe(true);
    expect(row.action).toEqual({ type: "open", runId: RUN });
  });

  it("orders by nearest deadline first", () => {
    const rows = buildInboxRows(
      [
        task({ task_id: "a", due_at: "2026-07-10T00:00:00Z" }),
        task({ task_id: "b", due_at: "2026-07-09T00:00:00Z" }),
      ],
      ME,
    );
    expect(rows.map((r) => r.taskId)).toEqual(["b", "a"]);
  });
});

describe("buildRequestRows", () => {
  it("orders my runs newest-first and derives the AP- code", () => {
    const rows = buildRequestRows([
      run({ run_id: RUN, started_at: "2026-07-09T09:00:00Z" }),
      run({
        run_id: "20000000-0000-4000-8000-000000000002",
        started_at: "2026-07-09T10:00:00Z",
      }),
    ]);
    expect(rows[0].runId).toBe("20000000-0000-4000-8000-000000000002");
    expect(rows[1].code).toBe("AP-20000000");
  });
});

describe("status tones", () => {
  it("maps a succeeded run to ok and a failed run to danger", () => {
    expect(runStatusTone("SUCCEEDED")).toBe("ok");
    expect(runStatusTone("DEAD_LETTERED")).toBe("danger");
  });

  it("maps task statuses to tones", () => {
    expect(taskStatusTone("OPEN")).toBe("warn");
    expect(taskStatusTone("APPROVED")).toBe("ok");
    expect(taskStatusTone("REJECTED")).toBe("danger");
  });
});
