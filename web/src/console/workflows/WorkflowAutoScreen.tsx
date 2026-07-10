import { useMemo, useState, type CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated, usePolicyGate } from "../policy";
import "../tokens.css";
import { CanvasBlock } from "./CanvasBlock";
import { RunLogTimeline } from "./RunLogTimeline";
import { createWorkflowAutoStubModel } from "./stubModel";
import {
  WORKFLOW_AUTO_ACTIONS,
  type ScheduleDraft,
  type ScheduleSummary,
  type WorkflowAutoModel,
  type WorkflowAutoTab,
  type WorkflowResult,
  type WorkflowSummary,
} from "./types";

const T = ko.console.workflows;

type StatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

export interface WorkflowAutoScreenProps {
  model?: WorkflowAutoModel;
  initialTab?: WorkflowAutoTab;
  selectedWorkflowId?: string;
  selectedScheduleId?: string;
  currentUserId?: string;
  readOnly?: boolean;
  onWorkflowSelect?: (id: string) => void;
  onScheduleSelect?: (id: string) => void;
  onWorkflowToggle?: (id: string, active: boolean) => void | Promise<void>;
  onWorkflowRun?: (id: string) => void | Promise<void>;
  onWorkflowSimulate?: (id: string) => void | Promise<void>;
  onStagePublish?: (id: string) => void | Promise<void>;
  onApprovePublish?: (id: string, version: number) => void | Promise<void>;
  onWithdrawPublish?: (id: string, version: number) => void | Promise<void>;
  onScheduleToggle?: (id: string, active: boolean) => void | Promise<void>;
  onScheduleRun?: (id: string) => void | Promise<void>;
  onScheduleEdit?: (id: string) => void;
  onScheduleSave?: (id: string, draft: ScheduleDraft) => void | Promise<void>;
  onScheduleCreate?: (draft: ScheduleDraft) => void | Promise<void>;
  onScheduleDelete?: (id: string) => void | Promise<void>;
}

const rootStyle: CSSProperties = {
  minHeight: "100%",
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-h1)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const tabRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const panelGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(300px, 340px) minmax(560px, 1fr)",
  gap: "var(--sp-5)",
  alignItems: "start",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const buttonStyle: CSSProperties = {
  minHeight: 34,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  cursor: "not-allowed",
  opacity: 0.55,
};

const listButtonBaseStyle: CSSProperties = {
  ...buttonStyle,
  width: "100%",
  minHeight: 52,
  display: "grid",
  justifyItems: "stretch",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  textAlign: "left",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const noteStyle: CSSProperties = {
  margin: 0,
  color: "var(--warn-tx)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
};

const canvasStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--canvas-grid-bd)",
  borderRadius: "var(--radius-card)",
  background: "var(--canvas-grid-bg)",
};

const canvasStepStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-4)",
};

const connectorStyle: CSSProperties = {
  width: 34,
  height: 2,
  borderRadius: "var(--radius-pill)",
  background: "var(--canvas-link)",
};

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const inputStyle: CSSProperties = {
  minHeight: 34,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-sm)",
};

function draftFromSchedule(schedule?: ScheduleSummary): ScheduleDraft {
  return {
    name: schedule?.name ?? "",
    cron: schedule?.cron ?? "",
    cronLabel: schedule?.cronLabel ?? "",
    active: schedule?.active ?? true,
  };
}

function resultTone(result: WorkflowResult): StatusTone {
  if (result === "ok") return "ok";
  if (result === "warn") return "warn";
  return "danger";
}

function selectedById<TItem extends { id: string }>(
  items: TItem[],
  id: string | undefined,
): TItem | undefined {
  return items.find((item) => item.id === id) ?? items[0];
}

function runAction(action: (() => void | Promise<void>) | undefined): void {
  void Promise.resolve(action?.());
}

function sameActor(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function WorkflowList({
  workflows,
  selectedId,
  onSelect,
}: {
  workflows: WorkflowSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-labelledby="console-workflow-list-title" style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <h2 id="console-workflow-list-title" style={sectionTitleStyle}>
          {T.sections.workflows}
        </h2>
        <StatusChip tone="neutral">{T.count(workflows.length)}</StatusChip>
      </div>
      <ol style={listStyle}>
        {workflows.map((workflow) => {
          const selected = workflow.id === selectedId;
          return (
            <li key={workflow.id}>
              <PolicyGated action={WORKFLOW_AUTO_ACTIONS.selectWorkflow} resource={{ kind: "workflow", id: workflow.id }}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={T.actions.selectWorkflow(workflow.name)}
                  onClick={() => {
                    onSelect(workflow.id);
                  }}
                  style={{
                    ...listButtonBaseStyle,
                    borderColor: selected ? "var(--signal)" : "var(--border)",
                    background: selected ? "var(--accent-bg)" : "var(--surface)",
                  }}
                >
                  <span>{workflow.name}</span>
                  <span style={chipRowStyle}>
                    <StatusChip tone={workflow.active ? "ok" : "neutral"}>
                      {workflow.active ? T.status.active : T.status.inactive}
                    </StatusChip>
                    <StatusChip tone={resultTone(workflow.lastResult)}>
                      {T.status[workflow.lastResult]}
                    </StatusChip>
                    {workflow.pendingRevision ? (
                      <StatusChip tone="warn">{T.status.pendingReview}</StatusChip>
                    ) : null}
                  </span>
                </button>
              </PolicyGated>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ScheduleList({
  schedules,
  selectedId,
  onSelect,
}: {
  schedules: ScheduleSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-labelledby="console-schedule-list-title" style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <h2 id="console-schedule-list-title" style={sectionTitleStyle}>
          {T.sections.schedules}
        </h2>
        <StatusChip tone="neutral">{T.count(schedules.length)}</StatusChip>
      </div>
      <ol style={listStyle}>
        {schedules.map((schedule) => {
          const selected = schedule.id === selectedId;
          return (
            <li key={schedule.id}>
              <PolicyGated action={WORKFLOW_AUTO_ACTIONS.selectSchedule} resource={{ kind: "schedule", id: schedule.id }}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={T.actions.selectSchedule(schedule.name)}
                  onClick={() => {
                    onSelect(schedule.id);
                  }}
                  style={{
                    ...listButtonBaseStyle,
                    borderColor: selected ? "var(--signal)" : "var(--border)",
                    background: selected ? "var(--accent-bg)" : "var(--surface)",
                  }}
                >
                  <span>{schedule.name}</span>
                  <span style={chipRowStyle}>
                    <StatusChip tone={schedule.active ? "ok" : "neutral"}>
                      {schedule.active ? T.status.active : T.status.inactive}
                    </StatusChip>
                    <StatusChip tone={resultTone(schedule.lastResult)}>
                      {T.status[schedule.lastResult]}
                    </StatusChip>
                  </span>
                </button>
              </PolicyGated>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function WorkflowDetail({ workflow, props }: { workflow: WorkflowSummary; props: WorkflowAutoScreenProps }) {
  const showWorkflowActions =
    !props.readOnly &&
    Boolean(props.onWorkflowToggle || props.onWorkflowRun || props.onWorkflowSimulate);
  const showPublishActions =
    !props.readOnly &&
    Boolean(props.onStagePublish || props.onApprovePublish || props.onWithdrawPublish);
  const pendingRevision = workflow.pendingRevision;
  const selfApprovalBlocked = sameActor(props.currentUserId, pendingRevision?.stagedById);

  return (
    <section aria-labelledby="console-workflow-detail-title" style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <h2 id="console-workflow-detail-title" style={sectionTitleStyle}>
          {workflow.name}
        </h2>
        <div style={chipRowStyle}>
          <StatusChip tone={workflow.active ? "ok" : "neutral"}>
            {workflow.active ? T.status.active : T.status.inactive}
          </StatusChip>
          <StatusChip tone="info">{T.labels.version(workflow.version)}</StatusChip>
          <StatusChip tone={resultTone(workflow.lastResult)}>{T.status[workflow.lastResult]}</StatusChip>
        </div>
      </div>

      <div style={chipRowStyle}>
        <StatusChip tone="neutral">{T.labels.runs(workflow.runs)}</StatusChip>
        <StatusChip tone="neutral">{T.labels.lastRun(workflow.lastRun)}</StatusChip>
        {pendingRevision ? (
          <StatusChip tone="warn">
            {T.labels.pendingRevision(pendingRevision.version, pendingRevision.stagedBy)}
          </StatusChip>
        ) : null}
      </div>

      {showWorkflowActions ? (
        <div style={chipRowStyle}>
          {props.onWorkflowToggle ? (
            <PolicyGated action={WORKFLOW_AUTO_ACTIONS.toggleWorkflow} resource={{ kind: "workflow", id: workflow.id }}>
              <button
                type="button"
                onClick={() => {
                  runAction(() => props.onWorkflowToggle?.(workflow.id, !workflow.active));
                }}
                style={buttonStyle}
              >
                {workflow.active ? T.actions.disable : T.actions.enable}
              </button>
            </PolicyGated>
          ) : null}
          {props.onWorkflowRun ? (
            <PolicyGated action={WORKFLOW_AUTO_ACTIONS.runWorkflow} resource={{ kind: "workflow", id: workflow.id }}>
              <button
                type="button"
                onClick={() => {
                  runAction(() => props.onWorkflowRun?.(workflow.id));
                }}
                style={buttonStyle}
              >
                {T.actions.run}
              </button>
            </PolicyGated>
          ) : null}
          {props.onWorkflowSimulate ? (
            <PolicyGated action={WORKFLOW_AUTO_ACTIONS.simulateWorkflow} resource={{ kind: "workflow", id: workflow.id }}>
              <button
                type="button"
                onClick={() => {
                  runAction(() => props.onWorkflowSimulate?.(workflow.id));
                }}
                style={buttonStyle}
              >
                {T.actions.simulate}
              </button>
            </PolicyGated>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="console-workflow-canvas-title" style={{ display: "grid", gap: "var(--sp-3)" }}>
        <h3 id="console-workflow-canvas-title" style={sectionTitleStyle}>
          {T.canvas.title}
        </h3>
        {workflow.blocks.length > 0 ? (
          <div style={canvasStyle}>
            {workflow.blocks.map((block, index) => (
              <div key={block.id} style={canvasStepStyle}>
                <CanvasBlock block={block} />
                {index < workflow.blocks.length - 1 ? <span aria-hidden="true" style={connectorStyle} /> : null}
              </div>
            ))}
          </div>
        ) : (
          <StatusChip tone="neutral">{T.canvas.empty}</StatusChip>
        )}
      </section>

      {showPublishActions ? (
        <section aria-labelledby="console-workflow-publish-title" style={{ display: "grid", gap: "var(--sp-3)" }}>
          <h3 id="console-workflow-publish-title" style={sectionTitleStyle}>
            {T.sections.publish}
          </h3>
          {selfApprovalBlocked ? <p style={noteStyle}>{T.labels.selfApprovalBlocked}</p> : null}
          <div style={chipRowStyle}>
            {!pendingRevision && props.onStagePublish ? (
              <PolicyGated action={WORKFLOW_AUTO_ACTIONS.stagePublish} resource={{ kind: "workflow", id: workflow.id }}>
                <button
                  type="button"
                  onClick={() => {
                    runAction(() => props.onStagePublish?.(workflow.id));
                  }}
                  style={buttonStyle}
                >
                  {T.actions.stagePublish}
                </button>
              </PolicyGated>
            ) : null}
            {pendingRevision && props.onApprovePublish ? (
              <PolicyGated action={WORKFLOW_AUTO_ACTIONS.approvePublish} resource={{ kind: "workflow", id: workflow.id }}>
                <button
                  type="button"
                  disabled={selfApprovalBlocked}
                  onClick={() => {
                    if (!selfApprovalBlocked) {
                      runAction(() => props.onApprovePublish?.(workflow.id, pendingRevision.version));
                    }
                  }}
                  style={selfApprovalBlocked ? disabledButtonStyle : buttonStyle}
                >
                  {T.actions.approvePublish}
                </button>
              </PolicyGated>
            ) : null}
            {pendingRevision && props.onWithdrawPublish ? (
              <PolicyGated action={WORKFLOW_AUTO_ACTIONS.withdrawPublish} resource={{ kind: "workflow", id: workflow.id }}>
                <button
                  type="button"
                  onClick={() => {
                    runAction(() => props.onWithdrawPublish?.(workflow.id, pendingRevision.version));
                  }}
                  style={buttonStyle}
                >
                  {T.actions.withdrawPublish}
                </button>
              </PolicyGated>
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="console-workflow-runlog-title" style={{ display: "grid", gap: "var(--sp-3)" }}>
        <h3 id="console-workflow-runlog-title" style={sectionTitleStyle}>
          {T.timeline.title}
        </h3>
        <RunLogTimeline events={workflow.runLog} />
      </section>
    </section>
  );
}

function ScheduleDetail({
  schedule,
  props,
  draft,
  isEditing,
  onDraftChange,
  onEdit,
  onSave,
  onCancel,
}: {
  schedule: ScheduleSummary;
  props: WorkflowAutoScreenProps;
  draft: ScheduleDraft;
  isEditing: boolean;
  onDraftChange: (draft: ScheduleDraft) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const showScheduleActions =
    !props.readOnly &&
    Boolean(
      props.onScheduleToggle ||
        props.onScheduleRun ||
        props.onScheduleEdit ||
        props.onScheduleSave ||
        props.onScheduleDelete,
    );

  return (
    <section aria-labelledby="console-schedule-detail-title" style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <h2 id="console-schedule-detail-title" style={sectionTitleStyle}>
          {schedule.name}
        </h2>
        <div style={chipRowStyle}>
          <StatusChip tone={schedule.active ? "ok" : "neutral"}>
            {schedule.active ? T.status.active : T.status.inactive}
          </StatusChip>
          <StatusChip tone={resultTone(schedule.lastResult)}>{T.status[schedule.lastResult]}</StatusChip>
        </div>
      </div>

      <div style={chipRowStyle}>
        <StatusChip tone="info">{T.labels.cron(schedule.cron)}</StatusChip>
        <StatusChip tone="neutral">{schedule.cronLabel}</StatusChip>
        <StatusChip tone="neutral">{T.labels.nextRun(schedule.nextRun)}</StatusChip>
        <StatusChip tone="neutral">{T.labels.lastRun(schedule.lastRun)}</StatusChip>
      </div>

      {isEditing ? (
        <div style={fieldGridStyle}>
          <label style={fieldStyle}>
            {T.labels.scheduleName}
            <input
              aria-label={T.labels.scheduleName}
              value={draft.name}
              onChange={(event) => {
                onDraftChange({ ...draft, name: event.currentTarget.value });
              }}
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            {T.labels.scheduleCron}
            <input
              aria-label={T.labels.scheduleCron}
              value={draft.cron}
              onChange={(event) => {
                onDraftChange({ ...draft, cron: event.currentTarget.value });
              }}
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            {T.labels.scheduleCronLabel}
            <input
              aria-label={T.labels.scheduleCronLabel}
              value={draft.cronLabel}
              onChange={(event) => {
                onDraftChange({ ...draft, cronLabel: event.currentTarget.value });
              }}
              style={inputStyle}
            />
          </label>
        </div>
      ) : null}

      {showScheduleActions ? (
        <div style={chipRowStyle}>
          {props.onScheduleToggle ? (
            <PolicyGated action={WORKFLOW_AUTO_ACTIONS.toggleSchedule} resource={{ kind: "schedule", id: schedule.id }}>
              <button
                type="button"
                onClick={() => {
                  runAction(() => props.onScheduleToggle?.(schedule.id, !schedule.active));
                }}
                style={buttonStyle}
              >
                {schedule.active ? T.actions.disable : T.actions.enable}
              </button>
            </PolicyGated>
          ) : null}
          {props.onScheduleRun ? (
            <PolicyGated action={WORKFLOW_AUTO_ACTIONS.runSchedule} resource={{ kind: "schedule", id: schedule.id }}>
              <button
                type="button"
                onClick={() => {
                  runAction(() => props.onScheduleRun?.(schedule.id));
                }}
                style={buttonStyle}
              >
                {T.actions.run}
              </button>
            </PolicyGated>
          ) : null}
          {isEditing ? (
            <>
              <PolicyGated action={WORKFLOW_AUTO_ACTIONS.saveSchedule} resource={{ kind: "schedule", id: schedule.id }}>
                <button type="button" onClick={onSave} style={buttonStyle}>
                  {T.actions.saveSchedule}
                </button>
              </PolicyGated>
              <button type="button" onClick={onCancel} style={buttonStyle}>
                {T.actions.cancel}
              </button>
            </>
          ) : props.onScheduleSave || props.onScheduleEdit ? (
            <PolicyGated action={WORKFLOW_AUTO_ACTIONS.editSchedule} resource={{ kind: "schedule", id: schedule.id }}>
              <button type="button" onClick={onEdit} style={buttonStyle}>
                {T.actions.editSchedule}
              </button>
            </PolicyGated>
          ) : null}
          {props.onScheduleDelete ? (
            <PolicyGated action={WORKFLOW_AUTO_ACTIONS.deleteSchedule} resource={{ kind: "schedule", id: schedule.id }}>
              <button
                type="button"
                onClick={() => {
                  runAction(() => props.onScheduleDelete?.(schedule.id));
                }}
                style={buttonStyle}
              >
                {T.actions.deleteSchedule}
              </button>
            </PolicyGated>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="console-schedule-runlog-title" style={{ display: "grid", gap: "var(--sp-3)" }}>
        <h3 id="console-schedule-runlog-title" style={sectionTitleStyle}>
          {T.timeline.title}
        </h3>
        <RunLogTimeline events={schedule.runLog} />
      </section>
    </section>
  );
}

export function WorkflowAutoScreen(props: WorkflowAutoScreenProps) {
  const gate = usePolicyGate();
  const model = useMemo(() => props.model ?? createWorkflowAutoStubModel(), [props.model]);
  const [tab, setTab] = useState<WorkflowAutoTab>(props.initialTab ?? "workflow");
  const [workflowId, setWorkflowId] = useState<string | undefined>(
    props.selectedWorkflowId ?? model.workflows[0]?.id,
  );
  const [scheduleId, setScheduleId] = useState<string | undefined>(
    props.selectedScheduleId ?? model.schedules[0]?.id,
  );
  const activeWorkflowId = workflowId ?? props.selectedWorkflowId;
  const activeScheduleId = scheduleId ?? props.selectedScheduleId;
  const selectedWorkflow = selectedById(model.workflows, activeWorkflowId);
  const selectedSchedule = selectedById(model.schedules, activeScheduleId);
  const [editingScheduleId, setEditingScheduleId] = useState<string>();
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() =>
    draftFromSchedule(selectedSchedule),
  );
  const workflowTabResource = { kind: "workflow_tab", id: "workflow" };
  const scheduleTabResource = { kind: "workflow_tab", id: "schedule" };
  const canViewWorkflowTab = gate.can(WORKFLOW_AUTO_ACTIONS.viewWorkflowTab, workflowTabResource);
  const canViewScheduleTab = gate.can(WORKFLOW_AUTO_ACTIONS.viewScheduleTab, scheduleTabResource);
  const fallbackTab: WorkflowAutoTab | undefined = canViewWorkflowTab
    ? "workflow"
    : canViewScheduleTab
      ? "schedule"
      : undefined;
  const activeTab: WorkflowAutoTab | undefined =
    tab === "workflow"
      ? canViewWorkflowTab
        ? "workflow"
        : fallbackTab
      : canViewScheduleTab
        ? "schedule"
        : fallbackTab;

  function selectWorkflow(id: string): void {
    setWorkflowId(id);
    props.onWorkflowSelect?.(id);
  }

  function selectSchedule(id: string): void {
    setScheduleId(id);
    setEditingScheduleId(undefined);
    setScheduleDraft(draftFromSchedule(model.schedules.find((schedule) => schedule.id === id)));
    props.onScheduleSelect?.(id);
  }

  function editSchedule(): void {
    if (!selectedSchedule) return;
    setScheduleDraft(draftFromSchedule(selectedSchedule));
    setEditingScheduleId(selectedSchedule.id);
    props.onScheduleEdit?.(selectedSchedule.id);
  }

  function saveSchedule(): void {
    if (!selectedSchedule) return;
    runAction(async () => {
      await props.onScheduleSave?.(selectedSchedule.id, scheduleDraft);
      setEditingScheduleId(undefined);
    });
  }

  function cancelScheduleEdit(): void {
    setEditingScheduleId(undefined);
    setScheduleDraft(draftFromSchedule(selectedSchedule));
  }

  return (
    <main className="console" data-console-workflows style={rootStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{T.title}</h1>
        <div aria-label={T.tabs.label} role="tablist" style={tabRowStyle}>
          <PolicyGated action={WORKFLOW_AUTO_ACTIONS.viewWorkflowTab} resource={workflowTabResource}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "workflow"}
              onClick={() => {
                setTab("workflow");
              }}
              style={{
                ...buttonStyle,
                borderColor: activeTab === "workflow" ? "var(--signal)" : "var(--border)",
                background: activeTab === "workflow" ? "var(--accent-bg)" : "var(--surface)",
              }}
            >
              {T.tabs.workflow}
            </button>
          </PolicyGated>
          <PolicyGated action={WORKFLOW_AUTO_ACTIONS.viewScheduleTab} resource={scheduleTabResource}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "schedule"}
              onClick={() => {
                setTab("schedule");
              }}
              style={{
                ...buttonStyle,
                borderColor: activeTab === "schedule" ? "var(--signal)" : "var(--border)",
                background: activeTab === "schedule" ? "var(--accent-bg)" : "var(--surface)",
              }}
            >
              {T.tabs.schedule}
            </button>
          </PolicyGated>
        </div>
      </header>

      {activeTab ? (
        <div style={panelGridStyle}>
          {activeTab === "workflow" ? (
            <>
              <WorkflowList workflows={model.workflows} selectedId={selectedWorkflow?.id} onSelect={selectWorkflow} />
              {selectedWorkflow ? (
                <WorkflowDetail workflow={selectedWorkflow} props={props} />
              ) : (
                <StatusChip tone="neutral">{T.labels.noSelection}</StatusChip>
              )}
            </>
          ) : (
            <>
              <ScheduleList schedules={model.schedules} selectedId={selectedSchedule?.id} onSelect={selectSchedule} />
              {selectedSchedule ? (
                <ScheduleDetail
                  schedule={selectedSchedule}
                  props={props}
                  draft={scheduleDraft}
                  isEditing={editingScheduleId === selectedSchedule.id}
                  onDraftChange={setScheduleDraft}
                  onEdit={editSchedule}
                  onSave={saveSchedule}
                  onCancel={cancelScheduleEdit}
                />
              ) : (
                <StatusChip tone="neutral">{T.labels.noSelection}</StatusChip>
              )}
            </>
          )}
        </div>
      ) : (
        <StatusChip tone="neutral">{T.labels.noAvailableTabs}</StatusChip>
      )}
    </main>
  );
}
