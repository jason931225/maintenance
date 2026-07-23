import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ApprovalBulkInbox } from "./ApprovalBulkInbox";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const TASK_ONE = "20000000-0000-4000-8000-000000000001";
const TASK_TWO = "20000000-0000-4000-8000-000000000002";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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
    ...overrides,
  };
}

function installList(items = [task()]) {
  server.use(
    http.get("*/api/v1/workflow-tasks", ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("assignee")).toBe("me");
      expect(url.searchParams.get("status")).toBe("OPEN,CLAIMED");
      return HttpResponse.json({ items });
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
        waiting_key: "receipt.target",
      }),
      task({
        task_id: "20000000-0000-4000-8000-000000000003",
        title: "Legacy task",
        required_policy: undefined,
      }),
      task({
        task_id: "20000000-0000-4000-8000-000000000004",
        title: "Claimed task",
        status: "CLAIMED",
        claimed_by: "10000000-0000-4000-8000-000000000099",
      }),
    ]);

    render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    const selectable = await screen.findByRole("checkbox", {
      name: "Equipment replacement approval",
    });
    await user.click(selectable);

    expect(screen.getByText("1 selected")).toBeVisible();
    expect(
      screen.getByText(
        "Amount unavailable: this inbox does not expose an authoritative amount field.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "This is a finalization or receipt task and must remain individually reviewable.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "This task has no server policy boundary and cannot be bulk decided.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("This task is claimed by another user."),
    ).toBeVisible();
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
      await screen.findByText("Approved · APPROVED · SUCCEEDED"),
    ).toBeVisible();
    expect(await screen.findByText("stale task")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Retry unresolved (1)" }),
    );

    await waitFor(() => expect(decisions).toHaveLength(3));
    expect(decisions.map((entry) => entry.taskId)).toEqual([
      TASK_ONE,
      TASK_TWO,
      TASK_TWO,
    ]);
    expect(decisions[1]?.body.idempotency_key).toBe(
      decisions[2]?.body.idempotency_key,
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

    expect(await screen.findByText("self approval prohibited")).toBeVisible();
    expect(screen.queryByText(/Approved ·/)).not.toBeInTheDocument();
  });

  it("preserves selection across client pages and supports keyboard selection", async () => {
    const user = userEvent.setup();
    installList(
      Array.from({ length: 11 }, (_, index) =>
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
      screen.getByRole("checkbox", { name: "Approval task 11" }),
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
        "*/api/v1/workflow-tasks",
        () =>
          new Promise<Response>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    );
    const view = render(<ApprovalBulkInbox currentUserId={USER_ID} />);
    view.unmount();
    resolveRequest?.(HttpResponse.json({ items: [task()] }));
    await Promise.resolve();
    expect(
      screen.queryByText("Equipment replacement approval"),
    ).not.toBeInTheDocument();
  });

  it("cancels remaining decisions and marks the in-flight task unconfirmed", async () => {
    const user = userEvent.setup();
    let started: (() => void) | undefined;
    installList();
    server.use(
      http.post(
        "*/api/v1/workflow-tasks/:taskId/decide",
        () =>
          new Promise<Response>((resolve) => {
            started = () => resolve(HttpResponse.json({}));
          }),
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
    await waitFor(() => expect(started).toBeTypeOf("function"));
    await user.click(screen.getByRole("button", { name: "Cancel remaining" }));

    expect(
      screen.getByText(
        "Cancelled. The in-flight result is unconfirmed until retried.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "No confirmed result after cancellation. Retry uses the same idempotency key.",
      ),
    ).toBeVisible();
    started?.();
  });
});
