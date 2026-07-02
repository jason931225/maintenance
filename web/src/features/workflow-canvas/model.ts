import type {
  Edge as ReactFlowEdge,
  Node as ReactFlowNode,
} from "@xyflow/react";

export type WorkflowNodeType =
  | "trigger.form_submission"
  | "form.input"
  | "task.approval"
  | "condition.branch"
  | "action.object_update"
  | "action.notification"
  | "action.audit_append"
  | "end.state";

export type PortType =
  | "flow.start"
  | "flow.next"
  | "flow.branch"
  | "flow.terminal"
  | "data.form_payload"
  | "data.approval_result"
  | "data.object_ref"
  | "data.audit_event";

export type WorkflowEdgeKind = "control" | "data" | "decision" | "error";
export type DataSensitivity =
  | "public"
  | "summary_only"
  | "private_note"
  | "hr_sensitive";

export type WorkflowDefinitionV1 = {
  schema_version: "workflow.definition.v1";
  metadata: {
    name: string;
    description: string;
    owner_scope: { type: "org" | "group" | "site" | "team"; org_id?: string };
    object_type: string;
    sensitivity: DataSensitivity;
    tags: string[];
    locale: string;
  };
  graph: {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    variables: Array<Record<string, unknown>>;
    simulation_cases: Array<{ key: string; label: string }>;
  };
  canvas: {
    layout_version: "workflow.canvas.v1";
    nodes: Record<string, { x: number; y: number }>;
    viewport: { x: number; y: number; zoom: number };
  };
  validation: {
    last_result: "unknown" | "valid" | "invalid";
    last_validated_at: string | null;
    compiler_version: string | null;
  };
};

export type WorkflowNode = {
  id: string;
  key: string;
  type: WorkflowNodeType;
  label: string;
  description?: string;
  version: number;
  input_ports: WorkflowPort[];
  output_ports: WorkflowPort[];
  config: WorkflowNodeConfig;
  policy: Array<{ action: string }>;
  data_sensitivity: DataSensitivity;
  execution: Record<string, boolean | string | number>;
};

export type WorkflowPort = {
  key: string;
  direction: "input" | "output";
  type: PortType;
  required: boolean;
  cardinality: "one" | "many";
  label: string;
};

export type WorkflowNodeConfig =
  | TriggerFormSubmissionConfig
  | FormInputConfig
  | ApprovalTaskConfig
  | ConditionBranchConfig
  | ObjectUpdateConfig
  | NotificationConfig
  | AuditAppendConfig
  | EndStateConfig;

export type TriggerFormSubmissionConfig = {
  type: "trigger.form_submission";
  source: { object_type: string; event: string; scope: "org" };
  actor: { required_policy: string };
  idempotency: { key_template: string };
};

export type FormInputConfig = {
  type: "form.input";
  fields: Array<{
    key: string;
    label: string;
    field_type:
      | "object_ref"
      | "date_range"
      | "text"
      | "select"
      | "attachment";
    object_type?: string;
    required: boolean;
    sensitivity?: DataSensitivity;
    validation?: Record<string, boolean | string>;
  }>;
  submit_label: string;
};

export type ApprovalTaskConfig = {
  type: "task.approval";
  assignee_rule: {
    kind: "manager_of_subject" | "role";
    subject_field: string;
    fallback_role: string;
  };
  decision_options: Array<"approve" | "reject" | "request_change">;
  requires_comment_on: Array<"approve" | "reject" | "request_change">;
  requires_evidence: boolean;
  prevent_self_approval: boolean;
  sla: { duration: string; escalate_to: string };
  requires_passkey_step_up: boolean;
  policy: string[];
};

export type ConditionBranchConfig = {
  type: "condition.branch";
  expression: {
    op: "equals" | "not_equals" | "in" | "not_in" | "exists";
    left: { ref: string };
    right: string | boolean | number;
  };
  branches: Array<{ port: string; label: string; when: "true" | "false" }>;
  default_port: string;
};

export type ObjectUpdateConfig = {
  type: "action.object_update";
  action_id: string;
  target: { from: string };
  input: Record<string, string | { from: string }>;
  idempotency: { key_template: string };
  requires_policy: string;
};

export type NotificationConfig = {
  type: "action.notification";
  connector_key: string;
  action_key: string;
  recipient: { kind: "requester" | "manager" | "role"; role?: string };
  template_key: string;
  redaction: "summary_only" | "none";
  link: { object_ref: string };
};

export type AuditAppendConfig = {
  type: "action.audit_append";
  event_key: string;
  summary_template: string;
  redaction: "summary_only";
};

export type EndStateConfig = {
  type: "end.state";
  status: "approved" | "rejected" | "cancelled" | "completed" | "failed";
};

export type WorkflowEdge = {
  id: string;
  from_node_id: string;
  from_port: string;
  to_node_id: string;
  to_port: string;
  kind: WorkflowEdgeKind;
  label?: string;
  condition_ref?: string;
  data_mapping?: Array<Record<string, unknown>>;
};

export type WorkflowValidationFinding = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type WorkflowCanvasNodeData = {
  label: string;
  type: WorkflowNodeType;
  validationStatus: "valid" | "invalid";
  summary: string;
};

export type WorkflowNodeDescriptor = {
  type: WorkflowNodeType;
  label: string;
  group: string;
  purpose: string;
};

export const WORKFLOW_NODE_DESCRIPTORS: WorkflowNodeDescriptor[] = [
  {
    type: "trigger.form_submission",
    label: "Form submission trigger",
    group: "Trigger",
    purpose: "Start when a leave request is submitted.",
  },
  {
    type: "form.input",
    label: "Leave request form",
    group: "Form/Input",
    purpose: "Capture employee, date range, reason, and evidence.",
  },
  {
    type: "task.approval",
    label: "Manager approval",
    group: "Approval",
    purpose: "Ask the subject employee's manager to approve or reject.",
  },
  {
    type: "condition.branch",
    label: "Approval result condition",
    group: "Condition/Branch",
    purpose: "Split approved and rejected outcomes.",
  },
  {
    type: "action.object_update",
    label: "Update leave request status",
    group: "Action/Object update",
    purpose: "Set the business object's lifecycle status.",
  },
  {
    type: "action.notification",
    label: "Requester notification",
    group: "Notification",
    purpose: "Notify the requester with redacted summary copy.",
  },
  {
    type: "action.audit_append",
    label: "Append audit event",
    group: "Evidence/Audit",
    purpose: "Write a redacted audit/timeline entry.",
  },
  {
    type: "end.state",
    label: "End state",
    group: "End state",
    purpose: "Mark the workflow path terminal.",
  },
];

const NODE_DEFAULTS: Record<
  WorkflowNodeType,
  {
    id: string;
    key: string;
    label: string;
    description: string;
    input_ports: WorkflowPort[];
    output_ports: WorkflowPort[];
    config: WorkflowNodeConfig;
    policy: Array<{ action: string }>;
    data_sensitivity: DataSensitivity;
    execution: Record<string, boolean | string | number>;
  }
> = {
  "trigger.form_submission": {
    id: "node-trigger",
    key: "trigger.leave_submission",
    label: "Leave request submitted",
    description: "Starts the workflow from a submitted leave request.",
    input_ports: [],
    output_ports: [
      {
        key: "submitted",
        direction: "output",
        type: "flow.next",
        required: true,
        cardinality: "one",
        label: "Submitted",
      },
    ],
    config: {
      type: "trigger.form_submission",
      source: { object_type: "leave_request", event: "submitted", scope: "org" },
      actor: { required_policy: "workflow.trigger.leave_request.submit" },
      idempotency: {
        key_template: "leave_request:{object_id}:submitted:{version}",
      },
    },
    policy: [{ action: "leave_request.submit" }],
    data_sensitivity: "hr_sensitive",
    execution: { mode: "event_triggered" },
  },
  "form.input": {
    id: "node-form",
    key: "form.leave_request",
    label: "Leave request form",
    description: "Collects leave request fields before approval.",
    input_ports: [inputPort("in", "In")],
    output_ports: [outputPort("completed", "Form completed")],
    config: {
      type: "form.input",
      fields: [
        {
          key: "employee_id",
          label: "Employee",
          field_type: "object_ref",
          object_type: "employee",
          required: true,
          sensitivity: "hr_sensitive",
        },
        {
          key: "date_range",
          label: "Leave dates",
          field_type: "date_range",
          required: true,
          validation: { not_past: true },
        },
        {
          key: "reason",
          label: "Reason",
          field_type: "text",
          required: true,
          sensitivity: "private_note",
        },
        {
          key: "evidence_attachment",
          label: "Evidence attachment",
          field_type: "attachment",
          required: false,
          sensitivity: "private_note",
        },
      ],
      submit_label: "Submit leave request",
    },
    policy: [],
    data_sensitivity: "hr_sensitive",
    execution: { produces_form_payload: true },
  },
  "task.approval": {
    id: "node-approval",
    key: "task.manager_approval",
    label: "Manager approval",
    description: "Routes the request to the employee's manager.",
    input_ports: [inputPort("in", "In")],
    output_ports: [outputPort("decision", "Decision")],
    config: {
      type: "task.approval",
      assignee_rule: {
        kind: "manager_of_subject",
        subject_field: "employee_id",
        fallback_role: "hr.approver",
      },
      decision_options: ["approve", "reject", "request_change"],
      requires_comment_on: ["approve", "reject"],
      requires_evidence: false,
      prevent_self_approval: true,
      sla: { duration: "P2D", escalate_to: "hr.manager" },
      requires_passkey_step_up: false,
      policy: ["approval_request.approve.leave_request"],
    },
    policy: [{ action: "approval_request.approve.leave_request" }],
    data_sensitivity: "hr_sensitive",
    execution: { waits_for_human: true },
  },
  "condition.branch": {
    id: "node-condition",
    key: "condition.approval_result",
    label: "Approved?",
    description: "Branches on the manager approval decision.",
    input_ports: [inputPort("in", "Decision")],
    output_ports: [
      branchPort("approved", "Approved"),
      branchPort("rejected", "Rejected"),
    ],
    config: {
      type: "condition.branch",
      expression: {
        op: "equals",
        left: { ref: "approval.result" },
        right: "approved",
      },
      branches: [
        { port: "approved", label: "Approved", when: "true" },
        { port: "rejected", label: "Rejected", when: "false" },
      ],
      default_port: "rejected",
    },
    policy: [],
    data_sensitivity: "summary_only",
    execution: { deterministic: true },
  },
  "action.object_update": {
    id: "node-update",
    key: "action.update_leave_request",
    label: "Set status approved",
    description: "Updates the leave request lifecycle status.",
    input_ports: [inputPort("in", "In")],
    output_ports: [outputPort("done", "Done")],
    config: objectUpdateConfig("approved"),
    policy: [{ action: "leave_request.update_status" }],
    data_sensitivity: "hr_sensitive",
    execution: { side_effect: true, outbox_idempotent: true },
  },
  "action.notification": {
    id: "node-notification",
    key: "action.notify_requester",
    label: "Notify requester",
    description: "Sends a redacted result notification.",
    input_ports: [inputPort("in", "In")],
    output_ports: [outputPort("done", "Done")],
    config: notificationConfig("leave_request.approved"),
    policy: [],
    data_sensitivity: "summary_only",
    execution: { side_effect: true, outbox_idempotent: true },
  },
  "action.audit_append": {
    id: "node-audit",
    key: "action.audit_append",
    label: "Append audit event",
    description: "Records a redacted audit event.",
    input_ports: [inputPort("in", "In")],
    output_ports: [outputPort("done", "Done")],
    config: {
      type: "action.audit_append",
      event_key: "leave_request.workflow.completed",
      summary_template: "Leave request workflow completed with {status}.",
      redaction: "summary_only",
    },
    policy: [],
    data_sensitivity: "summary_only",
    execution: { side_effect: true, audit: true },
  },
  "end.state": {
    id: "node-end",
    key: "end.completed",
    label: "Completed end",
    description: "Terminal workflow state.",
    input_ports: [terminalInputPort("in", "In")],
    output_ports: [],
    config: { type: "end.state", status: "completed" },
    policy: [],
    data_sensitivity: "summary_only",
    execution: { terminal: true },
  },
};

export function createEmptyWorkflowDefinition({
  name,
  objectType,
}: {
  name: string;
  objectType: string;
}): WorkflowDefinitionV1 {
  return {
    schema_version: "workflow.definition.v1",
    metadata: {
      name,
      description:
        "Employee submits leave; manager approves or rejects; status and audit update.",
      owner_scope: { type: "org" },
      object_type: objectType,
      sensitivity: "hr_sensitive",
      tags: ["hr", "leave", "approval"],
      locale: "ko-KR",
    },
    graph: {
      nodes: [],
      edges: [],
      variables: [],
      simulation_cases: [
        { key: "normal_manager_approval", label: "Normal employee manager approval" },
      ],
    },
    canvas: {
      layout_version: "workflow.canvas.v1",
      nodes: {},
      viewport: { x: 0, y: 0, zoom: 0.9 },
    },
    validation: {
      last_result: "unknown",
      last_validated_at: null,
      compiler_version: null,
    },
  };
}

export function createWorkflowNode(
  type: WorkflowNodeType,
  overrides: Partial<Pick<WorkflowNode, "id" | "key" | "label">> = {},
): WorkflowNode {
  const defaults = NODE_DEFAULTS[type];
  return clone({
    id: defaults.id,
    key: defaults.key,
    type,
    label: defaults.label,
    description: defaults.description,
    version: 1,
    input_ports: defaults.input_ports,
    output_ports: defaults.output_ports,
    config: defaults.config,
    policy: defaults.policy,
    data_sensitivity: defaults.data_sensitivity,
    execution: defaults.execution,
    ...overrides,
  });
}

export function createUniqueWorkflowNode(
  type: WorkflowNodeType,
  existingNodes: WorkflowNode[],
): WorkflowNode {
  const base = createWorkflowNode(type);
  if (!existingNodes.some((node) => node.id === base.id || node.key === base.key)) {
    return base;
  }
  const count = existingNodes.filter((node) => node.type === type).length + 1;
  return createWorkflowNode(type, {
    id: `${base.id}-${String(count)}`,
    key: `${base.key}.${String(count)}`,
    label: `${base.label} ${String(count)}`,
  });
}

export function createLeaveRequestApprovalTemplate({
  name,
  objectType,
}: {
  name: string;
  objectType: string;
}): WorkflowDefinitionV1 {
  const definition = createEmptyWorkflowDefinition({ name, objectType });
  const nodes = [
    createWorkflowNode("trigger.form_submission"),
    createWorkflowNode("form.input"),
    createWorkflowNode("task.approval"),
    createWorkflowNode("condition.branch"),
    createWorkflowNode("action.object_update", {
      id: "node-approved-update",
      key: "action.approve_leave_request",
      label: "Set status approved",
    }),
    createWorkflowNode("action.notification", {
      id: "node-approved-notify",
      key: "action.notify_approved",
      label: "Notify requester approved",
    }),
    createWorkflowNode("action.audit_append", {
      id: "node-approved-audit",
      key: "action.audit_approved",
      label: "Audit approved path",
    }),
    createWorkflowNode("end.state", {
      id: "node-end-approved",
      key: "end.approved",
      label: "Approved end",
    }),
    createWorkflowNode("action.object_update", {
      id: "node-rejected-update",
      key: "action.reject_leave_request",
      label: "Set status rejected",
    }),
    createWorkflowNode("action.notification", {
      id: "node-rejected-notify",
      key: "action.notify_rejected",
      label: "Notify requester rejected",
    }),
    createWorkflowNode("action.audit_append", {
      id: "node-rejected-audit",
      key: "action.audit_rejected",
      label: "Audit rejected path",
    }),
    createWorkflowNode("end.state", {
      id: "node-end-rejected",
      key: "end.rejected",
      label: "Rejected end",
    }),
  ];

  updateObjectUpdateNode(nodes[4], "approved");
  updateNotificationNode(nodes[5], "leave_request.approved");
  updateAuditNode(nodes[6], "leave_request.workflow.approved", "Leave request approved.");
  updateEndNode(nodes[7], "approved");
  updateObjectUpdateNode(nodes[8], "rejected");
  updateNotificationNode(nodes[9], "leave_request.rejected");
  updateAuditNode(nodes[10], "leave_request.workflow.rejected", "Leave request rejected.");
  updateEndNode(nodes[11], "rejected");

  definition.graph.nodes = nodes;
  definition.graph.edges = [
    edge("edge-trigger-form", "node-trigger", "submitted", "node-form", "in", "control"),
    edge("edge-form-approval", "node-form", "completed", "node-approval", "in", "control"),
    edge(
      "edge-approval-condition",
      "node-approval",
      "decision",
      "node-condition",
      "in",
      "control",
    ),
    edge(
      "edge-condition-approved-update",
      "node-condition",
      "approved",
      "node-approved-update",
      "in",
      "decision",
      "Approved",
    ),
    edge(
      "edge-approved-update-notify",
      "node-approved-update",
      "done",
      "node-approved-notify",
      "in",
      "control",
    ),
    edge(
      "edge-approved-notify-audit",
      "node-approved-notify",
      "done",
      "node-approved-audit",
      "in",
      "control",
    ),
    edge(
      "edge-approved-audit-end",
      "node-approved-audit",
      "done",
      "node-end-approved",
      "in",
      "control",
    ),
    edge(
      "edge-condition-rejected-update",
      "node-condition",
      "rejected",
      "node-rejected-update",
      "in",
      "decision",
      "Rejected",
    ),
    edge(
      "edge-rejected-update-notify",
      "node-rejected-update",
      "done",
      "node-rejected-notify",
      "in",
      "control",
    ),
    edge(
      "edge-rejected-notify-audit",
      "node-rejected-notify",
      "done",
      "node-rejected-audit",
      "in",
      "control",
    ),
    edge(
      "edge-rejected-audit-end",
      "node-rejected-audit",
      "done",
      "node-end-rejected",
      "in",
      "control",
    ),
  ];
  definition.canvas.nodes = {
    "node-trigger": { x: 80, y: 120 },
    "node-form": { x: 320, y: 120 },
    "node-approval": { x: 560, y: 120 },
    "node-condition": { x: 800, y: 120 },
    "node-approved-update": { x: 1040, y: 40 },
    "node-approved-notify": { x: 1280, y: 40 },
    "node-approved-audit": { x: 1520, y: 40 },
    "node-end-approved": { x: 1760, y: 40 },
    "node-rejected-update": { x: 1040, y: 220 },
    "node-rejected-notify": { x: 1280, y: 220 },
    "node-rejected-audit": { x: 1520, y: 220 },
    "node-end-rejected": { x: 1760, y: 220 },
  };
  return withValidationResult(definition);
}

export function addNodeToWorkflow(
  definition: WorkflowDefinitionV1,
  type: WorkflowNodeType,
): WorkflowDefinitionV1 {
  const next = clone(definition);
  const node = createUniqueWorkflowNode(type, next.graph.nodes);
  next.graph.nodes.push(node);
  next.canvas.nodes[node.id] = {
    x: 80 + next.graph.nodes.length * 40,
    y: 120 + next.graph.nodes.length * 24,
  };
  return withValidationResult(next);
}

export function connectWorkflowNodes(
  definition: WorkflowDefinitionV1,
  params: {
    fromNodeId: string;
    fromPort: string;
    toNodeId: string;
    toPort: string;
    label?: string;
  },
): { definition: WorkflowDefinitionV1; error?: string } {
  const source = definition.graph.nodes.find((node) => node.id === params.fromNodeId);
  const target = definition.graph.nodes.find((node) => node.id === params.toNodeId);
  const sourcePort = source?.output_ports.find((port) => port.key === params.fromPort);
  const targetPort = target?.input_ports.find((port) => port.key === params.toPort);
  if (!source || !target || !sourcePort || !targetPort) {
    return { definition, error: "Select compatible source and target ports before connecting." };
  }
  if (!portsCompatible(sourcePort.type, targetPort.type)) {
    return {
      definition,
      error: `Cannot connect ${sourcePort.label} to ${targetPort.label}; the port types are incompatible.`,
    };
  }
  const next = clone(definition);
  next.graph.edges.push({
    id: `edge-${params.fromNodeId}-${params.fromPort}-${params.toNodeId}-${params.toPort}-${String(next.graph.edges.length + 1)}`,
    from_node_id: params.fromNodeId,
    from_port: params.fromPort,
    to_node_id: params.toNodeId,
    to_port: params.toPort,
    kind: sourcePort.type === "flow.branch" ? "decision" : "control",
    label: params.label,
  });
  return { definition: withValidationResult(next) };
}

export function updateApprovalFallbackRole(
  definition: WorkflowDefinitionV1,
  nodeId: string,
  fallbackRole: string,
): WorkflowDefinitionV1 {
  const next = clone(definition);
  const node = next.graph.nodes.find((item) => item.id === nodeId);
  if (node?.config.type === "task.approval") {
    node.config.assignee_rule.fallback_role = fallbackRole;
  }
  return withValidationResult(next);
}

export function updateApprovalSla(
  definition: WorkflowDefinitionV1,
  nodeId: string,
  duration: string,
): WorkflowDefinitionV1 {
  const next = clone(definition);
  const node = next.graph.nodes.find((item) => item.id === nodeId);
  if (node?.config.type === "task.approval") {
    node.config.sla.duration = duration;
  }
  return withValidationResult(next);
}

export function toggleApprovalPasskey(
  definition: WorkflowDefinitionV1,
  nodeId: string,
  requiresPasskey: boolean,
): WorkflowDefinitionV1 {
  const next = clone(definition);
  const node = next.graph.nodes.find((item) => item.id === nodeId);
  if (node?.config.type === "task.approval") {
    node.config.requires_passkey_step_up = requiresPasskey;
  }
  return withValidationResult(next);
}

export function validateWorkflowDefinition(
  definition: WorkflowDefinitionV1,
): WorkflowValidationFinding[] {
  const findings: WorkflowValidationFinding[] = [];
  const nodes = definition.graph.nodes;
  const edges = definition.graph.edges;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  const keys = new Set<string>();

  for (const node of nodes) {
    if (ids.has(node.id)) {
      findings.push(error("duplicate_node_id", `Duplicate node id ${node.id}.`, node.id));
    }
    ids.add(node.id);
    if (keys.has(node.key)) {
      findings.push(error("duplicate_node_key", `Duplicate node key ${node.key}.`, node.id));
    }
    keys.add(node.key);
    findings.push(...validateNodeConfig(node));
  }

  if (!definition.metadata.name.trim()) {
    findings.push(error("missing_workflow_name", "Workflow name is required."));
  }
  if (!snakeCase(definition.metadata.object_type)) {
    findings.push(error("invalid_workflow_object_type", "Workflow object type must be snake case."));
  }

  const triggerNodes = nodes.filter((node) => node.type === "trigger.form_submission");
  if (triggerNodes.length === 0) {
    findings.push(error("missing_trigger", "Exactly one form submission trigger is required."));
  } else if (triggerNodes.length > 1) {
    findings.push(error("too_many_triggers", "Only one trigger node is allowed in the MVP."));
  }

  for (const trigger of triggerNodes) {
    if (
      trigger.config.type === "trigger.form_submission" &&
      trigger.config.source.object_type !== definition.metadata.object_type
    ) {
      findings.push(
        error(
          "object_type_mismatch",
          "Workflow metadata object type must match the form submission trigger source.",
          trigger.id,
        ),
      );
    }
  }

  if (!nodes.some((node) => node.type === "end.state")) {
    findings.push(error("missing_terminal", "At least one end state node is required."));
  }

  for (const workflowEdge of edges) {
    const from = byId.get(workflowEdge.from_node_id);
    const to = byId.get(workflowEdge.to_node_id);
    const output = from?.output_ports.find((port) => port.key === workflowEdge.from_port);
    const input = to?.input_ports.find((port) => port.key === workflowEdge.to_port);
    if (!from || !to || !output || !input) {
      findings.push({
        severity: "error",
        code: "invalid_edge_endpoint",
        edgeId: workflowEdge.id,
        message: "Edge references a missing node or port.",
      });
      continue;
    }
    if (!portsCompatible(output.type, input.type)) {
      findings.push({
        severity: "error",
        code: "incompatible_ports",
        edgeId: workflowEdge.id,
        message: `Edge ${workflowEdge.id} connects incompatible ports.`,
      });
    }
  }

  for (const node of nodes) {
    for (const port of node.input_ports.filter((item) => item.required)) {
      const inbound = edges.some(
        (workflowEdge) =>
          workflowEdge.to_node_id === node.id && workflowEdge.to_port === port.key,
      );
      if (!inbound) {
        findings.push(error("unconnected_input", `${node.label} requires an input edge.`, node.id));
      }
    }
    for (const port of node.output_ports.filter((item) => item.required)) {
      const outbound = edges.filter(
        (workflowEdge) =>
          workflowEdge.from_node_id === node.id && workflowEdge.from_port === port.key,
      );
      if (outbound.length === 0) {
        findings.push(error("unconnected_output", `${node.label} requires a ${port.label} connection.`, node.id));
      }
      if (port.cardinality === "one" && outbound.length > 1) {
        findings.push(error("too_many_output_edges", `${node.label} ${port.label} can connect once.`, node.id));
      }
    }
  }

  const reachable = reachableNodeIds(triggerNodes[0], edges);
  for (const node of nodes) {
    if (triggerNodes.length === 1 && !reachable.has(node.id)) {
      findings.push(error("unreachable_node", `${node.label} is not reachable from the trigger.`, node.id));
    }
  }

  return findings;
}

export function withValidationResult(definition: WorkflowDefinitionV1): WorkflowDefinitionV1 {
  const next = clone(definition);
  const hasBlocker = validateWorkflowDefinition(next).some(
    (finding) => finding.severity === "error",
  );
  next.validation.last_result = hasBlocker ? "invalid" : "valid";
  return next;
}

export function canonicalToReactFlow(definition: WorkflowDefinitionV1): {
  nodes: Array<ReactFlowNode<WorkflowCanvasNodeData>>;
  edges: ReactFlowEdge[];
} {
  const validationByNode = new Map<string, WorkflowValidationFinding[]>();
  for (const finding of validateWorkflowDefinition(definition)) {
    if (!finding.nodeId) continue;
    validationByNode.set(finding.nodeId, [
      ...(validationByNode.get(finding.nodeId) ?? []),
      finding,
    ]);
  }
  return {
    nodes: definition.graph.nodes.map((node, index) => ({
      id: node.id,
      type: "workflowNode",
      position: definition.canvas.nodes[node.id] ?? {
        x: 80 + index * 220,
        y: 120,
      },
      data: {
        label: node.label,
        type: node.type,
        validationStatus: validationByNode.has(node.id) ? "invalid" : "valid",
        summary: summarizeNode(node),
      },
    })),
    edges: definition.graph.edges.map((workflowEdge) => ({
      id: workflowEdge.id,
      source: workflowEdge.from_node_id,
      sourceHandle: workflowEdge.from_port,
      target: workflowEdge.to_node_id,
      targetHandle: workflowEdge.to_port,
      label: workflowEdge.label,
    })),
  };
}

export function reactFlowLayoutToCanvas(
  definition: WorkflowDefinitionV1,
  flow: { nodes: Array<Pick<ReactFlowNode, "id" | "position">>; edges: ReactFlowEdge[] },
): WorkflowDefinitionV1 {
  const next = clone(definition);
  for (const node of flow.nodes) {
    next.canvas.nodes[node.id] = {
      x: node.position.x,
      y: node.position.y,
    };
  }
  return next;
}

export function isWorkflowDefinitionV1(value: unknown): value is WorkflowDefinitionV1 {
  if (!value || typeof value !== "object") return false;
  return (value as { schema_version?: unknown }).schema_version === "workflow.definition.v1";
}

export function summarizeNode(node: WorkflowNode): string {
  switch (node.config.type) {
    case "trigger.form_submission":
      return `${node.config.source.object_type}.${node.config.source.event}`;
    case "form.input":
      return `${String(node.config.fields.length)} fields`;
    case "task.approval":
      return `${node.config.assignee_rule.kind} · fallback ${node.config.assignee_rule.fallback_role}`;
    case "condition.branch":
      return node.config.branches.map((branch) => branch.label).join(" / ");
    case "action.object_update": {
      const status = node.config.input.status;
      return typeof status === "string" ? status : node.config.action_id;
    }
    case "action.notification":
      return `${node.config.connector_key}.${node.config.action_key}`;
    case "action.audit_append":
      return node.config.event_key;
    case "end.state":
      return node.config.status;
  }
}

function validateNodeConfig(node: WorkflowNode): WorkflowValidationFinding[] {
  const findings: WorkflowValidationFinding[] = [];
  if (!node.label.trim()) {
    findings.push(error("missing_node_label", "Node label is required.", node.id));
  }
  switch (node.config.type) {
    case "trigger.form_submission":
      if (!snakeCase(node.config.source.object_type)) {
        findings.push(error("invalid_object_type", "Trigger object type must be snake case.", node.id));
      }
      break;
    case "form.input":
      if (node.config.fields.length === 0) {
        findings.push(error("missing_form_fields", "Form node needs at least one field.", node.id));
      }
      for (const field of node.config.fields) {
        if (!field.label.trim() || !snakeCase(field.key)) {
          findings.push(error("invalid_form_field", "Form fields need labels and snake_case keys.", node.id));
        }
      }
      break;
    case "task.approval":
      if (!node.config.assignee_rule.fallback_role.trim()) {
        findings.push(error("missing_approval_fallback", "Approval fallback role is required.", node.id));
      }
      if (!node.config.sla.duration.trim() || !node.config.sla.escalate_to.trim()) {
        findings.push(error("missing_approval_sla", "Approval SLA and escalation are required.", node.id));
      }
      break;
    case "condition.branch":
      if (node.config.branches.length < 2 || !node.config.default_port.trim()) {
        findings.push(error("missing_condition_branches", "Condition needs labeled branches and a default branch.", node.id));
      }
      break;
    case "action.object_update":
      if (!node.config.action_id.trim() || typeof node.config.input.status !== "string") {
        findings.push(error("missing_object_update", "Object update needs an action and status input.", node.id));
      }
      break;
    case "action.notification":
      if (
        !node.config.connector_key.trim() ||
        !node.config.action_key.trim() ||
        !node.config.template_key.trim()
      ) {
        findings.push(error("missing_notification", "Notification connector, action, and template are required.", node.id));
      }
      break;
    case "action.audit_append":
      if (!node.config.event_key.trim() || !node.config.summary_template.trim()) {
        findings.push(error("missing_audit", "Audit event key and summary are required.", node.id));
      }
      break;
    case "end.state":
      if (!node.config.status.trim()) {
        findings.push(error("missing_end_status", "End state status is required.", node.id));
      }
      break;
  }
  return findings;
}

function inputPort(key: string, label: string): WorkflowPort {
  return {
    key,
    direction: "input",
    type: "flow.next",
    required: true,
    cardinality: "one",
    label,
  };
}

function terminalInputPort(key: string, label: string): WorkflowPort {
  return {
    key,
    direction: "input",
    type: "flow.terminal",
    required: true,
    cardinality: "one",
    label,
  };
}

function outputPort(key: string, label: string): WorkflowPort {
  return {
    key,
    direction: "output",
    type: "flow.next",
    required: true,
    cardinality: "one",
    label,
  };
}

function branchPort(key: string, label: string): WorkflowPort {
  return {
    key,
    direction: "output",
    type: "flow.branch",
    required: true,
    cardinality: "one",
    label,
  };
}

function objectUpdateConfig(status: "approved" | "rejected" | "completed"): ObjectUpdateConfig {
  return {
    type: "action.object_update",
    action_id: "leave_request.update_status",
    target: { from: "trigger.object_ref" },
    input: {
      status,
      updated_by: { from: "approval.actor_id" },
      updated_at: { from: "system.now" },
    },
    idempotency: {
      key_template: `{run_id}:{node_key}:leave_request.update_status.${status}`,
    },
    requires_policy: "leave_request.update_status",
  };
}

function notificationConfig(templateKey: string): NotificationConfig {
  return {
    type: "action.notification",
    connector_key: "internal.notifications",
    action_key: "send_push",
    recipient: { kind: "requester" },
    template_key: templateKey,
    redaction: "summary_only",
    link: { object_ref: "trigger.object_ref" },
  };
}

function edge(
  id: string,
  fromNodeId: string,
  fromPort: string,
  toNodeId: string,
  toPort: string,
  kind: WorkflowEdgeKind,
  label?: string,
): WorkflowEdge {
  return {
    id,
    from_node_id: fromNodeId,
    from_port: fromPort,
    to_node_id: toNodeId,
    to_port: toPort,
    kind,
    label,
  };
}

function updateObjectUpdateNode(node: WorkflowNode | undefined, status: "approved" | "rejected") {
  if (!node || node.config.type !== "action.object_update") return;
  node.config = objectUpdateConfig(status);
}

function updateNotificationNode(node: WorkflowNode | undefined, templateKey: string) {
  if (!node || node.config.type !== "action.notification") return;
  node.config = notificationConfig(templateKey);
}

function updateAuditNode(
  node: WorkflowNode | undefined,
  eventKey: string,
  summaryTemplate: string,
) {
  if (!node || node.config.type !== "action.audit_append") return;
  node.config.event_key = eventKey;
  node.config.summary_template = summaryTemplate;
}

function updateEndNode(node: WorkflowNode | undefined, status: "approved" | "rejected") {
  if (!node || node.config.type !== "end.state") return;
  node.config.status = status;
}

function portsCompatible(output: PortType, input: PortType): boolean {
  if (output === input) return true;
  if (input === "flow.terminal" && ["flow.next", "flow.branch", "flow.terminal"].includes(output)) {
    return true;
  }
  if (input === "flow.next" && output === "flow.branch") return true;
  return false;
}

function reachableNodeIds(start: WorkflowNode | undefined, edges: WorkflowEdge[]): Set<string> {
  const reachable = new Set<string>();
  if (!start) return reachable;
  const queue = [start.id];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    for (const workflowEdge of edges.filter((item) => item.from_node_id === current)) {
      queue.push(workflowEdge.to_node_id);
    }
  }
  return reachable;
}

function snakeCase(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

function error(
  code: string,
  message: string,
  nodeId?: string,
): WorkflowValidationFinding {
  return { severity: "error", code, message, nodeId };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
