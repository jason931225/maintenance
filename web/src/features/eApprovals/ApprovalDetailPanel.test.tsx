import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import type { AuthSession } from "../../context/auth";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { ApprovalDetailPanel } from "./ApprovalDetailPanel";

const ME = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const RUN = "20000000-0000-4000-8000-000000000001";
const TASK = "10000000-0000-4000-8000-000000000001";

const session: AuthSession = {
  access_token: "test-token",
  user_id: ME,
  roles: ["ADMIN"],
  branches: [],
};

const decideRequests: { taskId: string; body: unknown }[] = [];
const claimRequests: string[] = [];

function detail(initiatedBy: string, taskStatus = "CLAIMED") {
  return {
    run: {
      id: RUN,
      status: "WAITING",
      definition_id: "30000000-0000-4000-8000-000000000001",
      definition_version: 1,
      trigger_type: "MANUAL",
      initiated_by: initiatedBy,
      started_at: "2026-07-09T09:00:00Z",
      updated_at: "2026-07-09T09:30:00Z",
    },
    waiting_tasks: [
      {
        task_id: TASK,
        run_id: RUN,
        waiting_key: "review.hr",
        title: "지출결의 검토",
        assignee_role_key: "hr_reviewer",
        required_policy: "approval_review",
        status: taskStatus,
        claimed_by: taskStatus === "CLAIMED" ? ME : undefined,
        form_payload: {},
      },
    ],
    timeline: [
      {
        node_key: "submit",
        node_type: "object_gate",
        status: "SUCCEEDED",
        attempt: 1,
        finished_at: "2026-07-09T09:00:00Z",
      },
    ],
  };
}

const server = setupServer(
  http.post("*/api/v1/workflow-tasks/:taskId/decide", async ({ request, params }) => {
    decideRequests.push({ taskId: String(params.taskId), body: await request.json() });
    return HttpResponse.json({
      task: { task_id: TASK, run_id: RUN, status: "APPROVED", decision_payload: {} },
      run: { id: RUN, status: "WAITING" },
    });
  }),
  http.post("*/api/v1/workflow-tasks/:taskId/claim", ({ params }) => {
    claimRequests.push(String(params.taskId));
    return HttpResponse.json({
      task: { task_id: TASK, run_id: RUN, status: "CLAIMED", claimed_by: ME },
    });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  decideRequests.length = 0;
  claimRequests.length = 0;
});
afterAll(() => {
  server.close();
});

function renderPanel() {
  return render(
    <AuthTestProvider session={session}>
      <ApprovalDetailPanel runId={RUN} />
    </AuthTestProvider>,
  );
}

describe("ApprovalDetailPanel", () => {
  it("renders the node-step timeline and, for a task I hold, the decision actions", async () => {
    server.use(
      http.get("*/api/v1/workflow-runs/:runId", () =>
        HttpResponse.json(detail(OTHER)),
      ),
    );
    renderPanel();
    expect(await screen.findByText("submit")).toBeVisible();
    expect(screen.getByRole("button", { name: "승인" })).toBeVisible();
    expect(screen.getByRole("button", { name: "반려" })).toBeVisible();
    expect(screen.getByRole("button", { name: "거부" })).toBeVisible();
  });

  it("SoD: hides 승인 on a run I initiated (deny-by-omission)", async () => {
    server.use(
      http.get("*/api/v1/workflow-runs/:runId", () =>
        HttpResponse.json(detail(ME)),
      ),
    );
    renderPanel();
    // The run head renders (my request), but no approve control is offered.
    expect(await screen.findByText("submit")).toBeVisible();
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
  });

  it("claims an OPEN task from the panel before deciding", async () => {
    server.use(
      http.get("*/api/v1/workflow-runs/:runId", () =>
        HttpResponse.json(detail(OTHER, "OPEN")),
      ),
    );
    const user = userEvent.setup();
    renderPanel();
    const claimBtn = await screen.findByRole("button", { name: "담당" });
    await user.click(claimBtn);
    await waitFor(() => {
      expect(claimRequests).toEqual([TASK]);
    });
  });

  it("decides via the real engine endpoint", async () => {
    server.use(
      http.get("*/api/v1/workflow-runs/:runId", () =>
        HttpResponse.json(detail(OTHER)),
      ),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "승인" }));
    await waitFor(() => {
      expect(decideRequests).toHaveLength(1);
    });
    expect(decideRequests[0]).toMatchObject({
      taskId: TASK,
      body: { decision: "approve" },
    });
  });
});
