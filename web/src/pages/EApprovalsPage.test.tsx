import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AuthSession } from "../context/auth";
import { AuthTestProvider } from "../test/AuthTestProvider";
import { EApprovalsPage } from "./EApprovalsPage";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const OPEN_TASK = "10000000-0000-4000-8000-000000000001";
const RUN_A = "20000000-0000-4000-8000-000000000001";
const MY_RUN = "20000000-0000-4000-8000-0000000000ff";

const session: AuthSession = {
  access_token: "test-token",
  user_id: USER_ID,
  roles: ["ADMIN"],
  branches: [],
};

const inbox = {
  items: [
    {
      task_id: OPEN_TASK,
      run_id: RUN_A,
      waiting_key: "review.hr",
      title: "지출결의 검토",
      assignee_role_key: "hr_reviewer",
      required_policy: "approval_review",
      status: "OPEN",
      form_payload: {},
      due_at: "2026-07-09T18:00:00Z",
    },
  ],
};

const mine = {
  items: [
    {
      run_id: MY_RUN,
      status: "WAITING",
      definition_id: "30000000-0000-4000-8000-000000000001",
      definition_version: 1,
      object_type: "approval_document",
      started_at: "2026-07-09T09:00:00Z",
      updated_at: "2026-07-09T09:30:00Z",
    },
  ],
};

const server = setupServer(
  http.get("*/api/v1/workflow-tasks", () => HttpResponse.json(inbox)),
  http.get("*/api/v1/workflow-runs/mine", () => HttpResponse.json(mine)),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/e-approvals"]}>
      <AuthTestProvider session={session}>
        <EApprovalsPage />
      </AuthTestProvider>
    </MemoryRouter>,
  );
}

describe("EApprovalsPage", () => {
  it("renders my 결재함 inbox with an AP- code and a decide action", async () => {
    renderPage();
    expect(await screen.findByText("지출결의 검토")).toBeVisible();
    expect(screen.getByText("AP-20000000")).toBeVisible();
    // One primary action per row that opens the detail (decision) panel.
    expect(
      screen.getByRole("button", { name: /지출결의 검토 결재/ }),
    ).toBeVisible();
  });

  it("switches to 상신함 and lists runs I initiated", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("지출결의 검토");
    await user.click(screen.getByRole("tab", { name: /상신함/ }));
    expect(await screen.findByText("approval_document")).toBeVisible();
  });

  it("shows the empty inbox state when there are no waiting tasks", async () => {
    server.use(
      http.get("*/api/v1/workflow-tasks", () => HttpResponse.json({ items: [] })),
    );
    renderPage();
    expect(await screen.findByText("결재할 항목이 없습니다.")).toBeVisible();
  });
});
