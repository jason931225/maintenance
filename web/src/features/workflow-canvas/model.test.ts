import { describe, expect, it } from "vitest";

import {
  canonicalToReactFlow,
  createCanonicalApprovalTemplate,
  createEmptyWorkflowDefinition,
  createLeaveRequestApprovalTemplate,
  createWorkflowNode,
  reactFlowLayoutToCanvas,
  validateWorkflowDefinition,
} from "./model";

describe("workflow canvas canonical model", () => {
  it("creates a valid leave request approval template and preserves React Flow layout separately from graph semantics", () => {
    const definition = createLeaveRequestApprovalTemplate({
      name: "휴가 신청 승인",
      objectType: "leave_request",
    });

    expect(definition.schema_version).toBe("workflow.definition.v1");
    expect(definition.graph.nodes.map((node) => node.type)).toEqual([
      "trigger.form_submission",
      "form.input",
      "task.approval",
      "condition.branch",
      "action.object_update",
      "action.notification",
      "action.audit_append",
      "end.state",
      "action.object_update",
      "action.notification",
      "action.audit_append",
      "end.state",
    ]);
    expect(validateWorkflowDefinition(definition)).toEqual([]);

    const flow = canonicalToReactFlow(definition);
    const trigger = flow.nodes.find((node) => node.id === "node-trigger");
    expect(trigger?.position).toEqual({ x: 80, y: 120 });
    expect(flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge-condition-approved-update",
          source: "node-condition",
          target: "node-approved-update",
          sourceHandle: "approved",
          targetHandle: "in",
          label: "Approved",
        }),
      ]),
    );

    const moved = reactFlowLayoutToCanvas(definition, {
      nodes: flow.nodes.map((node) =>
        node.id === "node-trigger"
          ? { ...node, position: { x: 120, y: 160 } }
          : node,
      ),
      edges: flow.edges,
    });
    expect(moved.canvas.nodes["node-trigger"]).toEqual({ x: 120, y: 160 });
    expect(moved.graph.nodes[0]?.id).toBe("node-trigger");
  });

  it("builds a canonical approval template whose object-type-bound configs match the target object type", () => {
    const definition = createCanonicalApprovalTemplate({
      name: "정비 완료 승인",
      objectType: "work_order",
    });

    expect(validateWorkflowDefinition(definition)).toEqual([]);
    expect(definition.metadata.object_type).toBe("work_order");

    const trigger = definition.graph.nodes.find((node) => node.id === "node-trigger");
    expect(
      trigger?.config.type === "trigger.form_submission" &&
        trigger.config.source.object_type,
    ).toBe("work_order");

    const form = definition.graph.nodes.find((node) => node.id === "node-form");
    expect(
      form?.config.type === "form.input" &&
        form.config.fields.every(
          (field) =>
            field.field_type !== "object_ref" ||
            field.object_type === "work_order",
        ),
    ).toBe(true);

    for (const node of definition.graph.nodes) {
      if (node.config.type === "action.object_update") {
        expect(node.config.action_id).toBe("work_order.update_status");
        expect(node.config.requires_policy).toBe("work_order.update_status");
      }
    }
  });

  it("reports actionable validation blockers for incomplete visual drafts", () => {
    const definition = createEmptyWorkflowDefinition({
      name: "Incomplete workflow",
      objectType: "leave_request",
    });
    definition.graph.nodes.push(createWorkflowNode("trigger.form_submission"));

    expect(validateWorkflowDefinition(definition)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_terminal",
          severity: "error",
          message: "At least one end state node is required.",
        }),
        expect.objectContaining({
          code: "unconnected_output",
          nodeId: "node-trigger",
        }),
      ]),
    );
  });

  it("rejects drafts whose metadata object type diverges from the canonical trigger source", () => {
    const definition = createLeaveRequestApprovalTemplate({
      name: "휴가 신청 승인",
      objectType: "leave_request",
    });
    definition.metadata.object_type = "work_order";

    expect(validateWorkflowDefinition(definition)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "object_type_mismatch",
          severity: "error",
          message:
            "Workflow metadata object type must match the form submission trigger source.",
          nodeId: "node-trigger",
        }),
      ]),
    );
  });
});
