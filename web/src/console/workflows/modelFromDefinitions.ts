import type {
  WorkflowDefinitionEventResponse,
  WorkflowDefinitionResponse,
} from "../../api/types";
import { ko } from "../../i18n/ko";
import type {
  ScheduleSummary,
  WorkflowAutoModel,
  WorkflowBlockKind,
  WorkflowCanvasBlock,
  WorkflowResult,
  WorkflowRunEvent,
  WorkflowRunStatus,
  WorkflowSummary,
} from "./types";

const T = ko.console.workflows;
const EXEC_SCHEMA_VERSION = "wf.exec.v1";
const LEGACY_SCHEMA_VERSION = "workflow.definition.v1";

type JsonRecord = Record<string, unknown>;

interface WorkflowDefinitionModelOptions {
  historyByDefinitionId?: Record<string, WorkflowDefinitionEventResponse[]>;
  runLogByDefinitionId?: Record<string, WorkflowRunEvent[]>;
}

interface PendingWorkflowDefinitionFields {
  pending_version?: unknown;
  pending_staged_by?: unknown;
}

interface WorkflowNodeRecord extends JsonRecord {
  id: string;
  key: string;
  type: string;
  config?: JsonRecord;
}

const NODE_KIND_CONFIG: Partial<Record<string, WorkflowBlockKind>> = {
  "trigger.form_submission": "trigger",
  "form.input": "action",
  "task.approval": "action",
  "condition.branch": "condition",
  "action.object_update": "action",
  "action.notification": "action",
  "action.audit_append": "action",
  "end.state": "action",
};

export function createWorkflowAutoModelFromDefinitions(
  definitions: WorkflowDefinitionResponse[],
  options: WorkflowDefinitionModelOptions = {},
): WorkflowAutoModel {
  return {
    workflows: definitions.map((definition) =>
      workflowSummaryFromDefinition(
        definition,
        options.historyByDefinitionId?.[definition.id] ?? [],
        options.runLogByDefinitionId?.[definition.id],
      ),
    ),
    schedules: definitions.flatMap((definition) => {
      const history = options.historyByDefinitionId?.[definition.id] ?? [];
      const runLog = options.runLogByDefinitionId?.[definition.id];
      const schedule = scheduleSummaryFromDefinition(definition, history, runLog);
      return schedule ? [schedule] : [];
    }),
  };
}

function workflowSummaryFromDefinition(
  definition: WorkflowDefinitionResponse,
  history: WorkflowDefinitionEventResponse[],
  runLogOverride: WorkflowRunEvent[] | undefined,
): WorkflowSummary {
  const runLog = runLogOverride ?? runLogFromHistory(history);
  const pendingRevision = pendingRevisionFromDefinition(definition, history);

  return {
    id: definition.id,
    name: definition.display_name,
    active: definition.status === "ACTIVE",
    version: definition.latest_version,
    runs: runLog.length,
    lastRun: definition.updated_at,
    lastResult: resultFromDefinitionStatus(definition.status),
    blocks: blocksFromDefinition(definition),
    runLog,
    pendingRevision,
  };
}

function pendingRevisionFromDefinition(
  definition: WorkflowDefinitionResponse,
  history: WorkflowDefinitionEventResponse[],
): WorkflowSummary["pendingRevision"] {
  const pending = definition as PendingWorkflowDefinitionFields;
  const pendingVersion = pending.pending_version;
  if (typeof pendingVersion === "number") {
    const stagedById =
      typeof pending.pending_staged_by === "string"
        ? pending.pending_staged_by
        : undefined;
    const stagedBy =
      pendingActorFromHistory(history, stagedById) ??
      stagedById ??
      T.canvas.binding.actorFallback;
    return {
      version: pendingVersion,
      stagedBy,
      stagedById,
      status: "pending_review",
    };
  }

  return undefined;
}

function pendingActorFromHistory(
  history: WorkflowDefinitionEventResponse[],
  stagedById: string | undefined,
): string | undefined {
  const stagingEvent = history.find((event) =>
    ["workflow_definition.stage_revision", "workflow_definition.publish"].includes(
      event.action,
    ),
  );
  if (stagingEvent?.actor_display_name) return stagingEvent.actor_display_name;
  return stagedById;
}

function scheduleSummaryFromDefinition(
  definition: WorkflowDefinitionResponse,
  history: WorkflowDefinitionEventResponse[],
  runLogOverride: WorkflowRunEvent[] | undefined,
): ScheduleSummary | undefined {
  const definitionRecord = asRecord(definition.definition);
  const schedule = asRecord(definitionRecord?.schedule);
  const cron = stringField(schedule, "cron");
  if (!cron) return undefined;
  const runLog = runLogOverride ?? runLogFromHistory(history);
  const active = booleanField(schedule, "active") ?? definition.status === "ACTIVE";
  return {
    id: `schedule:${definition.id}`,
    workflowId: definition.id,
    name: stringField(schedule, "name") ?? definition.display_name,
    active,
    cron,
    cronLabel:
      stringField(schedule, "cron_label") ?? stringField(schedule, "label") ?? cron,
    nextRun:
      stringField(schedule, "next_run_at") ??
      stringField(schedule, "next_run") ??
      T.status.queued,
    lastRun:
      stringField(schedule, "last_run_at") ??
      stringField(schedule, "last_run") ??
      definition.updated_at,
    lastResult: active ? resultFromDefinitionStatus(definition.status) : "warn",
    runLog,
  };
}

function blocksFromDefinition(
  definition: WorkflowDefinitionResponse): WorkflowCanvasBlock[] {
  const schemaVersion = schemaVersionOf(definition.definition);
  if (schemaVersion === EXEC_SCHEMA_VERSION) {
    return execBlocksFromDefinition(definition.definition);
  }
  if (schemaVersion === LEGACY_SCHEMA_VERSION) {
    return legacyBlocksFromDefinition(definition.definition);
  }
  return [];
}

function execBlocksFromDefinition(definition: unknown): WorkflowCanvasBlock[] {
  const definitionRecord = asRecord(definition);
  const graph = asRecord(definitionRecord?.graph);
  const nodes = asArray(graph?.nodes)
    .map(parseWorkflowNode)
    .filter((node): node is WorkflowNodeRecord => Boolean(node));

  return nodes.flatMap((node) => blocksFromExecNode(node));
}

function blocksFromExecNode(node: WorkflowNodeRecord): WorkflowCanvasBlock[] {
  if (node.type === "condition.branch") {
    return [conditionBlockFromNode(node), branchBlockFromNode(node)];
  }

  const kind = NODE_KIND_CONFIG[node.type];
  if (!kind) return [];
  return [genericBlockFromNode(node, kind)];
}

function genericBlockFromNode(
  node: WorkflowNodeRecord,
  kind: WorkflowBlockKind,
): WorkflowCanvasBlock {
  const config = asRecord(node.config) ?? {};
  return {
    id: node.id,
    kind,
    title: labelFromConfig(config) ?? titleFallbackForKind(kind, node.key),
    detail: detailFromNode(node),
    chips: [EXEC_SCHEMA_VERSION, node.type, T.canvas.binding.nodeKey(node.key)],
  };
}

function conditionBlockFromNode(node: WorkflowNodeRecord): WorkflowCanvasBlock {
  const config = asRecord(node.config) ?? {};
  return {
    id: `${node.id}:condition`,
    kind: "condition",
    title: labelFromConfig(config) ?? T.canvas.binding.conditionFallback,
    detail: expressionSummary(config.expression) ?? detailFromNode(node),
    chips: [EXEC_SCHEMA_VERSION, node.type, T.canvas.binding.nodeKey(node.key)],
  };
}

function branchBlockFromNode(node: WorkflowNodeRecord): WorkflowCanvasBlock {
  const config = asRecord(node.config) ?? {};
  const branches = asArray(config.branches)
    .map(asRecord)
    .filter((branch): branch is JsonRecord => Boolean(branch))
    .map((branch) => ({
      label:
        stringField(branch, "label") ??
        stringField(branch, "port") ??
        T.canvas.binding.branchFallback,
      port: stringField(branch, "port"),
    }));
  const defaultPort = stringField(config, "default_port");
  return {
    id: `${node.id}:branch`,
    kind: "branch",
    title: T.canvas.binding.branchTitle(
      branches.map((branch) => branch.label).filter(Boolean),
    ),
    detail: defaultPort
      ? T.canvas.binding.branchDetailWithDefault(branches.length, defaultPort)
      : T.canvas.binding.branchDetail(branches.length),
    chips: [EXEC_SCHEMA_VERSION, node.type, T.canvas.binding.nodeKey(node.key)],
    outputs: branches,
  };
}

function legacyBlocksFromDefinition(definition: unknown): WorkflowCanvasBlock[] {
  const definitionRecord = asRecord(definition);
  if (!definitionRecord) return [];

  const trigger = stringField(definitionRecord, "trigger");
  const steps = asArray(definitionRecord.steps)
    .map(asRecord)
    .filter((step): step is JsonRecord => Boolean(step));

  const blocks: WorkflowCanvasBlock[] = [];
  if (trigger) {
    blocks.push({
      id: "legacy-trigger",
      kind: "trigger",
      title: trigger,
      detail: T.canvas.binding.legacyDefinition,
      chips: [LEGACY_SCHEMA_VERSION],
    });
  }
  steps.forEach((step, index) => {
    const key = stringField(step, "key") ?? String(index + 1);
    const type = stringField(step, "type") ?? T.canvas.binding.actionFallback;
    blocks.push({
      id: `legacy-step-${key}`,
      kind: "action",
      title: key,
      detail: type,
      chips: [LEGACY_SCHEMA_VERSION],
    });
  });
  return blocks;
}

function detailFromNode(node: WorkflowNodeRecord): string | undefined {
  const config = asRecord(node.config) ?? {};
  if (node.type === "trigger.form_submission") {
    const source = asRecord(config.source);
    const parts = [
      stringField(source, "object_type"),
      stringField(source, "event"),
      stringField(source, "scope"),
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? T.canvas.binding.sourceDetail(parts) : undefined;
  }
  if (node.type === "action.notification") {
    const parts = [
      stringField(config, "connector_key"),
      stringField(config, "action_key"),
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }
  if (node.type === "action.object_update") return stringField(config, "action_id");
  if (node.type === "action.audit_append") return stringField(config, "event_key");
  if (node.type === "task.approval") {
    const assigneeRule = asRecord(config.assignee_rule);
    return stringField(assigneeRule, "fallback_role");
  }
  if (node.type === "end.state") return stringField(config, "status");
  return node.type;
}

function expressionSummary(expressionValue: unknown): string | undefined {
  const expression = asRecord(expressionValue);
  if (!expression) return undefined;
  const left = asRecord(expression.left);
  const leftRef = stringField(left, "ref");
  const op = stringField(expression, "op");
  const right = scalarDisplay(expression.right);
  if (!leftRef || !op || !right) return undefined;
  return T.canvas.binding.expression(leftRef, operatorLabel(op), right);
}

function parseWorkflowNode(value: unknown): WorkflowNodeRecord | undefined {
  const record = asRecord(value);
  const id = stringField(record, "id");
  const key = stringField(record, "key");
  const type = stringField(record, "type");
  if (!record || !id || !key || !type) return undefined;
  return {
    ...record,
    id,
    key,
    type,
    config: asRecord(record.config),
  };
}

function runLogFromHistory(history: WorkflowDefinitionEventResponse[]): WorkflowRunEvent[] {
  return history.map((event) => ({
    id: event.id,
    code: event.action,
    at: event.created_at,
    actor: event.actor_display_name ?? T.canvas.binding.actorFallback,
    status: runStatusFromHistoryStatus(event.status),
    label: event.summary,
    generatedObjects:
      event.version === null ? undefined : [T.canvas.binding.versionObject(event.version)],
  }));
}

function schemaVersionOf(value: unknown): string | undefined {
  return stringField(asRecord(value), "schema_version");
}

function resultFromDefinitionStatus(status: WorkflowDefinitionResponse["status"]): WorkflowResult {
  if (status === "ACTIVE") return "ok";
  if (status === "DRAFT" || status === "PAUSED") return "warn";
  return "error";
}

function runStatusFromHistoryStatus(status: string): WorkflowRunStatus {
  const normalized = status.toLowerCase();
  if (normalized === "active" || normalized === "published") return "succeeded";
  if (normalized === "draft") return "queued";
  if (normalized === "paused") return "skipped";
  if (normalized === "retired") return "cancelled";
  return "succeeded";
}

function titleFallbackForKind(kind: WorkflowBlockKind, key: string): string {
  if (kind === "trigger") return T.canvas.binding.triggerFallback;
  if (kind === "condition") return T.canvas.binding.conditionFallback;
  if (kind === "branch") return T.canvas.binding.branchFallback;
  return key || T.canvas.binding.actionFallback;
}

function labelFromConfig(config: JsonRecord): string | undefined {
  return (
    stringField(config, "label") ??
    stringField(config, "title") ??
    stringField(config, "name")
  );
}

function operatorLabel(op: string): string {
  return (
    {
      equals: "=",
      not_equals: "≠",
      in: "in",
      not_in: "not in",
      exists: "exists",
    } as Record<string, string>
  )[op] ?? op;
}

function scalarDisplay(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(record: JsonRecord | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanField(record: JsonRecord | undefined, field: string): boolean | undefined {
  const value = record?.[field];
  return typeof value === "boolean" ? value : undefined;
}
