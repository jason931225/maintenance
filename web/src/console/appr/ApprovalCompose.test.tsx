import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PolicyGateProvider } from "../policy";
import { ApprovalCompletionPanel, ApprovalCompose, ApprovalDecisionPanel } from "./ApprovalCompose";

const TOKEN = "appr-token";
const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const allowAll = { can: () => true };

function submittableDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: DEFINITION_ID,
    display_name: "휴가 기안",
    workflow_key: "leave.adjustment",
    active_version: 7,
    object_type: "approval_run",
    definition: {
      reason_options: ["연차", "출장"],
      required_target_kinds: ["work_order"],
      attachment_policy: "none",
    },
    approval_line: [
      { node_id: "author", label: "기안", actor_id: "author-1", actor_label: "김기안", state: "approved" },
      { node_id: "lead", label: "팀장", actor_id: "approver-1", actor_label: "박승인", state: "current" },
    ],
    ...overrides,
  };
}

function renderCompose(onSubmitted = vi.fn()) {
  return render(
    <PolicyGateProvider gate={allowAll}>
      <ApprovalCompose bearerToken={TOKEN} currentUserId="author-1" onSubmitted={onSubmitted} />
    </PolicyGateProvider>,
  );
}

describe("ApprovalCompose", () => {
  it("loads the submittable-definition catalog and submits through workflow-runs before object-link persistence", async () => {
    const user = userEvent.setup();
    const submitted = vi.fn();
    const startBodies: unknown[] = [];
    const linkBodies: unknown[] = [];

    server.use(
      http.get("*/api/v1/workflow-studio/submittable-definitions", ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        return HttpResponse.json({ items: [submittableDefinition()] });
      }),
      http.get("*/api/v1/search", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe("WO-2643");
        return HttpResponse.json({
          results: [{ kind: "work_order", id: TARGET_ID, code: "WO-2643", title: "유압 호스", status: "OPEN", exists: true }],
        });
      }),
      http.post("*/api/v1/workflow-runs", async ({ request }) => {
        startBodies.push(await request.json());
        return HttpResponse.json({
          run: {
            id: RUN_ID,
            status: "WAITING",
            definition_id: DEFINITION_ID,
            definition_version: 7,
            object_type: "work_order",
            object_id: TARGET_ID,
            initiated_by: "author-1",
            started_at: "2026-07-09T10:00:00Z",
          },
        });
      }),
      http.get("*/api/objects/approval_run/:id", () =>
        HttpResponse.json({ kind: "approval_run", id: RUN_ID, code: "AP-3122", title: "휴가 조정 요청", status: "WAITING", exists: true }),
      ),
      http.post("*/api/v1/object-links", async ({ request }) => {
        linkBodies.push(await request.json());
        return HttpResponse.json({
          id: "link-1",
          src_kind: "approval_run",
          src_id: RUN_ID,
          dst_kind: "work_order",
          dst_id: TARGET_ID,
          link_type: "approval_target",
          created_at: "2026-07-09T10:00:01Z",
        });
      }),
    );

    renderCompose(submitted);

    await user.click(await screen.findByRole("button", { name: "휴가 기안 선택" }));
    await user.type(screen.getByLabelText("제목"), "휴가 조정 요청");
    await user.selectOptions(screen.getByLabelText("사유 유형"), "연차");
    await user.type(screen.getByLabelText("상세 내용"), "WO-2643 대상 휴가 조정");
    await user.type(screen.getByLabelText("개체 검색"), "WO-2643");
    await user.click(screen.getByRole("button", { name: "개체 검색" }));
    await user.click(await screen.findByRole("button", { name: "WO-2643 유압 호스 연결" }));
    await user.click(screen.getByRole("button", { name: "상신" }));

    await waitFor(() => {
      expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, code: "AP-3122" }));
    });
    expect(startBodies[0]).toMatchObject({
      definition_id: DEFINITION_ID,
      definition_version: 7,
      trigger_type: "MANUAL",
      object_type: "work_order",
      object_id: TARGET_ID,
      input_payload: expect.objectContaining({ title: "휴가 조정 요청", reason: "연차", target_codes: ["WO-2643"] }),
    });
    expect(JSON.stringify(startBodies[0])).not.toContain("AP-3122");
    expect(linkBodies).toEqual([
      { src_kind: "approval_run", src_id: RUN_ID, dst_kind: "work_order", dst_id: TARGET_ID, link_type: "approval_target" },
    ]);
    expect(screen.getByText("AP-3122")).toBeVisible();
  });

  it("blocks self-approval preview before submit and surfaces the server chip on rejection", async () => {
    const user = userEvent.setup();
    let startCalls = 0;

    server.use(
      http.get("*/api/v1/workflow-studio/submittable-definitions", () =>
        HttpResponse.json({
          items: [
            submittableDefinition({
              approval_line: [
                { node_id: "self", label: "본인", actor_id: "author-1", actor_label: "김기안", state: "current" },
              ],
            }),
          ],
        }),
      ),
      http.get("*/api/v1/search", () =>
        HttpResponse.json({ results: [{ kind: "work_order", id: TARGET_ID, code: "WO-2643", title: "유압 호스", exists: true }] }),
      ),
      http.post("*/api/v1/workflow-runs", () => {
        startCalls += 1;
        return HttpResponse.json({ code: "self_approval" }, { status: 409 });
      }),
    );

    renderCompose();

    await user.click(await screen.findByRole("button", { name: "휴가 기안 선택" }));
    await user.type(screen.getByLabelText("제목"), "휴가 조정 요청");
    await user.selectOptions(screen.getByLabelText("사유 유형"), "연차");
    await user.type(screen.getByLabelText("개체 검색"), "WO-2643");
    await user.click(screen.getByRole("button", { name: "개체 검색" }));
    await user.click(await screen.findByRole("button", { name: "WO-2643 유압 호스 연결" }));
    await user.click(screen.getByRole("button", { name: "상신" }));

    expect(startCalls).toBe(0);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("자가 승인 차단")).toBeVisible();
  });

  it("drives author finalization and policy-gated post-finalization rejection", async () => {
    const user = userEvent.setup();
    const finalizeBodies: unknown[] = [];
    const rejectBodies: unknown[] = [];

    server.use(
      http.post("*/api/v1/workflow-tasks/:taskId/finalize", async ({ request }) => {
        finalizeBodies.push(await request.json());
        return HttpResponse.json({
          task: { id: "task-1", run_id: RUN_ID, status: "COMPLETED", decision_payload: { mode: "author" } },
          run: { id: RUN_ID, status: "SUCCEEDED" },
          archive_ref: { id: "archive-1", code: "AP-3122" },
        });
      }),
      http.post("*/api/v1/workflow-runs/:runId/post-finalization-rejection", async ({ request }) => {
        rejectBodies.push(await request.json());
        return HttpResponse.json({
          compensation: {
            id: "44444444-4444-4444-8444-444444444444",
            original_run_id: RUN_ID,
            reason: "법정 반려",
            created_by: "auditor-1",
          },
          run: { id: RUN_ID, status: "SUCCEEDED" },
        });
      }),
    );

    render(
      <PolicyGateProvider gate={allowAll}>
        <ApprovalCompletionPanel bearerToken={TOKEN} runId={RUN_ID} taskId="task-1" />
      </PolicyGateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "종결" }));
    expect(await screen.findByText("문서 보관")).toBeVisible();
    expect(screen.getByText("AP-3122")).toBeVisible();
    expect(finalizeBodies[0]).toMatchObject({ mode: "author" });

    await user.type(screen.getByLabelText("사후 반려 사유"), "법정 반려");
    await user.click(screen.getByRole("button", { name: "사후 반려" }));
    expect(await screen.findByText("보정 문서")).toBeVisible();
    expect(rejectBodies[0]).toMatchObject({ reason: "법정 반려" });
  });

  it("advances approval decisions through workflow-task decide and blocks author self-approval", async () => {
    const user = userEvent.setup();
    const decisionBodies: unknown[] = [];

    server.use(
      http.post("*/api/v1/workflow-tasks/:taskId/decide", async ({ request }) => {
        decisionBodies.push(await request.json());
        return HttpResponse.json({
          task: { task_id: "task-2", run_id: RUN_ID, status: "COMPLETED", decision_payload: { decision: "approve" } },
          run: { id: RUN_ID, status: "WAITING" },
          next_task: { task_id: "task-3", run_id: RUN_ID, status: "OPEN" },
        });
      }),
    );

    render(
      <PolicyGateProvider gate={allowAll}>
        <ApprovalDecisionPanel bearerToken={TOKEN} runId={RUN_ID} taskId="task-2" currentUserId="approver-1" authorUserId="author-1" />
      </PolicyGateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "승인" }));
    expect(await screen.findByText("COMPLETED")).toBeVisible();
    expect(decisionBodies[0]).toMatchObject({ decision: "approve" });

    render(
      <PolicyGateProvider gate={allowAll}>
        <ApprovalDecisionPanel bearerToken={TOKEN} runId={RUN_ID} taskId="task-2" currentUserId="author-1" authorUserId="author-1" />
      </PolicyGateProvider>,
    );
    const approveButtons = screen.getAllByRole("button", { name: "승인" });
    const latestApproveButton = approveButtons.at(-1);
    if (!latestApproveButton) throw new Error("expected an approve button");
    await user.click(latestApproveButton);
    expect(await screen.findByText("자가 승인 차단")).toBeVisible();
    expect(decisionBodies).toHaveLength(1);
  });


  it("requires comments for 반려 and 거부 before posting workflow-task decisions", async () => {
    const user = userEvent.setup();
    const decisionBodies: unknown[] = [];

    server.use(
      http.post("*/api/v1/workflow-tasks/:taskId/decide", async ({ request, params }) => {
        const body = await request.json();
        decisionBodies.push({ taskId: params.taskId, body });
        return HttpResponse.json({
          task: { task_id: params.taskId, run_id: RUN_ID, status: "COMPLETED", decision_payload: body },
          run: { id: RUN_ID, status: "WAITING" },
        });
      }),
    );

    const rejectPanel = render(
      <PolicyGateProvider gate={allowAll}>
        <ApprovalDecisionPanel bearerToken={TOKEN} runId={RUN_ID} taskId="task-reject" currentUserId="approver-1" authorUserId="author-1" />
      </PolicyGateProvider>,
    );
    await user.click(screen.getByRole("button", { name: "거부" }));
    expect(decisionBodies).toHaveLength(0);
    expect(await screen.findByRole("alert")).toHaveTextContent("서버 거절");
    await user.type(screen.getByLabelText("결재 의견"), "법무 검토 결과 거부");
    await user.click(screen.getByRole("button", { name: "거부" }));
    await waitFor(() => {
      expect(decisionBodies).toHaveLength(1);
    });
    expect(decisionBodies[0]).toMatchObject({
      taskId: "task-reject",
      body: { decision: "reject", comment: "법무 검토 결과 거부" },
    });
    rejectPanel.unmount();

    render(
      <PolicyGateProvider gate={allowAll}>
        <ApprovalDecisionPanel bearerToken={TOKEN} runId={RUN_ID} taskId="task-return" currentUserId="approver-1" authorUserId="author-1" />
      </PolicyGateProvider>,
    );
    await user.click(screen.getByRole("button", { name: "반려" }));
    expect(decisionBodies).toHaveLength(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("서버 거절");
    await user.type(screen.getByLabelText("결재 의견"), "증빙 보완 후 재상신");
    await user.click(screen.getByRole("button", { name: "반려" }));
    await waitFor(() => {
      expect(decisionBodies).toHaveLength(2);
    });
    expect(decisionBodies[1]).toMatchObject({
      taskId: "task-return",
      body: { decision: "return", comment: "증빙 보완 후 재상신" },
    });
  });

  it("requires delegate and post-finalization reasons before finalization-side effects", async () => {
    const user = userEvent.setup();
    const finalizeBodies: unknown[] = [];
    const rejectBodies: unknown[] = [];

    server.use(
      http.post("*/api/v1/workflow-tasks/:taskId/finalize", async ({ request }) => {
        finalizeBodies.push(await request.json());
        return HttpResponse.json({
          task: { id: "task-1", run_id: RUN_ID, status: "COMPLETED", decision_payload: { mode: "delegate" } },
          run: { id: RUN_ID, status: "SUCCEEDED" },
          archive_ref: { id: "archive-1", code: "AP-3122" },
        });
      }),
      http.post("*/api/v1/workflow-runs/:runId/post-finalization-rejection", async ({ request }) => {
        rejectBodies.push(await request.json());
        return HttpResponse.json({
          compensation: {
            id: "55555555-5555-4555-8555-555555555555",
            original_run_id: RUN_ID,
            reason: "사후 법정 반려",
            created_by: "delegate-1",
          },
          run: { id: RUN_ID, status: "SUCCEEDED" },
        });
      }),
    );

    const delegatePanel = render(
      <PolicyGateProvider gate={allowAll}>
        <ApprovalCompletionPanel bearerToken={TOKEN} runId={RUN_ID} taskId="task-1" />
      </PolicyGateProvider>,
    );
    await user.click(screen.getByRole("button", { name: "대행" }));
    expect(finalizeBodies).toHaveLength(0);
    expect(await screen.findByRole("alert")).toHaveTextContent("서버 거절");
    await user.type(screen.getByLabelText("대행 사유"), "작성자 휴직으로 위임 종결");
    await user.click(screen.getByRole("button", { name: "대행" }));
    await waitFor(() => {
      expect(finalizeBodies).toHaveLength(1);
    });
    expect(finalizeBodies[0]).toMatchObject({ mode: "delegate", reason: "작성자 휴직으로 위임 종결" });
    delegatePanel.unmount();

    render(
      <PolicyGateProvider gate={allowAll}>
        <ApprovalCompletionPanel bearerToken={TOKEN} runId={RUN_ID} taskId="task-1" />
      </PolicyGateProvider>,
    );
    await user.click(screen.getByRole("button", { name: "사후 반려" }));
    expect(rejectBodies).toHaveLength(0);
    expect(await screen.findByRole("alert")).toHaveTextContent("서버 거절");
    await user.type(screen.getByLabelText("사후 반려 사유"), "사후 법정 반려");
    await user.click(screen.getByRole("button", { name: "사후 반려" }));
    await waitFor(() => {
      expect(rejectBodies).toHaveLength(1);
    });
    expect(rejectBodies[0]).toMatchObject({ reason: "사후 법정 반려" });
    expect(await screen.findByText("보정 문서")).toBeVisible();
    expect(screen.getByText("55555555-5555-4555-8555-555555555555")).toBeVisible();
  });

});
