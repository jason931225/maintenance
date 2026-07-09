import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  GitBranch,
  History,
  PauseCircle,
  Pencil,
  PlugZap,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type {
  WorkflowConnectorDescriptor,
  WorkflowDefinitionEventResponse,
  WorkflowDefinitionResponse,
  WorkflowStudioCatalogResponse,
  WorkflowTemplateDescriptor,
} from "../api/types";
import { assertPasskeyStepUp } from "../auth/webauthn";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { formatKoreanDateTime } from "../lib/datetime";
import {
  WORKFLOW_NODE_DESCRIPTORS,
  addNodeToWorkflow,
  canonicalToReactFlow,
  connectWorkflowNodes,
  createEmptyWorkflowDefinition,
  createLeaveRequestApprovalTemplate,
  isWorkflowDefinitionV1,
  toggleApprovalPasskey,
  updateApprovalFallbackRole,
  updateApprovalSla,
  validateWorkflowDefinition,
  withValidationResult,
  type WorkflowDefinitionV1,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowValidationFinding,
} from "../features/workflow-canvas/model";

type ReadState = "loading" | "idle" | "error";
type FeedbackKind = "success" | "error";
type DefinitionMode = "canvas" | "fixed-template";
type DraftForm = {
  workflowKey: string;
  displayName: string;
  objectType: string;
  definitionJson: string;
  approvalLineJson: string;
  paymentLineJson: string;
  notificationRulesJson: string;
  actionAllowlistJson: string;
  requiredApprovalLine: boolean;
  requiredPaymentLine: boolean;
};

const EMPTY_CATALOG: WorkflowStudioCatalogResponse = {
  connectors: [],
  templates: [],
};

const DEFAULT_DRAFT_FORM: DraftForm = {
  workflowKey: "leave_request.approval",
  displayName: ko.workflowStudio.canvas.defaultCanvasName,
  objectType: "leave_request",
  definitionJson: JSON.stringify(
    {
      trigger: "work_order.completed",
      steps: [
        { key: "review", type: "approval", source: "approval_line" },
        { key: "notify", type: "notification", channel: "push" },
      ],
    },
    null,
    2,
  ),
  approvalLineJson: JSON.stringify(
    [{ step_key: "manager", approver_role: "MANAGER", required: true }],
    null,
    2,
  ),
  paymentLineJson: "[]",
  notificationRulesJson: JSON.stringify(
    [
      {
        event: "approved",
        connector_key: "internal.notifications",
        action_key: "send_push",
      },
    ],
    null,
    2,
  ),
  actionAllowlistJson: JSON.stringify(
    [
      { connector_key: "internal.approvals", action_key: "request_approval" },
      { connector_key: "internal.notifications", action_key: "send_push" },
      { connector_key: "internal.audit", action_key: "append_timeline_event" },
    ],
    null,
    2,
  ),
  requiredApprovalLine: true,
  requiredPaymentLine: false,
};

function createDefaultCanvasDefinition(): WorkflowDefinitionV1 {
  return createEmptyWorkflowDefinition({
    name: ko.workflowStudio.canvas.defaultCanvasName,
    objectType: "leave_request",
  });
}

function createLeaveApprovalDraftForm(): DraftForm {
  return {
    ...DEFAULT_DRAFT_FORM,
    workflowKey: "leave_request.approval",
    displayName: ko.workflowStudio.canvas.defaultCanvasName,
    objectType: "leave_request",
    definitionJson: JSON.stringify(
      createLeaveRequestApprovalTemplate({
        name: ko.workflowStudio.canvas.defaultCanvasName,
        objectType: "leave_request",
      }),
      null,
      2,
    ),
    approvalLineJson: JSON.stringify(
      [{ step_key: "manager", approver_role: "MANAGER", required: true }],
      null,
      2,
    ),
    paymentLineJson: "[]",
    requiredApprovalLine: true,
    requiredPaymentLine: false,
  };
}

const POLICY_TEMPLATE_KEY = "equipment_location_access_policy";

function workflowTemplateDefinition(
  template: WorkflowTemplateDescriptor,
): Record<string, unknown> {
  return {
    schema_version: "workflow.definition.v1",
    template_key: template.template_key,
    object_type: template.object_type,
    trigger: `${template.object_type}.${template.template_key}`,
    steps: [{ key: "review", type: "approval", source: "approval_line" }],
  };
}

function equipmentLocationPolicyDefinition(): Record<string, unknown> {
  return {
    schema_version: "workflow.definition.v1",
    trigger: "workflow.policy_simulation_requested",
    policy_decision: {
      template_key: "equipment_location_access",
      effect: "allow",
      action: "maintenance:StartWorkOrder",
      resource: { type: "equipment", id: "EQ-BOILER-17" },
      context: {
        org_id: "org_demo_001",
        location_id: "loc_plant_2",
        subject_role: "MAINTENANCE_MANAGER",
        passkey_step_up_satisfied: true,
      },
      scope: {
        org_id: "org_demo_001",
        location_id: "loc_plant_2",
      },
      requirements: {
        passkey_step_up: true,
        audit_event: "workflow_definition.publish",
      },
    },
  };
}

export function WorkflowStudioPage() {
  const { api } = useAuth();
  const [readState, setReadState] = useState<ReadState>("loading");
  const [catalog, setCatalog] =
    useState<WorkflowStudioCatalogResponse>(EMPTY_CATALOG);
  const [definitions, setDefinitions] = useState<WorkflowDefinitionResponse[]>(
    [],
  );
  const [history, setHistory] = useState<WorkflowDefinitionEventResponse[]>([]);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string>();
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind>("success");
  const [busyDefinitionId, setBusyDefinitionId] = useState<string>();
  const [draftForm, setDraftForm] = useState<DraftForm>(DEFAULT_DRAFT_FORM);
  const [editingDefinitionId, setEditingDefinitionId] = useState<string>();
  const [definitionMode, setDefinitionMode] = useState<DefinitionMode>("canvas");
  const [canvasDefinition, setCanvasDefinition] =
    useState<WorkflowDefinitionV1>(createDefaultCanvasDefinition);
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<string>();
  const [connectionSourceId, setConnectionSourceId] = useState<string>("");
  const [connectionSourcePort, setConnectionSourcePort] = useState<string>("");
  const [connectionTargetId, setConnectionTargetId] = useState<string>("");
  const [connectionTargetPort, setConnectionTargetPort] = useState<string>("");
  const [connectionError, setConnectionError] = useState<string>();
  const [creatingDraft, setCreatingDraft] = useState(false);

  const selectedDefinition = useMemo(
    () =>
      definitions.find(
        (definition) => definition.id === selectedDefinitionId,
      ) ?? definitions[0],
    [definitions, selectedDefinitionId],
  );

  const canvasFindings = useMemo(
    () =>
      definitionMode === "canvas"
        ? validateWorkflowDefinition(canvasDefinition)
        : [],
    [canvasDefinition, definitionMode],
  );
  const canvasHasBlockers = canvasFindings.some(
    (finding) => finding.severity === "error",
  );

  const loadHistory = useCallback(
    async (definitionId: string | undefined) => {
      if (!definitionId) {
        setHistory([]);
        return;
      }
      const response = await api.GET(
        "/api/v1/workflow-studio/definitions/{id}/history",
        { params: { path: { id: definitionId } } },
      );
      if (!response.data) throw new Error("workflow history load failed");
      setHistory(response.data.items);
    },
    [api],
  );

  const loadHistoryNonCritical = useCallback(
    async (definitionId: string | undefined) => {
      try {
        await loadHistory(definitionId);
      } catch {
        setHistory([]);
      }
    },
    [loadHistory],
  );


  const loadCanvasDefinition = useCallback(
    (
      definition: WorkflowDefinitionResponse | undefined,
      options: { syncDraftForm?: boolean } = {},
    ) => {
      if (!definition) {
        return;
      }
      const rawDefinition = definition.definition;
      const isCanvasDefinition = isWorkflowDefinitionV1(rawDefinition);
      if (!isCanvasDefinition && !options.syncDraftForm) {
        return;
      }
      const loaded = isCanvasDefinition
        ? withValidationResult(rawDefinition)
        : createEmptyWorkflowDefinition({
            name: definition.display_name,
            objectType: definition.object_type,
          });
      setDefinitionMode(
        isCanvasDefinition ? "canvas" : "fixed-template",
      );
      setCanvasDefinition(loaded);
      if (options.syncDraftForm || isCanvasDefinition) {
        setDraftForm((current) => ({
          ...current,
          workflowKey: definition.workflow_key,
          displayName: definition.display_name,
          objectType: definition.object_type,
          definitionJson: JSON.stringify(definition.definition, null, 2),
          requiredApprovalLine: definition.required_approval_line,
          requiredPaymentLine: definition.required_payment_line,
          approvalLineJson: JSON.stringify(definition.approval_line, null, 2),
          paymentLineJson: JSON.stringify(definition.payment_line, null, 2),
          notificationRulesJson: JSON.stringify(
            definition.notification_rules,
            null,
            2,
          ),
          actionAllowlistJson: JSON.stringify(
            definition.action_allowlist,
            null,
            2,
          ),
        }));
      }
      const sourceNode = loaded.graph.nodes.at(0);
      const targetNode = loaded.graph.nodes.at(1);
      setSelectedCanvasNodeId(sourceNode?.id);
      setConnectionSourceId(sourceNode?.id ?? "");
      setConnectionSourcePort(sourceNode?.output_ports.at(0)?.key ?? "");
      setConnectionTargetId(targetNode?.id ?? "");
      setConnectionTargetPort(targetNode?.input_ports.at(0)?.key ?? "");
    },
    [],
  );

  const load = useCallback(async () => {
    setReadState("loading");
    setError(undefined);
    try {
      const [catalogResponse, definitionsResponse] = await Promise.all([
        api.GET("/api/v1/workflow-studio/catalog"),
        api.GET("/api/v1/workflow-studio/definitions"),
      ]);
      if (!catalogResponse.data || !definitionsResponse.data) {
        throw new Error("workflow studio load failed");
      }
      setCatalog(catalogResponse.data);
      setDefinitions(definitionsResponse.data.items);
      const selectedItem =
        definitionsResponse.data.items.find(
          (definition) => definition.id === selectedDefinitionId,
        ) ?? definitionsResponse.data.items.at(0);
      setSelectedDefinitionId(selectedItem?.id);
      loadCanvasDefinition(selectedItem);
      await loadHistoryNonCritical(selectedItem?.id);
      setReadState("idle");
    } catch {
      setReadState("error");
      setError(ko.workflowStudio.loadFailed);
    }
  }, [api, loadCanvasDefinition, loadHistoryNonCritical, selectedDefinitionId]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(task);
    };
  }, [load]);


  async function selectDefinition(definition: WorkflowDefinitionResponse) {
    setSelectedDefinitionId(definition.id);
    loadCanvasDefinition(definition);
    try {
      await loadHistory(definition.id);
    } catch {
      showError(ko.workflowStudio.actionFailed);
    }
  }

  async function createDraft() {
    if (canvasHasBlockers) {
      showError(ko.workflowStudio.canvas.fixValidationBeforeSave);
      return;
    }
    setCreatingDraft(true);
    setFeedback(undefined);
    try {
      const definitionForSave =
        definitionMode === "canvas"
          ? withValidationResult({
              ...canvasDefinition,
              metadata: {
                ...canvasDefinition.metadata,
                name: draftForm.displayName,
                object_type: draftForm.objectType,
              },
            })
          : parseJsonObject(draftForm.definitionJson);
      if (definitionMode === "canvas") {
        const validationErrors = validateWorkflowDefinition(
          definitionForSave as WorkflowDefinitionV1,
        ).some((finding) => finding.severity === "error");
        if (validationErrors) {
          setCanvasDefinition(definitionForSave as WorkflowDefinitionV1);
          showError(ko.workflowStudio.canvas.fixValidationBeforeSave);
          return;
        }
      }
      const payload = {
        display_name: draftForm.displayName,
        definition: definitionForSave,
        approval_line: parseJsonArray(draftForm.approvalLineJson),
        payment_line: parseJsonArray(draftForm.paymentLineJson),
        notification_rules: parseJsonArray(draftForm.notificationRulesJson),
        action_allowlist: parseActionAllowlist(draftForm.actionAllowlistJson),
        required_approval_line: draftForm.requiredApprovalLine,
        required_payment_line: draftForm.requiredPaymentLine,
      };
      if (editingDefinitionId) {
        const response = await api.PATCH(
          "/api/v1/workflow-studio/definitions/{id}",
          {
            params: { path: { id: editingDefinitionId } },
            body: payload,
          },
        );
        if (!response.data) throw new Error("workflow draft update failed");
        const updated = response.data;
        setDefinitions((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
        setSelectedDefinitionId(updated.id);
        setEditingDefinitionId(undefined);
        loadCanvasDefinition(updated);
        await loadHistoryNonCritical(updated.id);
        showSuccess(ko.workflowStudio.updateSuccess);
      } else {
        const response = await api.POST("/api/v1/workflow-studio/definitions", {
          body: {
            workflow_key: draftForm.workflowKey,
            object_type: draftForm.objectType,
            ...payload,
          },
        });
        if (!response.data) throw new Error("workflow draft create failed");
        const created = response.data;
        setDefinitions((items) => [created, ...items]);
        setSelectedDefinitionId(created.id);
        loadCanvasDefinition(created);
        await loadHistoryNonCritical(created.id);
        showSuccess(ko.workflowStudio.createSuccess);
      }
    } catch {
      showError(ko.workflowStudio.createFailed);
    } finally {
      setCreatingDraft(false);
    }
  }

  async function startEditingDefinition(definition: WorkflowDefinitionResponse) {
    if (definition.status !== "DRAFT") return;
    setEditingDefinitionId(definition.id);
    setSelectedDefinitionId(definition.id);
    loadCanvasDefinition(definition, { syncDraftForm: true });
    try {
      await loadHistory(definition.id);
    } catch {
      showError(ko.workflowStudio.actionFailed);
    }
  }

  function cancelEditingDefinition() {
    setEditingDefinitionId(undefined);
    const blank = createDefaultCanvasDefinition();
    setDefinitionMode("canvas");
    setDraftForm(DEFAULT_DRAFT_FORM);
    setCanvasDefinition(blank);
    setSelectedCanvasNodeId(undefined);
    setConnectionSourceId("");
    setConnectionSourcePort("");
    setConnectionTargetId("");
    setConnectionTargetPort("");
    setConnectionError(undefined);
  }

  async function publishDefinition(definition: WorkflowDefinitionResponse) {
    setFeedback(undefined);
    if (
      isWorkflowDefinitionV1(definition.definition) &&
      validateWorkflowDefinition(definition.definition).some(
        (finding) => finding.severity === "error",
      )
    ) {
      showError(ko.workflowStudio.canvas.publishBlocked);
      return;
    }
    if (missingRequiredLines(definition)) {
      showError(ko.workflowStudio.publishBlocked);
      return;
    }
    await sensitiveDefinitionAction(definition, "publish", async (stepUp) => {
      const response = await api.POST(
        "/api/v1/workflow-studio/definitions/{id}/publish",
        {
          params: { path: { id: definition.id } },
          body: { step_up: stepUp },
        },
      );
      if (!response.data) throw new Error("workflow publish failed");
      return response.data;
    });
  }

  async function pauseDefinition(definition: WorkflowDefinitionResponse) {
    await sensitiveDefinitionAction(definition, "pause", async (stepUp) => {
      const response = await api.POST(
        "/api/v1/workflow-studio/definitions/{id}/pause",
        {
          params: { path: { id: definition.id } },
          body: { step_up: stepUp },
        },
      );
      if (!response.data) throw new Error("workflow pause failed");
      return response.data;
    });
  }

  async function rollbackDefinition(definition: WorkflowDefinitionResponse) {
    await sensitiveDefinitionAction(definition, "rollback", async (stepUp) => {
      const targetVersion = definition.active_version ?? 1;
      const response = await api.POST(
        "/api/v1/workflow-studio/definitions/{id}/rollback",
        {
          params: { path: { id: definition.id } },
          body: { target_version: targetVersion, step_up: stepUp },
        },
      );
      if (!response.data) throw new Error("workflow rollback failed");
      return response.data;
    });
  }

  async function cloneDefinition(definition: WorkflowDefinitionResponse) {
    await sensitiveDefinitionAction(definition, "clone", async (stepUp) => {
      const response = await api.POST(
        "/api/v1/workflow-studio/definitions/{id}/clone",
        {
          params: { path: { id: definition.id } },
          body: {
            workflow_key: `${definition.workflow_key}.copy_${Date.now().toString(36)}`,
            display_name: `${definition.display_name} ${ko.workflowStudio.cloneSuffix}`,
            step_up: stepUp,
          },
        },
      );
      if (!response.data) throw new Error("workflow clone failed");
      const cloned = response.data;
      setDefinitions((items) => [cloned, ...items]);
      return cloned;
    });
  }

  async function archiveDefinition(definition: WorkflowDefinitionResponse) {
    if (!window.confirm(ko.workflowStudio.archiveConfirm)) return;
    await sensitiveDefinitionAction(definition, "archive", async (stepUp) => {
      const response = await api.DELETE(
        "/api/v1/workflow-studio/definitions/{id}",
        {
          params: { path: { id: definition.id } },
          body: { step_up: stepUp },
        },
      );
      if (!response.data) throw new Error("workflow archive failed");
      return response.data;
    });
  }

  async function sensitiveDefinitionAction(
    definition: WorkflowDefinitionResponse,
    action: "publish" | "pause" | "rollback" | "clone" | "archive",
    request: (
      stepUp: Awaited<ReturnType<typeof assertPasskeyStepUp>>,
    ) => Promise<WorkflowDefinitionResponse>,
  ) {
    setBusyDefinitionId(definition.id);
    setFeedback(undefined);
    try {
      const stepUp = await assertPasskeyStepUp(api);
      const updated = await request(stepUp);
      if (action === "archive") {
        const remainingDefinitions = definitions.filter(
          (item) => item.id !== definition.id,
        );
        const nextSelected =
          remainingDefinitions.find((item) => item.id === selectedDefinitionId)
            ?.id ?? remainingDefinitions[0]?.id;
        setDefinitions(remainingDefinitions);
        setSelectedDefinitionId(nextSelected);
        await loadHistory(nextSelected);
        if (editingDefinitionId === definition.id) {
          cancelEditingDefinition();
        }
        showSuccess(ko.workflowStudio.success.archive);
        return;
      }
      setDefinitions((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      setSelectedDefinitionId(updated.id);
      await loadHistory(updated.id);
      showSuccess(ko.workflowStudio.success[action]);
    } catch {
      showError(ko.workflowStudio.actionFailed);
    } finally {
      setBusyDefinitionId(undefined);
    }
  }

  async function simulateDefinition(definition: WorkflowDefinitionResponse) {
    setBusyDefinitionId(definition.id);
    setFeedback(undefined);
    try {
      const response = await api.POST(
        "/api/v1/workflow-studio/definitions/{id}/simulate",
        {
          params: { path: { id: definition.id } },
          body: {},
        },
      );
      if (!response.data) throw new Error("workflow simulation failed");
      setFeedbackKind(response.data.decision === "ready" ? "success" : "error");
      setFeedback(
        response.data.decision === "ready"
          ? ko.workflowStudio.simulationReady
          : response.data.findings
              .map((finding) => finding.message)
              .join(" · "),
      );
    } catch {
      showError(ko.workflowStudio.actionFailed);
    } finally {
      setBusyDefinitionId(undefined);
    }
  }

  function applyTemplate(template: WorkflowTemplateDescriptor) {
    const isPolicyTemplate = template.template_key === POLICY_TEMPLATE_KEY;
    const nextDefinition = createEmptyWorkflowDefinition({
      name: template.display_name,
      objectType: template.object_type,
    });
    const fixedTemplateDefinition = isPolicyTemplate
      ? equipmentLocationPolicyDefinition()
      : workflowTemplateDefinition(template);
    setEditingDefinitionId(undefined);
    setDefinitionMode("fixed-template");
    setCanvasDefinition(nextDefinition);
    setSelectedCanvasNodeId(undefined);
    setConnectionSourceId("");
    setConnectionSourcePort("");
    setConnectionTargetId("");
    setConnectionTargetPort("");
    setConnectionError(undefined);
    setDraftForm((current) => ({
      ...current,
      workflowKey: `${template.object_type}.${template.template_key}`,
      displayName: template.display_name,
      objectType: template.object_type,
      definitionJson: JSON.stringify(
        fixedTemplateDefinition,
        null,
        2,
      ),
      requiredApprovalLine: template.required_approval_line,
      requiredPaymentLine: template.required_payment_line,
      approvalLineJson: isPolicyTemplate
        ? JSON.stringify(
            [
              {
                step_key: "policy_owner",
                approver_role: "MAINTENANCE_MANAGER",
                required: true,
              },
            ],
            null,
            2,
          )
        : template.required_approval_line
          ? DEFAULT_DRAFT_FORM.approvalLineJson
          : "[]",
      paymentLineJson: template.required_payment_line
        ? JSON.stringify(
            [{ step_key: "finance", approver_role: "FINANCE", required: true }],
            null,
            2,
          )
        : "[]",
      actionAllowlistJson: isPolicyTemplate
        ? JSON.stringify(
            [
              {
                connector_key: "internal.audit",
                action_key: "append_timeline_event",
              },
            ],
            null,
            2,
          )
        : DEFAULT_DRAFT_FORM.actionAllowlistJson,
      notificationRulesJson: isPolicyTemplate
        ? "[]"
        : DEFAULT_DRAFT_FORM.notificationRulesJson,
    }));
  }

  function applyLeaveRequestTemplate() {
    const nextDefinition = createLeaveRequestApprovalTemplate({
      name: ko.workflowStudio.canvas.defaultCanvasName,
      objectType: "leave_request",
    });
    setEditingDefinitionId(undefined);
    setDefinitionMode("canvas");
    setDraftForm(createLeaveApprovalDraftForm());
    setCanvasDefinition(nextDefinition);
    setSelectedCanvasNodeId("node-approval");
    const sourceNode = nextDefinition.graph.nodes[0];
    const targetNode = nextDefinition.graph.nodes[1];
    setConnectionSourceId(sourceNode.id);
    setConnectionSourcePort(sourceNode.output_ports.at(0)?.key ?? "");
    setConnectionTargetId(targetNode.id);
    setConnectionTargetPort(targetNode.input_ports.at(0)?.key ?? "");
    setConnectionError(undefined);
    showSuccess(ko.workflowStudio.canvas.templateApplied);
  }

  function startBlankCanvas() {
    const blank = createDefaultCanvasDefinition();
    setEditingDefinitionId(undefined);
    setDefinitionMode("canvas");
    setDraftForm(DEFAULT_DRAFT_FORM);
    setCanvasDefinition(blank);
    setSelectedCanvasNodeId(undefined);
    setConnectionSourceId("");
    setConnectionSourcePort("");
    setConnectionTargetId("");
    setConnectionTargetPort("");
    setConnectionError(undefined);
  }

  function addCanvasNode(type: WorkflowNodeType) {
    setDefinitionMode("canvas");
    setCanvasDefinition((currentDefinition) => {
      const nextDefinition = addNodeToWorkflow(currentDefinition, type);
      const addedNode = nextDefinition.graph.nodes.at(-1);
      setSelectedCanvasNodeId(addedNode?.id);
      setConnectionSourceId((current) => current || addedNode?.id || "");
      setConnectionSourcePort(
        (current) => current || addedNode?.output_ports.at(0)?.key || "",
      );
      setConnectionTargetId((current) => current || addedNode?.id || "");
      setConnectionTargetPort(
        (current) => current || addedNode?.input_ports.at(0)?.key || "",
      );
      return nextDefinition;
    });
    setConnectionError(undefined);
  }

  function changeConnectionSource(nodeId: string) {
    const source = canvasDefinition.graph.nodes.find((node) => node.id === nodeId);
    setConnectionSourceId(nodeId);
    setConnectionSourcePort(source?.output_ports.at(0)?.key ?? "");
  }

  function changeConnectionTarget(nodeId: string) {
    const target = canvasDefinition.graph.nodes.find((node) => node.id === nodeId);
    setConnectionTargetId(nodeId);
    setConnectionTargetPort(target?.input_ports.at(0)?.key ?? "");
  }

  function addCanvasConnection() {
    const source = canvasDefinition.graph.nodes.find(
      (node) => node.id === connectionSourceId,
    );
    const target = canvasDefinition.graph.nodes.find(
      (node) => node.id === connectionTargetId,
    );
    const result = connectWorkflowNodes(canvasDefinition, {
      fromNodeId: connectionSourceId,
      fromPort: connectionSourcePort || source?.output_ports[0]?.key || "",
      toNodeId: connectionTargetId,
      toPort: connectionTargetPort || target?.input_ports[0]?.key || "",
    });
    setCanvasDefinition(result.definition);
    setConnectionError(result.error);
  }

  function updateCanvasDefinition(nextDefinition: WorkflowDefinitionV1) {
    setDefinitionMode("canvas");
    setCanvasDefinition(nextDefinition);
    setDraftForm((current) => ({
      ...current,
      definitionJson: JSON.stringify(nextDefinition, null, 2),
    }));
  }

  function simulateCanvasDraft() {
    if (canvasHasBlockers) {
      showError(ko.workflowStudio.canvas.fixBeforeSimulate);
      return;
    }
    showSuccess(ko.workflowStudio.canvas.simulationPreview);
  }

  function showSuccess(message: string) {
    setFeedbackKind("success");
    setFeedback(message);
  }

  function showError(message: string) {
    setFeedbackKind("error");
    setFeedback(message);
  }

  return (
    <div>
      <PageHeader
        title={ko.workflowStudio.title}
        description={ko.workflowStudio.description}
        actions={
          <RefreshButton
            onClick={() => {
              void load();
            }}
            isLoading={readState === "loading"}
          />
        }
      />

      <FeedbackBanner
        message={feedback}
        kind={feedbackKind}
        onDismiss={() => {
          setFeedback(undefined);
        }}
        className="mb-4"
      />

      {readState === "error" ? (
        <PageError
          message={error}
          onRetry={() => {
            void load();
          }}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(24rem,1fr)]">
          <div className="grid min-w-0 gap-4">
            <Card className="min-w-0">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <GitBranch size={18} aria-hidden="true" />
                  <h2 className="text-lg font-semibold text-ink">
                    {ko.workflowStudio.definitions}
                  </h2>
                </div>
                <Badge>{String(definitions.length)}</Badge>
              </div>
              {readState === "loading" ? (
                <SkeletonTable rows={4} cols={6} />
              ) : definitions.length === 0 ? (
                <PageEmpty message={ko.workflowStudio.empty} />
              ) : (
                <WorkflowDefinitionTable
                  definitions={definitions}
                  selectedDefinitionId={selectedDefinition.id}
                  busyDefinitionId={busyDefinitionId}
                  onSelect={(definition) => void selectDefinition(definition)}
                  onSimulate={(definition) =>
                    void simulateDefinition(definition)
                  }
                  onPublish={(definition) => void publishDefinition(definition)}
                  onPause={(definition) => void pauseDefinition(definition)}
                  onRollback={(definition) =>
                    void rollbackDefinition(definition)
                  }
                  onClone={(definition) => void cloneDefinition(definition)}
                  onEdit={(definition) => void startEditingDefinition(definition)}
                  onArchive={(definition) => void archiveDefinition(definition)}
                />
              )}
            </Card>

            <WorkflowCanvasAuthoringCard
              catalog={catalog}
              draftForm={draftForm}
              canvasDefinition={canvasDefinition}
              findings={canvasFindings}
              selectedNodeId={selectedCanvasNodeId}
              connectionSourceId={connectionSourceId}
              connectionSourcePort={connectionSourcePort}
              connectionTargetId={connectionTargetId}
              connectionTargetPort={connectionTargetPort}
              connectionError={connectionError}
              editingDefinitionId={editingDefinitionId}
              definitionMode={definitionMode}
              creatingDraft={creatingDraft}
              hasBlockers={canvasHasBlockers}
              onChange={setDraftForm}
              onCanvasChange={updateCanvasDefinition}
              onApplyTemplate={applyTemplate}
              onApplyLeaveTemplate={applyLeaveRequestTemplate}
              onStartBlank={startBlankCanvas}
              onAddNode={addCanvasNode}
              onSelectNode={setSelectedCanvasNodeId}
              onConnectionSourceChange={changeConnectionSource}
              onConnectionSourcePortChange={setConnectionSourcePort}
              onConnectionTargetChange={changeConnectionTarget}
              onConnectionTargetPortChange={setConnectionTargetPort}
              onAddConnection={addCanvasConnection}
              onSimulate={simulateCanvasDraft}
              onSubmit={() => void createDraft()}
              onCancelEdit={cancelEditingDefinition}
            />
          </div>

          <div className="grid gap-4 self-start">
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <PlugZap size={18} aria-hidden="true" />
                <h2 className="text-lg font-semibold text-ink">
                  {ko.workflowStudio.connectors}
                </h2>
              </div>
              <div className="grid gap-2">
                {catalog.connectors.map((connector) => (
                  <ConnectorCard
                    key={connector.connector_key}
                    connector={connector}
                  />
                ))}
              </div>
            </Card>

            <Card>
              <div className="mb-3 flex items-center gap-2">
                <History size={18} aria-hidden="true" />
                <h2 className="text-lg font-semibold text-ink">
                  {ko.workflowStudio.history}
                </h2>
              </div>
              {history.length === 0 ? (
                <PageEmpty message={ko.workflowStudio.noHistory} />
              ) : (
                <ol className="space-y-3">
                  {history.map((event) => (
                    <li
                      key={event.id}
                      className="rounded-lg border border-line p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-ink">
                          {event.summary}
                        </span>
                        <Badge>
                          {ko.workflowStudio.version(event.version)}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-steel">
                        <span>
                          {event.actor_display_name ??
                            ko.workflowStudio.unknownActor}
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span>{formatKoreanDateTime(event.created_at)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowDefinitionTable({
  definitions,
  selectedDefinitionId,
  busyDefinitionId,
  onSelect,
  onSimulate,
  onPublish,
  onPause,
  onRollback,
  onClone,
  onEdit,
  onArchive,
}: {
  definitions: WorkflowDefinitionResponse[];
  selectedDefinitionId: string | undefined;
  busyDefinitionId: string | undefined;
  onSelect: (definition: WorkflowDefinitionResponse) => void;
  onSimulate: (definition: WorkflowDefinitionResponse) => void;
  onPublish: (definition: WorkflowDefinitionResponse) => void;
  onPause: (definition: WorkflowDefinitionResponse) => void;
  onRollback: (definition: WorkflowDefinitionResponse) => void;
  onClone: (definition: WorkflowDefinitionResponse) => void;
  onEdit: (definition: WorkflowDefinitionResponse) => void;
  onArchive: (definition: WorkflowDefinitionResponse) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[64rem] text-left text-sm">
        <thead className="border-b border-line text-xs font-semibold uppercase tracking-wide text-steel">
          <tr>
            <th className="px-3 py-2">{ko.workflowStudio.columns.name}</th>
            <th className="px-3 py-2">{ko.workflowStudio.columns.object}</th>
            <th className="px-3 py-2">{ko.workflowStudio.columns.status}</th>
            <th className="px-3 py-2">{ko.workflowStudio.columns.version}</th>
            <th className="px-3 py-2">{ko.workflowStudio.columns.lines}</th>
            <th className="px-3 py-2 text-right">
              {ko.workflowStudio.columns.actions}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {definitions.map((definition) => {
            const busy = busyDefinitionId === definition.id;
            return (
              <tr
                key={definition.id}
                className={
                  selectedDefinitionId === definition.id
                    ? "bg-signal/10"
                    : "bg-white"
                }
              >
                <td className="px-3 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(definition);
                    }}
                    className="text-left font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    {definition.display_name}
                  </button>
                  <p className="mt-1 text-xs text-steel">
                    {definition.workflow_key}
                  </p>
                </td>
                <td className="px-3 py-3 text-steel">
                  {definition.object_type}
                </td>
                <td className="px-3 py-3">
                  <Badge className={statusClass(definition.status)}>
                    {statusLabel(definition.status)}
                  </Badge>
                </td>
                <td className="px-3 py-3 text-steel">
                  <div>
                    {ko.workflowStudio.latestVersion(definition.latest_version)}
                  </div>
                  <div className="text-xs">
                    {ko.workflowStudio.activeVersion(definition.active_version)}
                  </div>
                </td>
                <td className="px-3 py-3 text-steel">
                  {ko.workflowStudio.lineSummary(
                    countArray(definition.approval_line),
                    countArray(definition.payment_line),
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {definition.required_approval_line ? (
                      <Badge>{ko.workflowStudio.requiredApproval}</Badge>
                    ) : null}
                    {definition.required_payment_line ? (
                      <Badge>{ko.workflowStudio.requiredPayment}</Badge>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      disabled={busy}
                      onClick={() => {
                        onSimulate(definition);
                      }}
                    >
                      {ko.workflowStudio.simulate}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={busy}
                      onClick={() => {
                        onPublish(definition);
                      }}
                    >
                      {ko.workflowStudio.publish}
                    </Button>
                    <IconActionButton
                      label={ko.workflowStudio.pause}
                      icon={<PauseCircle size={14} aria-hidden="true" />}
                      disabled={busy || definition.status !== "ACTIVE"}
                      onClick={() => {
                        onPause(definition);
                      }}
                    />
                    <IconActionButton
                      label={ko.workflowStudio.rollback}
                      icon={<RotateCcw size={14} aria-hidden="true" />}
                      disabled={busy || definition.latest_version < 2}
                      onClick={() => {
                        onRollback(definition);
                      }}
                    />
                    <IconActionButton
                      label={ko.workflowStudio.clone}
                      icon={<Copy size={14} aria-hidden="true" />}
                      disabled={busy}
                      onClick={() => {
                        onClone(definition);
                      }}
                    />
                    <IconActionButton
                      label={ko.workflowStudio.edit}
                      icon={<Pencil size={14} aria-hidden="true" />}
                      disabled={busy || definition.status !== "DRAFT"}
                      onClick={() => {
                        onEdit(definition);
                      }}
                    />
                    <IconActionButton
                      label={ko.workflowStudio.delete}
                      icon={<Trash2 size={14} aria-hidden="true" />}
                      disabled={busy || definition.status !== "DRAFT"}
                      onClick={() => {
                        onArchive(definition);
                      }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WorkflowCanvasAuthoringCard({
  catalog,
  draftForm,
  canvasDefinition,
  findings,
  selectedNodeId,
  connectionSourceId,
  connectionSourcePort,
  connectionTargetId,
  connectionTargetPort,
  connectionError,
  editingDefinitionId,
  definitionMode,
  creatingDraft,
  hasBlockers,
  onChange,
  onCanvasChange,
  onApplyTemplate,
  onApplyLeaveTemplate,
  onStartBlank,
  onAddNode,
  onSelectNode,
  onConnectionSourceChange,
  onConnectionSourcePortChange,
  onConnectionTargetChange,
  onConnectionTargetPortChange,
  onAddConnection,
  onSimulate,
  onSubmit,
  onCancelEdit,
}: {
  catalog: WorkflowStudioCatalogResponse;
  draftForm: DraftForm;
  canvasDefinition: WorkflowDefinitionV1;
  findings: WorkflowValidationFinding[];
  selectedNodeId: string | undefined;
  connectionSourceId: string;
  connectionSourcePort: string;
  connectionTargetId: string;
  connectionTargetPort: string;
  connectionError: string | undefined;
  editingDefinitionId: string | undefined;
  definitionMode: DefinitionMode;
  creatingDraft: boolean;
  hasBlockers: boolean;
  onChange: (form: DraftForm) => void;
  onCanvasChange: (definition: WorkflowDefinitionV1) => void;
  onApplyTemplate: (template: WorkflowTemplateDescriptor) => void;
  onApplyLeaveTemplate: () => void;
  onStartBlank: () => void;
  onAddNode: (type: WorkflowNodeType) => void;
  onSelectNode: (nodeId: string) => void;
  onConnectionSourceChange: (nodeId: string) => void;
  onConnectionSourcePortChange: (port: string) => void;
  onConnectionTargetChange: (nodeId: string) => void;
  onConnectionTargetPortChange: (port: string) => void;
  onAddConnection: () => void;
  onSimulate: () => void;
  onSubmit: () => void;
  onCancelEdit: () => void;
}) {
  const blockingCount = findings.filter((finding) => finding.severity === "error").length;
  const isEditing = Boolean(editingDefinitionId);
  const isFixedTemplate = definitionMode === "fixed-template";
  const selectedNode = canvasDefinition.graph.nodes.find(
    (node) => node.id === selectedNodeId,
  );
  const connectionSourceNode = canvasDefinition.graph.nodes.find(
    (node) => node.id === connectionSourceId,
  );
  const connectionTargetNode = canvasDefinition.graph.nodes.find(
    (node) => node.id === connectionTargetId,
  );
  const flow = canonicalToReactFlow(canvasDefinition);
  const setField = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => {
    onChange({ ...draftForm, [key]: value });
  };

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {blockingCount === 0 ? (
              <CheckCircle2 size={18} className="text-brand-teal" aria-hidden="true" />
            ) : (
              <AlertTriangle size={18} className="text-amber-600" aria-hidden="true" />
            )}
            <h2 className="text-lg font-semibold text-ink">
              {isEditing
                ? ko.workflowStudio.authoring.editTitle
                : ko.workflowStudio.canvas.title}
            </h2>
          </div>
          <p className="mt-1 text-sm text-steel">
            {ko.workflowStudio.canvas.help}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {isEditing ? (
            <Button type="button" variant="secondary" onClick={onCancelEdit}>
              {ko.workflowStudio.authoring.cancelEdit}
            </Button>
          ) : null}
          <Badge className={blockingCount === 0 ? "border-brand-teal/30 bg-brand-teal/10 text-brand-teal" : "border-amber-200 bg-amber-50 text-amber-700"}>
            {ko.workflowStudio.canvas.blockerSummary(blockingCount)}
          </Badge>
          <Button type="button" variant="secondary" onClick={onSimulate}>
            {ko.workflowStudio.simulate}
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={creatingDraft || hasBlockers}
            title={hasBlockers ? ko.workflowStudio.canvas.fixValidationBeforeSave : undefined}
          >
            {isEditing
              ? ko.workflowStudio.authoring.update
              : ko.workflowStudio.authoring.create}
          </Button>
        </div>
      </div>

      {isFixedTemplate ? (
        <FeedbackBanner
          kind="success"
          message={ko.workflowStudio.canvas.generatedDefinition}
        />
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={onApplyLeaveTemplate}>
          {ko.workflowStudio.canvas.useLeaveTemplate}
        </Button>
        <Button type="button" variant="secondary" onClick={onStartBlank}>
          {ko.workflowStudio.canvas.startBlank}
        </Button>
        {catalog.templates.map((template) => (
          <Button
            key={template.template_key}
            type="button"
            size="xs"
            variant="secondary"
            onClick={() => {
              onApplyTemplate(template);
            }}
          >
            {template.display_name}
          </Button>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field
          label={ko.workflowStudio.authoring.workflowKey}
          value={draftForm.workflowKey}
          disabled={isEditing}
          onChange={(value) => {
            setField("workflowKey", value);
          }}
        />
        <Field
          label={ko.workflowStudio.authoring.displayName}
          value={draftForm.displayName}
          onChange={(value) => {
            setField("displayName", value);
          }}
        />
        <Field
          label={ko.workflowStudio.authoring.objectType}
          value={draftForm.objectType}
          disabled={isEditing}
          onChange={(value) => {
            setField("objectType", value);
          }}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-sm text-steel">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={draftForm.requiredApprovalLine}
            onChange={(event) => {
              setField("requiredApprovalLine", event.currentTarget.checked);
            }}
          />
          {ko.workflowStudio.requiredApproval}
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={draftForm.requiredPaymentLine}
            onChange={(event) => {
              setField("requiredPaymentLine", event.currentTarget.checked);
            }}
          />
          {ko.workflowStudio.requiredPayment}
        </label>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[16rem_minmax(0,1fr)_20rem]">
        <section className="rounded-lg border border-line bg-muted-panel/40 p-3" aria-labelledby="workflow-node-palette-heading">
          <h3 id="workflow-node-palette-heading" className="font-semibold text-ink">
            {ko.workflowStudio.canvas.palette}
          </h3>
          <div className="mt-3 grid gap-2">
            {WORKFLOW_NODE_DESCRIPTORS.map((descriptor) => (
              <button
                key={descriptor.type}
                type="button"
                aria-label={ko.workflowStudio.canvas.addNodeAria(descriptor.label)}
                onClick={() => {
                  onAddNode(descriptor.type);
                }}
                className="rounded-lg border border-line bg-white p-3 text-left text-sm hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                <span className="block font-semibold text-ink">{descriptor.label}</span>
                <span className="mt-1 block text-xs text-steel">{descriptor.group}</span>
                <span className="mt-1 block text-xs text-steel">{descriptor.purpose}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-line bg-white p-3" aria-labelledby="workflow-canvas-board-heading">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 id="workflow-canvas-board-heading" className="font-semibold text-ink">
              {ko.workflowStudio.canvas.board}
            </h3>
            <Badge>{ko.workflowStudio.version(canvasDefinition.graph.nodes.length)}</Badge>
          </div>
          {canvasDefinition.graph.nodes.length === 0 ? (
            <PageEmpty message={ko.workflowStudio.canvas.emptyCanvas} />
          ) : (
            <div className="min-h-72 overflow-x-auto rounded-lg border border-dashed border-line bg-muted-panel/30 p-4">
              <div className="grid min-w-[42rem] gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {flow.nodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => {
                      onSelectNode(node.id);
                    }}
                    className={
                      selectedNodeId === node.id
                        ? "rounded-xl border-2 border-ink bg-white p-3 text-left shadow-sm"
                        : "rounded-xl border border-line bg-white p-3 text-left shadow-sm hover:border-ink"
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-ink">{node.data.label}</span>
                      <Badge className={node.data.validationStatus === "valid" ? "border-brand-teal/30 bg-brand-teal/10 text-brand-teal" : "border-amber-200 bg-amber-50 text-amber-700"}>
                        {node.data.validationStatus === "valid"
                          ? ko.workflowStudio.canvas.nodeValid
                          : ko.workflowStudio.canvas.nodeInvalid}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-steel">{node.data.type}</p>
                    <p className="mt-2 text-sm text-steel">{node.data.summary}</p>
                  </button>
                ))}
              </div>
              <div className="mt-4 rounded-lg bg-white/80 p-3 text-sm">
                <h4 className="font-semibold text-ink">{ko.workflowStudio.canvas.edgeList}</h4>
                {canvasDefinition.graph.edges.length === 0 ? (
                  <p className="mt-1 text-steel">{ko.workflowStudio.canvas.noEdges}</p>
                ) : (
                  <ol className="mt-2 grid gap-1 text-steel">
                    {canvasDefinition.graph.edges.map((edge) => (
                      <li key={edge.id}>
                        {edge.from_node_id}:{edge.from_port} → {edge.to_node_id}:{edge.to_port}
                        {edge.label ? ` · ${edge.label}` : ""}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}

          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]">
            <label className="grid gap-1 text-sm font-medium text-ink">
              <span>{ko.workflowStudio.canvas.sourceNode}</span>
              <select
                value={connectionSourceId}
                onChange={(event) => {
                  onConnectionSourceChange(event.currentTarget.value);
                }}
                className="rounded-lg border border-line px-3 py-2 font-normal text-ink focus:border-ink focus:outline-none"
              >
                <option value="">{ko.workflowStudio.canvas.selectNode}</option>
                {canvasDefinition.graph.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium text-ink">
              <span>{ko.workflowStudio.canvas.sourcePort}</span>
              <select
                value={connectionSourcePort}
                onChange={(event) => {
                  onConnectionSourcePortChange(event.currentTarget.value);
                }}
                className="rounded-lg border border-line px-3 py-2 font-normal text-ink focus:border-ink focus:outline-none"
              >
                <option value="">{ko.workflowStudio.canvas.selectPort}</option>
                {connectionSourceNode?.output_ports.map((port) => (
                  <option key={port.key} value={port.key}>
                    {port.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium text-ink">
              <span>{ko.workflowStudio.canvas.targetNode}</span>
              <select
                value={connectionTargetId}
                onChange={(event) => {
                  onConnectionTargetChange(event.currentTarget.value);
                }}
                className="rounded-lg border border-line px-3 py-2 font-normal text-ink focus:border-ink focus:outline-none"
              >
                <option value="">{ko.workflowStudio.canvas.selectNode}</option>
                {canvasDefinition.graph.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium text-ink">
              <span>{ko.workflowStudio.canvas.targetPort}</span>
              <select
                value={connectionTargetPort}
                onChange={(event) => {
                  onConnectionTargetPortChange(event.currentTarget.value);
                }}
                className="rounded-lg border border-line px-3 py-2 font-normal text-ink focus:border-ink focus:outline-none"
              >
                <option value="">{ko.workflowStudio.canvas.selectPort}</option>
                {connectionTargetNode?.input_ports.map((port) => (
                  <option key={port.key} value={port.key}>
                    {port.label}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" className="self-end" onClick={onAddConnection}>
              {ko.workflowStudio.canvas.addConnection}
            </Button>
          </div>
          {connectionError ? (
            <p className="mt-2 text-sm text-red-700">{connectionError}</p>
          ) : null}
        </section>

        <WorkflowInspector
          definition={canvasDefinition}
          selectedNode={selectedNode}
          onChange={onCanvasChange}
        />
      </div>

      <WorkflowValidationPanel findings={findings} />

      <details className="mt-4 rounded-lg border border-line p-3 text-sm">
        <summary className="cursor-pointer font-semibold text-ink">
          {ko.workflowStudio.canvas.generatedDefinition}
        </summary>
        <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-ink p-3 text-xs text-white">
          {JSON.stringify(canvasDefinition, null, 2)}
        </pre>
      </details>
    </Card>
  );
}

function WorkflowInspector({
  definition,
  selectedNode,
  onChange,
}: {
  definition: WorkflowDefinitionV1;
  selectedNode: WorkflowNode | undefined;
  onChange: (definition: WorkflowDefinitionV1) => void;
}) {
  if (!selectedNode) {
    return (
      <section className="rounded-lg border border-line bg-muted-panel/40 p-3" aria-labelledby="workflow-inspector-heading">
        <h3 id="workflow-inspector-heading" className="font-semibold text-ink">
          {ko.workflowStudio.canvas.inspector}
        </h3>
        <p className="mt-2 text-sm text-steel">{ko.workflowStudio.canvas.noSelection}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-line bg-muted-panel/40 p-3" aria-labelledby="workflow-inspector-heading">
      <h3 id="workflow-inspector-heading" className="font-semibold text-ink">
        {ko.workflowStudio.canvas.inspector}
      </h3>
      <p className="mt-2 text-sm font-semibold text-ink">{selectedNode.label}</p>
      <p className="text-xs text-steel">{selectedNode.type}</p>
      {selectedNode.config.type === "task.approval" ? (
        <div className="mt-3 grid gap-3">
          <Field
            label={ko.workflowStudio.canvas.approvalFallbackRole}
            value={selectedNode.config.assignee_rule.fallback_role}
            onChange={(value) => {
              onChange(updateApprovalFallbackRole(definition, selectedNode.id, value));
            }}
          />
          <Field
            label={ko.workflowStudio.canvas.approvalSla}
            value={selectedNode.config.sla.duration}
            onChange={(value) => {
              onChange(updateApprovalSla(definition, selectedNode.id, value));
            }}
          />
          <label className="inline-flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={selectedNode.config.requires_passkey_step_up}
              onChange={(event) => {
                onChange(
                  toggleApprovalPasskey(
                    definition,
                    selectedNode.id,
                    event.currentTarget.checked,
                  ),
                );
              }}
            />
            {ko.workflowStudio.canvas.approvalPasskey}
          </label>
          <div className="rounded-lg border border-line bg-white p-3 text-sm text-steel">
            {ko.workflowStudio.canvas.approvalGuardrails}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-line bg-white p-3 text-sm text-steel">
          {JSON.stringify(selectedNode.config, null, 2)}
        </div>
      )}
    </section>
  );
}

function WorkflowValidationPanel({
  findings,
}: {
  findings: WorkflowValidationFinding[];
}) {
  return (
    <section className="mt-4 rounded-lg border border-line bg-white p-3" aria-labelledby="workflow-validation-heading">
      <div className="flex items-center justify-between gap-2">
        <h3 id="workflow-validation-heading" className="font-semibold text-ink">
          {ko.workflowStudio.canvas.validation}
        </h3>
        <Badge>{ko.workflowStudio.canvas.blockerSummary(findings.filter((finding) => finding.severity === "error").length)}</Badge>
      </div>
      {findings.length === 0 ? (
        <p className="mt-2 text-sm text-brand-teal">{ko.workflowStudio.canvas.noFindings}</p>
      ) : (
        <ol className="mt-3 grid gap-2">
          {findings.map((finding) => (
            <li key={`${finding.code}-${finding.nodeId ?? ""}-${finding.edgeId ?? ""}-${finding.message}`} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="font-semibold">{finding.code}</div>
              <div>{finding.message}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium text-ink">
      <span>{label}</span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        className="rounded-lg border border-line px-3 py-2 font-normal text-ink focus:border-ink focus:outline-none disabled:cursor-not-allowed disabled:bg-muted-panel"
      />
    </label>
  );
}

function ConnectorCard({
  connector,
}: {
  connector: WorkflowConnectorDescriptor;
}) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="font-semibold text-ink">{connector.display_name}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {connector.action_keys.map((action) => (
          <Badge key={action}>{action}</Badge>
        ))}
      </div>
    </div>
  );
}

function IconActionButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="xs"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </Button>
  );
}

function missingRequiredLines(definition: WorkflowDefinitionResponse): boolean {
  return (
    (definition.required_approval_line &&
      countArray(definition.approval_line) === 0) ||
    (definition.required_payment_line &&
      countArray(definition.payment_line) === 0)
  );
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("expected JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseJsonArray(value: string): Record<string, unknown>[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("expected JSON array");
  }
  return parsed as Record<string, unknown>[];
}

function parseActionAllowlist(
  value: string,
): Array<{ connector_key: string; action_key: string }> {
  return parseJsonArray(value).map((entry) => {
    const connectorKey = entry.connector_key;
    const actionKey = entry.action_key;
    if (typeof connectorKey !== "string" || typeof actionKey !== "string") {
      throw new Error(
        "action allowlist entries require connector_key and action_key",
      );
    }
    return { connector_key: connectorKey, action_key: actionKey };
  });
}

function statusLabel(status: string): string {
  const labels = ko.workflowStudio.status as Record<string, string>;
  return labels[status] ?? status;
}

function statusClass(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "border-brand-teal/30 bg-brand-teal/10 text-brand-teal";
    case "PAUSED":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "RETIRED":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-line bg-muted-panel text-steel";
  }
}
