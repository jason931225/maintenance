import {
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

type ReadState = "loading" | "idle" | "error";
type FeedbackKind = "success" | "error";
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
  workflowKey: "work_order.completion_review",
  displayName: ko.workflowStudio.defaultDraftName,
  objectType: "work_order",
  definitionJson: JSON.stringify(
    {
      schema_version: "workflow.definition.v1",
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
  const [creatingDraft, setCreatingDraft] = useState(false);

  const selectedDefinition = useMemo(
    () =>
      definitions.find(
        (definition) => definition.id === selectedDefinitionId,
      ) ?? definitions[0],
    [definitions, selectedDefinitionId],
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
      const nextSelected = definitionsResponse.data.items[0]?.id;
      const selected =
        definitionsResponse.data.items.find(
          (definition) => definition.id === selectedDefinitionId,
        )?.id ?? nextSelected;
      setSelectedDefinitionId(selected);
      await loadHistory(selected);
      setReadState("idle");
    } catch {
      setReadState("error");
      setError(ko.workflowStudio.loadFailed);
    }
  }, [api, loadHistory, selectedDefinitionId]);

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
    try {
      await loadHistory(definition.id);
    } catch {
      showError(ko.workflowStudio.actionFailed);
    }
  }

  async function createDraft() {
    setCreatingDraft(true);
    setFeedback(undefined);
    try {
      const payload = draftPayloadFromForm(draftForm);
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
        setDraftForm(DEFAULT_DRAFT_FORM);
        await loadHistory(updated.id);
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
        await loadHistory(created.id);
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
    setDraftForm(draftFormFromDefinition(definition));
    await selectDefinition(definition);
  }

  function cancelEditingDefinition() {
    setEditingDefinitionId(undefined);
    setDraftForm(DEFAULT_DRAFT_FORM);
  }

  async function publishDefinition(definition: WorkflowDefinitionResponse) {
    setFeedback(undefined);
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
        setDefinitions((items) =>
          items.filter((item) => item.id !== definition.id),
        );
        setSelectedDefinitionId(undefined);
        setHistory([]);
        if (editingDefinitionId === definition.id) {
          setEditingDefinitionId(undefined);
          setDraftForm(DEFAULT_DRAFT_FORM);
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
    setEditingDefinitionId(undefined);
    setDraftForm((current) => ({
      ...current,
      workflowKey: `${template.object_type}.${template.template_key}`,
      displayName: template.display_name,
      objectType: template.object_type,
      definitionJson: JSON.stringify(
        isPolicyTemplate
          ? equipmentLocationPolicyDefinition()
          : workflowTemplateDefinition(template),
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

            <DraftAuthoringCard
              catalog={catalog}
              draftForm={draftForm}
              editingDefinitionId={editingDefinitionId}
              creatingDraft={creatingDraft}
              onChange={setDraftForm}
              onApplyTemplate={applyTemplate}
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

function DraftAuthoringCard({
  catalog,
  draftForm,
  editingDefinitionId,
  creatingDraft,
  onChange,
  onApplyTemplate,
  onSubmit,
  onCancelEdit,
}: {
  catalog: WorkflowStudioCatalogResponse;
  draftForm: DraftForm;
  editingDefinitionId: string | undefined;
  creatingDraft: boolean;
  onChange: (form: DraftForm) => void;
  onApplyTemplate: (template: WorkflowTemplateDescriptor) => void;
  onSubmit: () => void;
  onCancelEdit: () => void;
}) {
  const setField = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => {
    onChange({ ...draftForm, [key]: value });
  };
  const isEditing = Boolean(editingDefinitionId);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {isEditing
              ? ko.workflowStudio.authoring.editTitle
              : ko.workflowStudio.authoring.title}
          </h2>
          <p className="text-sm text-steel">
            {ko.workflowStudio.authoring.help}
          </p>
        </div>
        <div className="flex gap-2">
          {isEditing ? (
            <Button type="button" variant="secondary" onClick={onCancelEdit}>
              {ko.workflowStudio.authoring.cancelEdit}
            </Button>
          ) : null}
          <Button type="button" onClick={onSubmit} disabled={creatingDraft}>
            {isEditing
              ? ko.workflowStudio.authoring.update
              : ko.workflowStudio.authoring.create}
          </Button>
        </div>
      </div>
      {catalog.templates.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
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
      ) : null}
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
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <JsonField
          label={ko.workflowStudio.authoring.definition}
          value={draftForm.definitionJson}
          onChange={(value) => {
            setField("definitionJson", value);
          }}
        />
        <JsonField
          label={ko.workflowStudio.authoring.actionAllowlist}
          value={draftForm.actionAllowlistJson}
          onChange={(value) => {
            setField("actionAllowlistJson", value);
          }}
        />
        <JsonField
          label={ko.workflowStudio.authoring.approvalLine}
          value={draftForm.approvalLineJson}
          onChange={(value) => {
            setField("approvalLineJson", value);
          }}
        />
        <JsonField
          label={ko.workflowStudio.authoring.paymentLine}
          value={draftForm.paymentLineJson}
          onChange={(value) => {
            setField("paymentLineJson", value);
          }}
        />
        <JsonField
          label={ko.workflowStudio.authoring.notificationRules}
          value={draftForm.notificationRulesJson}
          onChange={(value) => {
            setField("notificationRulesJson", value);
          }}
        />
      </div>
    </Card>
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
        className="rounded-lg border border-line px-3 py-2 font-normal text-ink focus:border-ink focus:outline-none disabled:bg-muted-panel disabled:text-steel"
      />
    </label>
  );
}

function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium text-ink">
      <span>{label}</span>
      <textarea
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        rows={7}
        spellCheck={false}
        className="rounded-lg border border-line px-3 py-2 font-mono text-xs font-normal text-ink focus:border-ink focus:outline-none"
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

function draftPayloadFromForm(form: DraftForm) {
  return {
    display_name: form.displayName,
    definition: parseJsonObject(form.definitionJson),
    approval_line: parseJsonArray(form.approvalLineJson),
    payment_line: parseJsonArray(form.paymentLineJson),
    notification_rules: parseJsonArray(form.notificationRulesJson),
    action_allowlist: parseActionAllowlist(form.actionAllowlistJson),
    required_approval_line: form.requiredApprovalLine,
    required_payment_line: form.requiredPaymentLine,
  };
}

function draftFormFromDefinition(
  definition: WorkflowDefinitionResponse,
): DraftForm {
  return {
    workflowKey: definition.workflow_key,
    displayName: definition.display_name,
    objectType: definition.object_type,
    definitionJson: JSON.stringify(definition.definition, null, 2),
    approvalLineJson: JSON.stringify(
      Array.isArray(definition.approval_line) ? definition.approval_line : [],
      null,
      2,
    ),
    paymentLineJson: JSON.stringify(
      Array.isArray(definition.payment_line) ? definition.payment_line : [],
      null,
      2,
    ),
    notificationRulesJson: JSON.stringify(
      Array.isArray(definition.notification_rules)
        ? definition.notification_rules
        : [],
      null,
      2,
    ),
    actionAllowlistJson: JSON.stringify(
      Array.isArray(definition.action_allowlist)
        ? definition.action_allowlist
        : [],
      null,
      2,
    ),
    requiredApprovalLine: definition.required_approval_line,
    requiredPaymentLine: definition.required_payment_line,
  };
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
