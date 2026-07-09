import { describe, expect, it } from "vitest";

import type {
  AttendanceSummaryItem,
  MyDispatchOffer,
  SupportTicketSummary,
  WorkflowTaskSummary,
} from "../../api/types";
import {
  buildApprovalItems,
  buildAttendanceItems,
  buildDispatchItems,
  buildSupportItems,
  countsByKind,
  filterByKind,
  sortInboxItems,
} from "./overview-data";

const ME = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

function task(overrides: Partial<WorkflowTaskSummary>): WorkflowTaskSummary {
  return {
    task_id: "10000000-0000-4000-8000-000000000001",
    run_id: "20000000-0000-4000-8000-000000000001",
    waiting_key: "approval.review",
    title: "정비 완료 승인",
    status: "OPEN",
    form_payload: {},
    ...overrides,
  };
}

function offer(overrides: Partial<MyDispatchOffer>): MyDispatchOffer {
  return {
    dispatch_id: "30000000-0000-4000-8000-000000000001",
    work_order_id: "40000000-0000-4000-8000-000000000001",
    branch_id: "50000000-0000-4000-8000-000000000001",
    request_no: "20260709-001",
    accept_window_started_at: "2026-07-09T09:00:00Z",
    accept_window_ends_at: "2026-07-09T09:03:00Z",
    ...overrides,
  };
}

function ticket(overrides: Partial<SupportTicketSummary>): SupportTicketSummary {
  return {
    id: "60000000-0000-4000-8000-000000000001",
    branch_id: "50000000-0000-4000-8000-000000000001",
    origin: "INTERNAL",
    category: "OPERATIONAL",
    priority: "MEDIUM",
    status: "IN_PROGRESS",
    title: "지게차 배터리 교체 요청",
    requester_user_id: OTHER,
    requester_name: "요청자",
    assignee_user_id: ME,
    assignee_name: "담당자",
    due_at: null,
    created_at: "2026-07-09T08:00:00Z",
    updated_at: "2026-07-09T08:00:00Z",
    resolved_at: null,
    closed_at: null,
    ...overrides,
  };
}

function attendance(
  overrides: Partial<AttendanceSummaryItem>,
): AttendanceSummaryItem {
  return {
    user_id: "70000000-0000-4000-8000-000000000001",
    display_name: "김정비",
    arrivals: 5,
    departures: 4,
    last_kind: "CLOCK_IN",
    last_event_at: "2026-07-08T09:00:00Z",
    ...overrides,
  };
}

describe("overview-data builders", () => {
  it("maps OPEN tasks to claim and my CLAIMED tasks to approve, dropping others' claims", () => {
    const items = buildApprovalItems(
      [
        task({ status: "OPEN" }),
        task({
          task_id: "10000000-0000-4000-8000-000000000002",
          status: "CLAIMED",
          claimed_by: ME,
        }),
        task({
          task_id: "10000000-0000-4000-8000-000000000003",
          status: "CLAIMED",
          claimed_by: OTHER,
        }),
      ],
      ME,
    );
    expect(items).toHaveLength(2);
    expect(items[0].action).toEqual({
      type: "claim",
      taskId: "10000000-0000-4000-8000-000000000001",
    });
    expect(items[1].action).toEqual({
      type: "approve",
      taskId: "10000000-0000-4000-8000-000000000002",
    });
  });

  it("maps dispatch offers to acceptDispatch with the accept-window deadline", () => {
    const items = buildDispatchItems([offer({})]);
    expect(items).toHaveLength(1);
    expect(items[0].action).toEqual({
      type: "acceptDispatch",
      dispatchId: "30000000-0000-4000-8000-000000000001",
    });
    expect(items[0].dueTime).toBe(new Date("2026-07-09T09:03:00Z").getTime());
    expect(items[0].href).toBe(
      "/work-orders/40000000-0000-4000-8000-000000000001",
    );
  });

  it("maps support tickets to their legal primary transition and skips terminal ones", () => {
    const items = buildSupportItems([
      ticket({ status: "OPEN", id: "60000000-0000-4000-8000-000000000001" }),
      ticket({
        status: "IN_PROGRESS",
        id: "60000000-0000-4000-8000-000000000002",
      }),
      ticket({ status: "ON_HOLD", id: "60000000-0000-4000-8000-000000000003" }),
      ticket({ status: "CLOSED", id: "60000000-0000-4000-8000-000000000004" }),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0].action).toMatchObject({ toStatus: "IN_PROGRESS" });
    // Resolving carries the undo transition (RESOLVED → IN_PROGRESS reopen).
    expect(items[1].action).toMatchObject({
      toStatus: "RESOLVED",
      undoStatus: "IN_PROGRESS",
    });
    expect(items[2].action).toMatchObject({
      toStatus: "IN_PROGRESS",
      undoStatus: undefined,
    });
  });

  it("flags only unbalanced attendance summaries as exceptions", () => {
    const items = buildAttendanceItems([
      attendance({}),
      attendance({
        user_id: "70000000-0000-4000-8000-000000000002",
        arrivals: 3,
        departures: 3,
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].action).toEqual({ type: "open", href: "/employees" });
  });

  it("sorts nearest deadline first with no-deadline items last, and counts/filters by kind", () => {
    const items = sortInboxItems([
      ...buildSupportItems([ticket({ due_at: null })]),
      ...buildDispatchItems([offer({})]),
      ...buildApprovalItems([task({ due_at: "2026-07-09T18:00:00Z" })], ME),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "dispatch",
      "approval",
      "support",
    ]);

    const counts = countsByKind(items);
    expect(counts).toEqual({
      approval: 1,
      dispatch: 1,
      support: 1,
      attendance: 0,
    });
    expect(filterByKind(items, "support")).toHaveLength(1);
    expect(filterByKind(items, "all")).toHaveLength(3);
  });
});
