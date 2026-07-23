import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ApprovalBulkInbox } from "./ApprovalBulkInbox";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const TASK_ONE = "20000000-0000-4000-8000-000000000001";
const TASK_TWO = "20000000-0000-4000-8000-000000000002";
const TASK_THREE = "20000000-0000-4000-8000-000000000003";

const server = setupServer();

beforeAll(() => { server.listen({ onUnhandledRequest: "error" }); });
afterEach(() => { server.resetHandlers(); window.localStorage.clear(); });
afterAll(() => { server.close(); });

function task(overrides: Record<string, unknown> = {}) {
  return {
    task_id: TASK_ONE,
    run_id: "30000000-0000-4000-8000-000000000001",
    waiting_key: "approve.manager",
    title: "Equipment replacement approval",
    assignee_role_key: "manager_approver",
    required_policy: "approval_decide",
    status: "OPEN",
    form_payload: {},
    bulk_decision: { decidable: true },
    ...overrides,
  };
}

function installList(items = [task()]) {
  server.use(
    http.get("*/api/v1/approval-inbox/bulk-tasks", ({ request }) => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      const nextOffset = offset + limit;
      return HttpResponse.json({ items: items.slice(offset, nextOffset), has_more: nextOffset < items.length, next_cursor: nextOffset < items.length ? String(nextOffset) : undefined });
    }),
  );
}

describe("ApprovalBulkInbox", () => {
  it("keeps server-guarded rows individually reviewable and never invents an amount", async () => {
    const user = userEvent.setup();
    installList([
      task(),
      task({
        task_id: TASK_TWO,
        title: "Author receipt",
        bulk_decision: { decidable: false, reason: "NOT_APPROVAL_DECISION_TASK" },
      }),
      task({
        task_id: "20000000-0000-4000-8000-000000000003",
        title: "Legacy task",
        bulk_decision: { decidable: false, reason: "SERVER_CAPABILITY_UNAVAILABLE" },
      }),
      task({
        task_id: "20000000-0000-4000-8000-000000000004",
        title: "Claimed task",
        status: "CLAIMED",
        claimed_by: "10000000-0000-4000-8000-000000000099",
        bulk_decision: { decidable: false, reason: "CLAIMED_BY_ANOTHER_USER" },
      }),
    ]);

    render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    const selectable = await screen.findByRole("checkbox", {
      name: "Equipment replacement approval",
    });
    await user.click(selectable);

    expect(screen.getByText("1 selected")).toBeVisible();
    expect(screen.getAllByText("NOT_APPROVAL_DECISION_TASK")).toHaveLength(1);
    expect(
      screen.getByText(
        "SERVER_CAPABILITY_UNAVAILABLE",
      ),
    ).toBeVisible();
    expect(screen.getByText("CLAIMED_BY_ANOTHER_USER")).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Author receipt" }),
    ).toBeDisabled();
  });

  it("records partial results and retries an unconfirmed task with the same idempotency key", async () => {
    const user = userEvent.setup();
    const decisions: Array<{
      taskId: string;
      body: { idempotency_key: string };
    }> = [];
    let secondAttempts = 0;
    installList([
      task(),
      task({
        task_id: TASK_TWO,
        run_id: "30000000-0000-4000-8000-000000000002",
        title: "Payroll approval",
      }),
      task({
        task_id: TASK_THREE,
        run_id: "30000000-0000-4000-8000-000000000003",
        title: "Vendor approval",
      }),
    ]);
    server.use(
      http.post(
        "*/api/v1/workflow-tasks/:taskId/decide",
        async ({ params, request }) => {
          const body = (await request.json()) as { idempotency_key: string };
          const taskId = String(params.taskId);
          decisions.push({ taskId, body });
          if (taskId === TASK_TWO && secondAttempts++ === 0)
            return HttpResponse.json(
              { message: "stale task" },
              { status: 409 },
            );
          return HttpResponse.json({
            task: {
              task_id: taskId,
              run_id: "30000000-0000-4000-8000-000000000001",
              status: "APPROVED",
              decision_payload: {},
            },
            run: {
              id: "30000000-0000-4000-8000-000000000001",
              status: "SUCCEEDED",
            },
          });
        },
      ),
    );

    render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    await user.click(
      await screen.findByRole("checkbox", {
        name: "Equipment replacement approval",
      }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Payroll approval" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Approve selected (2)" }),
    );

    expect(
      (await screen.findAllByText("Approved · APPROVED · SUCCEEDED"))[0],
    ).toBeVisible();
    expect((await screen.findAllByText("stale task"))[0]).toBeVisible();
    // A new operation is allowed while the failed task remains unresolved, but
    // it must not replace that task's original idempotency identity.
    await user.click(screen.getByRole("checkbox", { name: "Vendor approval" }));
    await user.click(screen.getByRole("button", { name: "Approve selected (1)" }));
    await waitFor(() => { expect(decisions).toHaveLength(3); });
    await user.click(screen.getByRole("button", { name: "Retry unresolved (1)" }));

    await waitFor(() => { expect(decisions).toHaveLength(4); });
    expect(decisions.map((entry) => entry.taskId)).toEqual([
      TASK_ONE,
      TASK_TWO,
      TASK_THREE,
      TASK_TWO,
    ]);
    expect(decisions[1]?.body.idempotency_key).toBe(
      decisions[3]?.body.idempotency_key,
    );
  });

  it("keeps a server-side SoD denial as a per-item failure rather than reporting bulk success", async () => {
    const user = userEvent.setup();
    installList();
    server.use(
      http.post("*/api/v1/workflow-tasks/:taskId/decide", () =>
        HttpResponse.json(
          { message: "self approval prohibited" },
          { status: 403 },
        ),
      ),
    );

    render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    await user.click(
      await screen.findByRole("checkbox", {
        name: "Equipment replacement approval",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Approve selected (1)" }),
    );

    expect((await screen.findAllByText("self approval prohibited"))[0]).toBeVisible();
    expect(screen.queryByText(/Approved ·/)).not.toBeInTheDocument();
  });

  it("preserves selection across client pages and supports keyboard selection", async () => {
    const user = userEvent.setup();
    installList(
      Array.from({ length: 51 }, (_, index) =>
        task({
          task_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          title: `Approval task ${String(index + 1)}`,
        }),
      ),
    );

    render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    const first = await screen.findByRole("checkbox", {
      name: "Approval task 1",
    });
    first.focus();
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Approval task 51" }),
    );
    expect(screen.getByText("2 selected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(
      screen.getByRole("checkbox", { name: "Approval task 1" }),
    ).toBeChecked();
  });

  it("does not update after an inbox request is unmounted", async () => {
    let resolveRequest: ((value: Response) => void) | undefined;
    server.use(
      http.get(
        "*/api/v1/approval-inbox/bulk-tasks",
        () =>
          new Promise<Response>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    );
    const view = render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    view.unmount();
    resolveRequest?.(HttpResponse.json({ items: [task()], has_more: false }));
    await Promise.resolve();
    expect(
      screen.queryByText("Equipment replacement approval"),
    ).not.toBeInTheDocument();
  });

  it("persists a cancelled operation per user and retries it with the original key after reload", async () => {
    const user = userEvent.setup();
    let started: (() => void) | undefined;
    const keys: string[] = [];
    installList();
    server.use(
      http.post(
        "*/api/v1/workflow-tasks/:taskId/decide",
        async ({ request }) => {
          const body = (await request.json()) as { idempotency_key: string };
          keys.push(body.idempotency_key);
          if (keys.length === 1) {
            return new Promise<Response>((resolve) => {
              started = () => { resolve(HttpResponse.json({})); };
            });
          }
          return HttpResponse.json({
            task: { task_id: TASK_ONE, status: "APPROVED" },
            run: { id: "30000000-0000-4000-8000-000000000001", status: "SUCCEEDED" },
          });
        },
      ),
    );

    const firstView = render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    await user.click(
      await screen.findByRole("checkbox", {
        name: "Equipment replacement approval",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Approve selected (1)" }),
    );
    await waitFor(() => { expect(started).toBeTypeOf("function"); });
    await user.click(screen.getByRole("button", { name: "Cancel remaining" }));

    expect(
      screen.getByText(
        "Cancelled. The in-flight result is unconfirmed until retried.",
      ),
    ).toBeVisible();
    expect(
      screen.getAllByText(
        "No confirmed result after cancellation. Retry uses the same idempotency key.",
      )[0],
    ).toBeVisible();
    await waitFor(() => { expect(window.localStorage.getItem(`maintenance.approval-bulk.operations.v1.${USER_ID}`)).toContain(keys[0]); });

    firstView.unmount();
    render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    await screen.findByRole("button", { name: "Retry unresolved (1)" });
    await user.click(screen.getByRole("button", { name: "Retry unresolved (1)" }));
    await waitFor(() => { expect(keys).toHaveLength(2); });
    expect(keys[1]).toBe(keys[0]);

    const otherUserId = "10000000-0000-4000-8000-000000000099";
    render(<ApprovalBulkInbox currentUserId={otherUserId} />);
    await screen.findAllByRole("checkbox", { name: "Equipment replacement approval" });
    expect(screen.queryByRole("button", { name: "Retry unresolved (1)" })).not.toBeInTheDocument();
    started?.();
  });
});
