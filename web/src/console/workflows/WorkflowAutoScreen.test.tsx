import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { WORKFLOW_AUTO_ACTIONS, type WorkflowAutoModel } from "./types";
import { WorkflowAutoScreen } from "./WorkflowAutoScreen";

const allowAll: PolicyGate = { can: () => true };
const denyTabAffordances: PolicyGate = {
  can: (action) =>
    action !== WORKFLOW_AUTO_ACTIONS.viewWorkflowTab &&
    action !== WORKFLOW_AUTO_ACTIONS.viewScheduleTab,
};
const scheduleOnlyGate: PolicyGate = {
  can: (action) => action !== WORKFLOW_AUTO_ACTIONS.viewWorkflowTab,
};

describe("WorkflowAutoScreen", () => {
  it("renders workflow and schedule tab affordances when policy allows them", () => {
    render(
      <PolicyGateProvider gate={allowAll}>
        <WorkflowAutoScreen />
      </PolicyGateProvider>,
    );

    expect(screen.getByRole("tab", { name: "워크플로 스튜디오" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "예약 작업" })).toBeTruthy();
  });

  it("omits workflow and schedule tab panels when policy denies tab views", () => {
    render(
      <PolicyGateProvider gate={denyTabAffordances}>
        <WorkflowAutoScreen />
      </PolicyGateProvider>,
    );

    expect(screen.getByRole("heading", { name: "자동화" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "워크플로 스튜디오" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "예약 작업" })).toBeNull();
    expect(screen.queryByRole("button", { name: "무단결근 3회 소명 기안 선택" })).toBeNull();
    expect(screen.getByText("사용 가능한 자동화 탭이 없습니다.")).toBeTruthy();
  });

  it("falls back to the first allowed tab instead of rendering a denied tab panel", () => {
    render(
      <PolicyGateProvider gate={scheduleOnlyGate}>
        <WorkflowAutoScreen />
      </PolicyGateProvider>,
    );

    expect(screen.queryByRole("tab", { name: "워크플로 스튜디오" })).toBeNull();
    expect(screen.getByRole("tab", { name: "예약 작업" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "무단결근 3회 소명 기안 선택" })).toBeNull();
    expect(screen.getByRole("button", { name: "근태 마감 리마인더 선택" })).toBeTruthy();
  });

  it("uses stable PolicyGated action names for tab affordances", () => {
    const seen: string[] = [];
    const gate: PolicyGate = {
      can: (action) => {
        seen.push(action);
        return true;
      },
    };

    render(
      <PolicyGateProvider gate={gate}>
        <WorkflowAutoScreen />
      </PolicyGateProvider>,
    );

    expect(seen).toEqual(
      expect.arrayContaining([
        WORKFLOW_AUTO_ACTIONS.viewWorkflowTab,
        WORKFLOW_AUTO_ACTIONS.viewScheduleTab,
      ]),
    );
  });

  it("edits a schedule draft and saves through the PolicyGated schedule action", async () => {
    const saved: Array<{ id: string; cron: string; cronLabel: string; name: string }> = [];

    render(
      <PolicyGateProvider gate={allowAll}>
        <WorkflowAutoScreen
          initialTab="schedule"
          onScheduleSave={(id, draft) => {
            saved.push({
              id,
              cron: draft.cron,
              cronLabel: draft.cronLabel,
              name: draft.name,
            });
          }}
        />
      </PolicyGateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "예약 편집" }));
    await userEvent.clear(screen.getByLabelText("예약 이름"));
    await userEvent.type(screen.getByLabelText("예약 이름"), "근태 마감 재예약");
    await userEvent.clear(screen.getByLabelText("cron"));
    await userEvent.type(screen.getByLabelText("cron"), "0 18 * * 1-5");
    await userEvent.clear(screen.getByLabelText("예약 라벨"));
    await userEvent.type(screen.getByLabelText("예약 라벨"), "평일 18:00");
    await userEvent.click(screen.getByRole("button", { name: "예약 저장" }));

    await waitFor(() => {
      expect(saved).toEqual([
        {
          id: "sch-attendance-close",
          cron: "0 18 * * 1-5",
          cronLabel: "평일 18:00",
          name: "근태 마감 재예약",
        },
      ]);
    });
  });

  it("renders runLog error state, retry affordance, timestamps, and generated objects", () => {
    const model = {
      workflows: [
        {
          id: "wf-runlog",
          name: "오류 재시도 워크플로",
          active: true,
          version: 7,
          runs: 2,
          lastRun: "2026-07-09 17:10",
          lastResult: "error",
          blocks: [],
          runLog: [
            {
              id: "run-err-001",
              code: "RUN-ERR-001",
              at: "2026-07-09 17:10",
              actor: "자동화 엔진",
              status: "failed",
              label: "승인 객체 생성 실패",
              error: "connector timeout",
              retryable: true,
              retryCount: 2,
            },
            {
              id: "run-ok-001",
              code: "RUN-OK-001",
              at: "2026-07-09 16:50",
              actor: "김관리",
              status: "succeeded",
              label: "소명 기안 생성",
              generatedObjects: ["AP-184"],
            },
          ],
        },
      ],
      schedules: [],
    } satisfies WorkflowAutoModel;

    render(
      <PolicyGateProvider gate={allowAll}>
        <WorkflowAutoScreen model={model} />
      </PolicyGateProvider>,
    );

    expect(screen.getByRole("alert", { name: "실패" })).toBeTruthy();
    expect(screen.getByText("RUN-ERR-001")).toBeTruthy();
    expect(screen.getByText("2026-07-09 17:10 · 자동화 엔진")).toBeTruthy();
    expect(screen.getByText("connector timeout")).toBeTruthy();
    expect(screen.getByText("재시도 2회")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(screen.getByText("AP-184")).toBeTruthy();
  });

  it("invokes workflow, simulation, and schedule manual trigger handlers", async () => {
    const user = userEvent.setup();
    const model = {
      workflows: [
        {
          id: "wf-manual",
          name: "수동 실행 워크플로",
          active: true,
          version: 2,
          runs: 0,
          lastRun: "없음",
          lastResult: "warn",
          blocks: [],
          runLog: [],
        },
      ],
      schedules: [
        {
          id: "sch-manual",
          name: "수동 예약 작업",
          active: true,
          cron: "0 17 * * *",
          cronLabel: "매일 17:00",
          nextRun: "2026-07-09 17:00",
          lastRun: "없음",
          lastResult: "warn",
          runLog: [],
        },
      ],
    } satisfies WorkflowAutoModel;
    const workflowRun = vi.fn();
    const workflowSimulate = vi.fn();
    const scheduleRun = vi.fn();

    render(
      <PolicyGateProvider gate={allowAll}>
        <WorkflowAutoScreen
          model={model}
          onWorkflowRun={workflowRun}
          onWorkflowSimulate={workflowSimulate}
          onScheduleRun={scheduleRun}
        />
      </PolicyGateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "수동 실행" }));
    await user.click(screen.getByRole("button", { name: "시뮬레이션" }));
    await user.click(screen.getByRole("tab", { name: "예약 작업" }));
    await user.click(screen.getByRole("button", { name: "수동 실행" }));

    expect(workflowRun).toHaveBeenCalledWith("wf-manual");
    expect(workflowSimulate).toHaveBeenCalledWith("wf-manual");
    expect(scheduleRun).toHaveBeenCalledWith("sch-manual");
  });

  it("guards four-eyes publish actions and prevents self-approval of staged revisions", async () => {
    const user = userEvent.setup();
    const seenActions: string[] = [];
    const gate: PolicyGate = {
      can: (action) => {
        seenActions.push(action);
        return true;
      },
    };
    const model = {
      workflows: [
        {
          id: "wf-four-eyes",
          name: "개정 승인 워크플로",
          active: true,
          version: 4,
          runs: 0,
          lastRun: "2026-07-09 17:10",
          lastResult: "ok",
          blocks: [],
          runLog: [],
          pendingRevision: {
            version: 5,
            stagedBy: "개발자",
            stagedById: "user-maker",
            status: "pending_review",
          },
        },
      ],
      schedules: [],
    } satisfies WorkflowAutoModel;
    const approve = vi.fn();
    const withdraw = vi.fn();

    render(
      <PolicyGateProvider gate={gate}>
        <WorkflowAutoScreen
          model={model}
          currentUserId="user-maker"
          onApprovePublish={approve}
          onWithdrawPublish={withdraw}
        />
      </PolicyGateProvider>,
    );

    expect(screen.getByText("개정 대기 v5 · 개발자")).toBeTruthy();
    expect(screen.getByText("본인이 상신한 개정은 다른 담당자가 승인해야 합니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "적용 승인" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "적용 승인" }));
    expect(approve).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "철회" }));
    expect(withdraw).toHaveBeenCalledWith("wf-four-eyes", 5);
    expect(seenActions).toEqual(
      expect.arrayContaining([
        WORKFLOW_AUTO_ACTIONS.approvePublish,
        WORKFLOW_AUTO_ACTIONS.withdrawPublish,
      ]),
    );
  });

  it("stages and approves workflow revisions through distinct PolicyGated publish actions", async () => {
    const user = userEvent.setup();
    const stage = vi.fn();
    const approve = vi.fn();
    const model = {
      workflows: [
        {
          id: "wf-stage",
          name: "개정 저장 워크플로",
          active: true,
          version: 3,
          runs: 0,
          lastRun: "2026-07-09 16:50",
          lastResult: "warn",
          blocks: [],
          runLog: [],
        },
        {
          id: "wf-approve",
          name: "개정 적용 워크플로",
          active: true,
          version: 4,
          runs: 0,
          lastRun: "2026-07-09 17:10",
          lastResult: "ok",
          blocks: [],
          runLog: [],
          pendingRevision: {
            version: 5,
            stagedBy: "김관리",
            stagedById: "user-maker",
            status: "pending_review",
          },
        },
      ],
      schedules: [],
    } satisfies WorkflowAutoModel;

    render(
      <PolicyGateProvider gate={allowAll}>
        <WorkflowAutoScreen
          model={model}
          selectedWorkflowId="wf-stage"
          currentUserId="user-checker"
          onStagePublish={stage}
          onApprovePublish={approve}
        />
      </PolicyGateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "개정 저장" }));
    expect(stage).toHaveBeenCalledWith("wf-stage");
    await user.click(screen.getByRole("button", { name: "개정 적용 워크플로 선택" }));
    await user.click(screen.getByRole("button", { name: "적용 승인" }));
    expect(approve).toHaveBeenCalledWith("wf-approve", 5);
  });
});
