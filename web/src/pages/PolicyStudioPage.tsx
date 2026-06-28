import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CreatePolicyRoleRequest,
  PolicyAssignmentPreviewResponse,
  PolicyAuditEventResponse,
  PolicyFeatureResponse,
  PolicyRoleAssignmentResponse,
  PolicyRoleCatalogResponse,
  PolicyRoleResponse,
  PolicyRoleStatusPreviewResponse,
  PolicyRoleTemplateResponse,
  ReplacePolicyRoleAssignmentsRequest,
  UpdatePolicyRoleRequest,
  UserSummary,
} from "../api/types";
import { assertPasskeyStepUp } from "../auth/webauthn";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { useAuth } from "../context/auth";
import { roleLabel, teamLabel } from "../features/org/org-format";
import { ko } from "../i18n/ko";
import { formatKoreanDateTime } from "../lib/datetime";
import { safeLabel } from "../lib/utils";

type ReadState = "loading" | "idle" | "error";

type PermissionLevel = "request_only" | "limited" | "allow";
type PolicyRoleStatus = "DRAFT" | "ACTIVE" | "RETIRED";
type PolicyConditionOperator = "equals" | "not_equals" | "in";
type PolicyPreviewSeverity = "info" | "warning" | "blocker";
type PolicyConditionInput = NonNullable<
  CreatePolicyRoleRequest["conditions"]
>[number];
type PolicyRoleDefinitionDraft = Pick<
  UpdatePolicyRoleRequest,
  "display_name" | "description" | "permissions" | "conditions"
>;
type DraftPolicyCondition = {
  id: string;
  attribute: string;
  operator: PolicyConditionOperator;
  values: string;
};
type PolicyAssignmentPreviewRollup = {
  infoCount: number;
  warningCount: number;
  blockerCount: number;
  highestSeverity: PolicyPreviewSeverity;
  decision: "ready" | "review" | "runtime_blocked";
  rationale: string[];
};

const DEFAULT_PERMISSION: PermissionLevel = "allow";
const DEFAULT_CONDITION_ATTRIBUTE = "department";
const DEFAULT_CONDITION_OPERATOR: PolicyConditionOperator = "equals";

const CONDITION_ATTRIBUTES = [
  "group",
  "tenant",
  "organization",
  "department",
  "team",
  "position",
  "employment_status",
  "assignment",
  "location",
  "site",
  "branch",
  "device_posture",
  "purpose",
  "action",
  "resource",
  "sensitive_action",
] as const;

const CONDITION_OPERATORS: PolicyConditionOperator[] = [
  "equals",
  "not_equals",
  "in",
];

export function PolicyStudioPage() {
  const { api } = useAuth();
  const [features, setFeatures] = useState<PolicyFeatureResponse[]>([]);
  const [catalog, setCatalog] = useState<PolicyRoleCatalogResponse>();
  const [auditEvents, setAuditEvents] = useState<PolicyAuditEventResponse[]>(
    [],
  );
  const [readState, setReadState] = useState<ReadState>("loading");
  const [feedback, setFeedback] = useState<string>();
  const [templates, setTemplates] = useState<PolicyRoleTemplateResponse[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("");
  const [editingRole, setEditingRole] = useState<PolicyRoleResponse>();
  const [roleKey, setRoleKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<
    Partial<Record<string, PermissionLevel>>
  >({});
  const [conditionDrafts, setConditionDrafts] = useState<
    DraftPolicyCondition[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [assignments, setAssignments] = useState<
    PolicyRoleAssignmentResponse[]
  >([]);
  const [plannedRoleIds, setPlannedRoleIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string>();
  const [assignmentPreview, setAssignmentPreview] =
    useState<PolicyAssignmentPreviewResponse>();
  const [assignmentPreviewAcknowledged, setAssignmentPreviewAcknowledged] =
    useState(false);
  const assignmentLoadSequence = useRef(0);
  const [statusPreview, setStatusPreview] =
    useState<PolicyRoleStatusPreviewResponse>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [statusChangingRoleId, setStatusChangingRoleId] = useState<string>();

  const load = useCallback(async () => {
    setReadState("loading");
    const [
      featureResponse,
      roleResponse,
      templateResponse,
      auditResponse,
      userResponse,
    ] = await Promise.all([
      api.GET("/api/v1/policy/features").catch(() => undefined),
      api.GET("/api/v1/policy/roles").catch(() => undefined),
      api.GET("/api/v1/policy/role-templates").catch(() => undefined),
      api
        .GET("/api/v1/policy/audit-events", {
          params: { query: { limit: 20 } },
        })
        .catch(() => undefined),
      api
        .GET("/api/v1/users", {
          params: { query: { include_inactive: true, limit: 200 } },
        })
        .catch(() => undefined),
    ]);
    if (!featureResponse?.data || !roleResponse?.data || !auditResponse?.data) {
      setReadState("error");
      return;
    }
    setFeatures(featureResponse.data);
    setCatalog(roleResponse.data);
    setTemplates(templateResponse?.data ?? []);
    setAuditEvents(auditResponse.data);
    const nextUsers = userResponse?.data?.items ?? [];
    setUsers(nextUsers);
    setSelectedUserId((current) => {
      if (current && nextUsers.some((user) => user.id === current))
        return current;
      return nextUsers[0]?.id ?? "";
    });
    setReadState("idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const assignableFeatures = useMemo(
    () => features.filter((feature) => !feature.elevated),
    [features],
  );
  const lockedStatusRoleId = statusChangingRoleId ?? statusPreview?.role_id;

  function toggleFeature(featureKey: string) {
    setSelected((current) => {
      if (current[featureKey] !== undefined) {
        const { [featureKey]: _removed, ...next } = current;
        void _removed;
        return next;
      }
      return { ...current, [featureKey]: DEFAULT_PERMISSION };
    });
  }

  const loadAssignments = useCallback(
    async (userId: string) => {
      const requestSequence = (assignmentLoadSequence.current += 1);
      if (!userId) {
        setAssignments([]);
        setPlannedRoleIds(new Set());
        setAssignmentPreview(undefined);
        setAssignmentPreviewAcknowledged(false);
        return;
      }
      setAssignmentLoading(true);
      setAssignmentError(undefined);
      try {
        const response = await api.GET("/api/v1/policy/assignments", {
          params: { query: { user_id: userId } },
        });
        if (requestSequence !== assignmentLoadSequence.current) return;
        const nextAssignments = response.data ?? [];
        setAssignments(nextAssignments);
        setPlannedRoleIds(
          new Set(nextAssignments.map((assignment) => assignment.role_id)),
        );
        setAssignmentPreview(undefined);
        setAssignmentPreviewAcknowledged(false);
      } catch {
        if (requestSequence !== assignmentLoadSequence.current) return;
        setAssignmentError(ko.policyStudio.assignments.loadFailed);
      } finally {
        if (requestSequence === assignmentLoadSequence.current) {
          setAssignmentLoading(false);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    void loadAssignments(selectedUserId);
  }, [loadAssignments, selectedUserId]);

  function togglePlannedRole(roleId: string) {
    setAssignmentPreview(undefined);
    setAssignmentPreviewAcknowledged(false);
    setPlannedRoleIds((current) => {
      const next = new Set(current);
      if (next.has(roleId)) {
        next.delete(roleId);
      } else {
        next.add(roleId);
      }
      return next;
    });
  }

  function selectAssignmentUser(userId: string) {
    setAssignmentPreview(undefined);
    setAssignmentPreviewAcknowledged(false);
    setSelectedUserId(userId);
  }

  function applyTemplate(templateKey: string) {
    setEditingRole(undefined);
    setSelectedTemplateKey(templateKey);
    setError(undefined);
    const template = templates.find(
      (item) => item.template_key === templateKey,
    );
    if (!template) return;
    setRoleKey(template.role_key);
    setDisplayName(template.display_name);
    setDescription(template.description);
    setConditionDrafts([]);
    setSelected(
      Object.fromEntries(
        template.permissions.map((permission) => [
          permission.feature_key,
          permission.permission_level as PermissionLevel,
        ]),
      ),
    );
  }

  function resetRoleForm() {
    setEditingRole(undefined);
    setRoleKey("");
    setDisplayName("");
    setDescription("");
    setSelectedTemplateKey("");
    setSelected({});
    setConditionDrafts([]);
  }

  function beginEditRole(role: PolicyRoleResponse) {
    setError(undefined);
    setFeedback(undefined);
    setStatusPreview(undefined);
    setEditingRole(role);
    setSelectedTemplateKey("");
    setRoleKey(role.role_key);
    setDisplayName(role.display_name);
    setDescription(role.description ?? "");
    setSelected(
      Object.fromEntries(
        role.permissions.map((permission) => [
          permission.feature_key,
          permission.permission_level as PermissionLevel,
        ]),
      ),
    );
    setConditionDrafts(
      role.conditions.map((condition, index) => ({
        id: `condition-${String(index + 1)}-${condition.condition_key}`,
        attribute: condition.attribute,
        operator: isPolicyConditionOperator(condition.operator)
          ? condition.operator
          : DEFAULT_CONDITION_OPERATOR,
        values: condition.values.join(", "),
      })),
    );
  }

  async function savePlannedAssignments() {
    if (!selectedUserId) return;
    const previewReceiptId = assignmentPreview?.preview_receipt_id;
    if (
      !assignmentPreviewAcknowledged ||
      !assignmentPreview ||
      !previewReceiptId ||
      assignmentPreview.user_id !== selectedUserId ||
      !sameStringSet(assignmentPreview.requested_role_ids, plannedRoleIds)
    ) {
      setAssignmentPreviewAcknowledged(false);
      setAssignmentError(ko.policyStudio.assignments.previewRequired);
      return;
    }
    setAssignmentSaving(true);
    setAssignmentError(undefined);
    try {
      const stepUp = await assertPasskeyStepUp(api);
      const body: ReplacePolicyRoleAssignmentsRequest = {
        role_ids: [...plannedRoleIds],
        preview_acknowledged: true,
        preview_receipt_id: previewReceiptId,
        step_up: stepUp,
      };
      const response = await api.PUT("/api/v1/policy/users/{id}/assignments", {
        params: { path: { id: selectedUserId } },
        body,
      });
      const nextAssignments = response.data ?? [];
      setAssignments(nextAssignments);
      setPlannedRoleIds(
        new Set(nextAssignments.map((assignment) => assignment.role_id)),
      );
      setAssignmentPreview(undefined);
      setAssignmentPreviewAcknowledged(false);
      setFeedback(ko.policyStudio.assignments.saved);
      await load();
    } catch {
      setAssignmentError(ko.policyStudio.assignments.saveFailed);
    } finally {
      setAssignmentSaving(false);
    }
  }

  async function previewPlannedAssignments() {
    if (!selectedUserId) return;
    setPreviewLoading(true);
    setAssignmentError(undefined);
    setAssignmentPreviewAcknowledged(false);
    const body: ReplacePolicyRoleAssignmentsRequest = {
      role_ids: [...plannedRoleIds],
    };
    try {
      const response = await api.POST(
        "/api/v1/policy/users/{id}/assignment-preview",
        {
          params: { path: { id: selectedUserId } },
          body,
        },
      );
      if (!response.data) throw new Error("preview failed");
      setAssignmentPreview(response.data);
      setAssignmentPreviewAcknowledged(false);
    } catch {
      setAssignmentPreview(undefined);
      setAssignmentPreviewAcknowledged(false);
      setAssignmentError(ko.policyStudio.assignments.previewFailed);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function createRole() {
    setError(undefined);
    const draft = buildRoleDefinitionDraft(
      displayName,
      description,
      selected,
      conditionDrafts,
    );
    if (!roleKey.trim() || !draft) {
      setError(ko.policyStudio.validation.required);
      return;
    }
    setSaving(true);
    try {
      if (editingRole) {
        const stepUp = await assertPasskeyStepUp(api);
        const body: UpdatePolicyRoleRequest = {
          ...draft,
          step_up: stepUp,
        };
        const response = await api.PATCH("/api/v1/policy/roles/{id}", {
          params: { path: { id: editingRole.id } },
          body,
        });
        if (!response.data) throw new Error("update role failed");
        setFeedback(ko.policyStudio.updated);
      } else {
        const body: CreatePolicyRoleRequest = {
          role_key: roleKey.trim(),
          ...draft,
        };
        const response = await api.POST("/api/v1/policy/roles", { body });
        if (!response.data) throw new Error("create role failed");
        setFeedback(ko.policyStudio.created);
      }
      resetRoleForm();
      await load();
    } catch {
      setError(
        editingRole
          ? ko.policyStudio.updateFailed
          : ko.policyStudio.createFailed,
      );
    } finally {
      setSaving(false);
    }
  }

  async function changeRoleStatus(
    role: PolicyRoleResponse,
    status: PolicyRoleStatus,
  ) {
    setError(undefined);
    setFeedback(undefined);
    setStatusChangingRoleId(role.id);
    setStatusPreview(undefined);
    try {
      const previewResponse = await api.POST(
        "/api/v1/policy/roles/{id}/status-preview",
        {
          params: { path: { id: role.id } },
          body: { status },
        },
      );
      if (!previewResponse.data) throw new Error("role status preview failed");
      setStatusPreview(previewResponse.data);
    } catch {
      setError(ko.policyStudio.statusUpdateFailed);
    } finally {
      setStatusChangingRoleId(undefined);
    }
  }

  async function confirmRoleStatusChange() {
    if (!statusPreview) return;
    const requestedStatus = statusPreview.requested_status;
    setError(undefined);
    setStatusChangingRoleId(statusPreview.role_id);
    try {
      const stepUp = await assertPasskeyStepUp(api);
      const response = await api.PATCH("/api/v1/policy/roles/{id}/status", {
        params: { path: { id: statusPreview.role_id } },
        body: { status: requestedStatus, step_up: stepUp },
      });
      if (!response.data) throw new Error("role status update failed");
      setStatusPreview(undefined);
      setFeedback(ko.policyStudio.statusUpdated);
      await load();
    } catch {
      setError(ko.policyStudio.statusUpdateFailed);
    } finally {
      setStatusChangingRoleId(undefined);
    }
  }

  return (
    <>
      <PageHeader
        title={ko.policyStudio.title}
        description={ko.policyStudio.description}
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
        kind="success"
        message={feedback}
        onDismiss={() => {
          setFeedback(undefined);
        }}
        className="mb-4"
      />

      <PolicyVersionSummary policyVersion={catalog?.policy_version} />

      {readState === "error" ? (
        <PageError
          message={ko.policyStudio.loadFailed}
          onRetry={() => {
            void load();
          }}
        />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section className="grid gap-4">
          <Card className="p-5">
            <div className="mb-4 flex items-start gap-3">
              <span className="rounded-full bg-brand-teal/10 p-2 text-brand-teal">
                <ShieldCheck aria-hidden="true" size={18} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-ink">
                  {ko.policyStudio.rolesTitle}
                </h2>
                <p className="text-sm text-steel">
                  {ko.policyStudio.rolesHint}
                </p>
              </div>
            </div>
            <PolicyRoleStatusPreviewPanel
              preview={statusPreview}
              confirming={
                Boolean(statusPreview) &&
                statusChangingRoleId === statusPreview?.role_id
              }
              onConfirm={() => void confirmRoleStatusChange()}
              onCancel={() => {
                setStatusPreview(undefined);
              }}
            />
            {readState === "loading" && !catalog ? (
              <SkeletonTable rows={4} cols={4} />
            ) : catalog &&
              catalog.system_roles.length + catalog.custom_roles.length > 0 ? (
              <RoleCatalogTable
                systemRoles={catalog.system_roles}
                customRoles={catalog.custom_roles}
                changingRoleId={lockedStatusRoleId}
                onEditRole={beginEditRole}
                onChangeStatus={(role, status) =>
                  void changeRoleStatus(role, status)
                }
              />
            ) : (
              <PageEmpty message={ko.policyStudio.emptyRoles} />
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-ink">
                {ko.policyStudio.featuresTitle}
              </h2>
              <p className="text-sm text-steel">
                {ko.policyStudio.featuresHint}
              </p>
            </div>
            {readState === "loading" && features.length === 0 ? (
              <SkeletonTable rows={6} cols={3} />
            ) : (
              <FeatureCatalog features={features} />
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-ink">
                {ko.policyStudio.assignments.title}
              </h2>
              <p className="text-sm text-steel">
                {ko.policyStudio.assignments.description}
              </p>
            </div>
            <AssignmentPlanner
              users={users}
              customRoles={catalog?.custom_roles ?? []}
              selectedUserId={selectedUserId}
              plannedRoleIds={plannedRoleIds}
              assignments={assignments}
              loading={assignmentLoading}
              saving={assignmentSaving}
              preview={assignmentPreview}
              previewAcknowledged={assignmentPreviewAcknowledged}
              previewing={previewLoading}
              error={assignmentError}
              onSelectUser={selectAssignmentUser}
              onToggleRole={togglePlannedRole}
              onAcknowledgePreview={setAssignmentPreviewAcknowledged}
              onPreview={() => void previewPlannedAssignments()}
              onSave={() => void savePlannedAssignments()}
            />
          </Card>

          <Card className="p-5">
            <PolicyAuditTimeline
              events={auditEvents}
              loading={readState === "loading" && auditEvents.length === 0}
            />
          </Card>
        </section>

        <aside>
          <Card className="sticky top-4 grid gap-4 p-5">
            <div>
              <h2 className="text-base font-semibold text-ink">
                {editingRole
                  ? ko.policyStudio.editTitle
                  : ko.policyStudio.createTitle}
              </h2>
              <p className="text-sm text-steel">
                {editingRole
                  ? ko.policyStudio.editHint
                  : ko.policyStudio.createHint}
              </p>
            </div>
            {editingRole ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {ko.policyStudio.immutableRoleKey}
              </p>
            ) : (
              <RoleTemplatePicker
                templates={templates}
                selectedTemplateKey={selectedTemplateKey}
                onSelect={applyTemplate}
              />
            )}
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="role-key"
              >
                {ko.policyStudio.roleKey}
              </label>
              <Input
                id="role-key"
                value={roleKey}
                disabled={Boolean(editingRole)}
                placeholder="maintenance_manager"
                onChange={(event) => {
                  setRoleKey(event.currentTarget.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="role-display-name"
              >
                {ko.policyStudio.displayName}
              </label>
              <Input
                id="role-display-name"
                value={displayName}
                placeholder={ko.policyStudio.displayNamePlaceholder}
                onChange={(event) => {
                  setDisplayName(event.currentTarget.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="role-description"
              >
                {ko.policyStudio.roleDescription}
              </label>
              <Input
                id="role-description"
                value={description}
                placeholder={ko.policyStudio.descriptionPlaceholder}
                onChange={(event) => {
                  setDescription(event.currentTarget.value);
                }}
              />
            </div>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-steel">
                {ko.policyStudio.permissions}
              </legend>
              <p className="text-xs text-steel">
                {ko.policyStudio.permissionsHint}
              </p>
              <div className="max-h-80 overflow-y-auto rounded-md border border-line p-2">
                {assignableFeatures.map((feature) => (
                  <div
                    key={feature.feature_key}
                    className="grid gap-1 border-b border-line py-2 last:border-0"
                  >
                    <label className="flex items-center gap-2 text-sm text-steel">
                      <input
                        type="checkbox"
                        className="size-4 rounded border-line"
                        checked={Boolean(selected[feature.feature_key])}
                        onChange={() => {
                          toggleFeature(feature.feature_key);
                        }}
                      />
                      {featureLabel(feature.feature_key)}
                    </label>
                    {selected[feature.feature_key] ? (
                      <Select
                        aria-label={`${featureLabel(feature.feature_key)} ${ko.policyStudio.permissionLevel}`}
                        value={
                          selected[feature.feature_key] ?? DEFAULT_PERMISSION
                        }
                        onChange={(event) => {
                          setSelected((current) => ({
                            ...current,
                            [feature.feature_key]: event.currentTarget
                              .value as PermissionLevel,
                          }));
                        }}
                      >
                        <option value="allow">
                          {ko.policyStudio.levels.allow}
                        </option>
                        <option value="limited">
                          {ko.policyStudio.levels.limited}
                        </option>
                        <option value="request_only">
                          {ko.policyStudio.levels.requestOnly}
                        </option>
                      </Select>
                    ) : null}
                  </div>
                ))}
              </div>
            </fieldset>

            <PolicyConditionEditor
              conditions={conditionDrafts}
              onAdd={() => {
                setConditionDrafts((current) => [
                  ...current,
                  {
                    id: `condition-${String(current.length + 1)}-${String(Date.now())}`,
                    attribute: DEFAULT_CONDITION_ATTRIBUTE,
                    operator: DEFAULT_CONDITION_OPERATOR,
                    values: "",
                  },
                ]);
              }}
              onRemove={(id) => {
                setConditionDrafts((current) =>
                  current.filter((condition) => condition.id !== id),
                );
              }}
              onChange={(id, patch) => {
                setConditionDrafts((current) =>
                  current.map((condition) =>
                    condition.id === id
                      ? { ...condition, ...patch }
                      : condition,
                  ),
                );
              }}
            />

            {error ? (
              <p role="alert" className="text-sm font-medium text-red-700">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={saving}
                onClick={() => void createRole()}
              >
                {editingRole
                  ? saving
                    ? ko.policyStudio.updating
                    : ko.policyStudio.update
                  : saving
                    ? ko.policyStudio.creating
                    : ko.policyStudio.create}
              </Button>
              {editingRole ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={saving}
                  onClick={resetRoleForm}
                >
                  {ko.policyStudio.cancelEdit}
                </Button>
              ) : null}
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}

function PolicyVersionSummary({
  policyVersion,
}: {
  policyVersion: PolicyRoleCatalogResponse["policy_version"] | undefined;
}) {
  if (!policyVersion) return null;
  const updatedAt = formatKoreanDateTime(policyVersion.updated_at ?? null);
  return (
    <section
      aria-label={ko.policyStudio.policyVersion.title}
      className="mb-4 grid gap-2 rounded-lg border border-brand-teal/20 bg-brand-teal/5 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center"
    >
      <Badge className="w-fit border-brand-teal/30 text-brand-teal">
        {ko.policyStudio.policyVersion.badge.replace(
          "{version}",
          String(policyVersion.version),
        )}
      </Badge>
      <div>
        <h2 className="text-sm font-semibold text-ink">
          {ko.policyStudio.policyVersion.title}
        </h2>
        <p className="text-sm text-steel">
          {policyVersion.version > 0
            ? ko.policyStudio.policyVersion.updatedAt.replace(
                "{timestamp}",
                updatedAt,
              )
            : ko.policyStudio.policyVersion.noWrites}
        </p>
        <p className="text-xs text-steel">
          {ko.policyStudio.policyVersion.hint}
        </p>
      </div>
    </section>
  );
}

function PolicyAuditTimeline({
  events,
  loading,
}: {
  events: PolicyAuditEventResponse[];
  loading: boolean;
}) {
  return (
    <section aria-label={ko.policyStudio.audit.title} className="grid gap-4">
      <div>
        <h2 className="text-base font-semibold text-ink">
          {ko.policyStudio.audit.title}
        </h2>
        <p className="text-sm text-steel">
          {ko.policyStudio.audit.description}
        </p>
      </div>
      {loading ? (
        <SkeletonTable rows={3} cols={3} />
      ) : events.length === 0 ? (
        <PageEmpty message={ko.policyStudio.audit.empty} />
      ) : (
        <ol className="grid gap-3" aria-label={ko.policyStudio.audit.timeline}>
          {events.map((event) => (
            <li
              key={event.id}
              className="rounded-lg border border-line bg-slate-50 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{policyAuditActionLabel(event.action)}</Badge>
                <span className="text-sm font-medium text-ink">
                  {policyAuditTargetLabel(event.target_type)}
                </span>
                <time
                  className="text-xs text-steel"
                  dateTime={event.occurred_at}
                >
                  {formatKoreanDateTime(event.occurred_at)}
                </time>
              </div>
              <p className="mt-2 text-sm text-steel">
                {policyAuditSummary(event)}
              </p>
              <p className="mt-1 text-xs text-steel">
                {policyAuditActorLabel(event)} ·{" "}
                {policyAuditSnapshotLabel(event)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PolicyRoleStatusPreviewPanel({
  preview,
  confirming,
  onConfirm,
  onCancel,
}: {
  preview: PolicyRoleStatusPreviewResponse | undefined;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!preview) return null;

  return (
    <section
      aria-label={ko.policyStudio.statusPreview.title}
      className="mb-4 grid gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4"
    >
      <div>
        <h3 className="text-sm font-semibold text-amber-950">
          {ko.policyStudio.statusPreview.title}
        </h3>
        <p className="text-sm text-amber-900">
          {ko.policyStudio.statusPreview.description}
        </p>
      </div>
      <div className="grid gap-2 text-sm text-amber-950 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <span className="block text-xs text-amber-800">
            {ko.policyStudio.statusPreview.role}
          </span>
          <span className="font-medium">{safeLabel(preview.display_name)}</span>
        </div>
        <div>
          <span className="block text-xs text-amber-800">
            {ko.policyStudio.statusPreview.statusChange}
          </span>
          <span className="font-medium">
            {preview.current_status} → {preview.requested_status}
          </span>
        </div>
        <div>
          <span className="block text-xs text-amber-800">
            {ko.policyStudio.statusPreview.policySurface}
          </span>
          <span className="font-medium">
            {ko.policyStudio.statusPreview.surfaceCounts
              .replace("{permissions}", String(preview.permission_count))
              .replace("{conditions}", String(preview.condition_count))}
          </span>
        </div>
        <div>
          <span className="block text-xs text-amber-800">
            {ko.policyStudio.statusPreview.plannedAssignments}
          </span>
          <span className="font-medium">
            {ko.policyStudio.statusPreview.assignmentCount.replace(
              "{count}",
              String(preview.planned_assignment_count),
            )}
          </span>
        </div>
        <div>
          <span className="block text-xs text-amber-800">
            {ko.policyStudio.statusPreview.runtimeImpact.title}
          </span>
          <span className="font-medium">
            {preview.effective_runtime_change
              ? ko.policyStudio.statusPreview.runtimeImpact.yes
              : ko.policyStudio.statusPreview.runtimeImpact.no}
          </span>
        </div>
      </div>
      <ul className="grid gap-1 text-xs text-amber-900">
        {preview.warnings.map((warning) => (
          <li key={warning}>• {policyStatusPreviewWarningLabel(warning)}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={confirming} onClick={onConfirm}>
          {confirming
            ? ko.policyStudio.statusPreview.confirming
            : ko.policyStudio.statusPreview.confirm}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={confirming}
          onClick={onCancel}
        >
          {ko.policyStudio.statusPreview.cancel}
        </Button>
      </div>
    </section>
  );
}

function RoleCatalogTable({
  systemRoles,
  customRoles,
  changingRoleId,
  onEditRole,
  onChangeStatus,
}: {
  systemRoles: PolicyRoleCatalogResponse["system_roles"];
  customRoles: PolicyRoleResponse[];
  changingRoleId: string | undefined;
  onEditRole: (role: PolicyRoleResponse) => void;
  onChangeStatus: (role: PolicyRoleResponse, status: PolicyRoleStatus) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[64rem] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold uppercase tracking-wider text-steel">
            <th className="px-3 py-2">{ko.policyStudio.columns.role}</th>
            <th className="px-3 py-2">{ko.policyStudio.columns.type}</th>
            <th className="px-3 py-2">{ko.policyStudio.columns.status}</th>
            <th className="px-3 py-2">{ko.policyStudio.columns.permissions}</th>
            <th className="px-3 py-2">{ko.policyStudio.columns.conditions}</th>
            <th className="px-3 py-2">{ko.policyStudio.columns.actions}</th>
          </tr>
        </thead>
        <tbody>
          {systemRoles.map((role) => (
            <tr
              key={role.role_key}
              className="border-b border-line last:border-0"
            >
              <td className="px-3 py-2 font-medium text-ink">
                {roleLabel(role.role_key)}
              </td>
              <td className="px-3 py-2">
                <Badge>{ko.policyStudio.systemRole}</Badge>
              </td>
              <td className="px-3 py-2 text-steel">{role.status}</td>
              <td className="px-3 py-2 text-steel">
                {formatGrantedCount(role.permissions)}
              </td>
              <td className="px-3 py-2 text-steel">—</td>
              <td className="px-3 py-2 text-steel">—</td>
            </tr>
          ))}
          {customRoles.map((role) => {
            const actions = roleStatusActions(role.status);
            return (
              <tr key={role.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2">
                  <div className="font-medium text-ink">
                    {safeLabel(role.display_name)}
                  </div>
                  <div className="text-xs text-steel">{role.role_key}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge className="border-brand-teal/30 text-brand-teal">
                    {ko.policyStudio.customRole}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-steel">{role.status}</td>
                <td className="px-3 py-2 text-steel">
                  {formatGrantedCount(role.permissions)}
                </td>
                <td className="px-3 py-2 text-steel">
                  <RoleConditionSummary conditions={role.conditions} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        onEditRole(role);
                      }}
                    >
                      {ko.policyStudio.edit}
                    </Button>
                    {actions.map((action) => (
                      <Button
                        key={action.status}
                        type="button"
                        variant="secondary"
                        disabled={changingRoleId === role.id}
                        onClick={() => {
                          onChangeStatus(role, action.status);
                        }}
                      >
                        {action.label}
                      </Button>
                    ))}
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

function RoleConditionSummary({
  conditions,
}: {
  conditions: Array<{
    attribute: string;
    operator: string;
    values: string[];
  }>;
}) {
  if (conditions.length === 0) {
    return <span>—</span>;
  }
  return (
    <div className="grid gap-1">
      <span>
        {ko.policyStudio.conditionCount.replace(
          "{count}",
          String(conditions.length),
        )}
      </span>
      {conditions.slice(0, 2).map((condition) => (
        <span
          key={`${condition.attribute}:${condition.operator}:${condition.values.join("|")}`}
          className="block max-w-64 truncate text-xs text-steel"
        >
          {conditionAttributeLabel(condition.attribute)} ·{" "}
          {conditionOperatorLabel(condition.operator)} ·{" "}
          {condition.values.map((value) => safeLabel(value)).join(", ")}
        </span>
      ))}
    </div>
  );
}

function PolicyConditionEditor({
  conditions,
  onAdd,
  onRemove,
  onChange,
}: {
  conditions: DraftPolicyCondition[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onChange: (id: string, patch: Partial<DraftPolicyCondition>) => void;
}) {
  return (
    <fieldset className="grid gap-3 rounded-md border border-line bg-slate-50 p-3">
      <legend className="text-sm font-medium text-steel">
        {ko.policyStudio.conditionsTitle}
      </legend>
      <p className="text-xs text-steel">{ko.policyStudio.conditionsHint}</p>
      {conditions.length === 0 ? (
        <p className="rounded border border-dashed border-line bg-white/70 p-2 text-xs text-steel">
          {ko.policyStudio.noConditions}
        </p>
      ) : (
        <div className="grid gap-3">
          {conditions.map((condition, index) => (
            <div
              key={condition.id}
              className="grid gap-2 rounded-md border border-line bg-white p-3"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-xs font-medium text-steel">
                  {ko.policyStudio.conditionAttribute}
                  <Select
                    aria-label={`${ko.policyStudio.conditionAttribute} ${String(index + 1)}`}
                    value={condition.attribute}
                    onChange={(event) => {
                      onChange(condition.id, {
                        attribute: event.currentTarget.value,
                      });
                    }}
                  >
                    {CONDITION_ATTRIBUTES.map((attribute) => (
                      <option key={attribute} value={attribute}>
                        {conditionAttributeLabel(attribute)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-steel">
                  {ko.policyStudio.conditionOperator}
                  <Select
                    aria-label={`${ko.policyStudio.conditionOperator} ${String(index + 1)}`}
                    value={condition.operator}
                    onChange={(event) => {
                      onChange(condition.id, {
                        operator: event.currentTarget
                          .value as PolicyConditionOperator,
                      });
                    }}
                  >
                    {CONDITION_OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {conditionOperatorLabel(operator)}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <label className="grid gap-1 text-xs font-medium text-steel">
                {ko.policyStudio.conditionValues}
                <Input
                  aria-label={`${ko.policyStudio.conditionValues} ${String(index + 1)}`}
                  value={condition.values}
                  placeholder={ko.policyStudio.conditionValuesPlaceholder}
                  onChange={(event) => {
                    onChange(condition.id, {
                      values: event.currentTarget.value,
                    });
                  }}
                />
              </label>
              <p className="text-xs text-steel">
                {ko.policyStudio.conditionRuntimeHint}
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  onRemove(condition.id);
                }}
              >
                {ko.policyStudio.removeCondition}
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button type="button" variant="secondary" onClick={onAdd}>
        {ko.policyStudio.addCondition}
      </Button>
    </fieldset>
  );
}

function FeatureCatalog({ features }: { features: PolicyFeatureResponse[] }) {
  if (features.length === 0) {
    return <PageEmpty message={ko.policyStudio.emptyFeatures} />;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {features.map((feature) => (
        <div
          key={feature.feature_key}
          className="rounded-md border border-line p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink">
              {featureLabel(feature.feature_key)}
            </span>
            {feature.elevated ? (
              <Badge className="border-amber-300 bg-amber-50 text-amber-800">
                {ko.policyStudio.elevated}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-steel">{feature.feature_key}</p>
        </div>
      ))}
    </div>
  );
}

function RoleTemplatePicker({
  templates,
  selectedTemplateKey,
  onSelect,
}: {
  templates: PolicyRoleTemplateResponse[];
  selectedTemplateKey: string;
  onSelect: (templateKey: string) => void;
}) {
  const selectedTemplate = templates.find(
    (template) => template.template_key === selectedTemplateKey,
  );

  return (
    <div className="grid gap-2 rounded-md border border-line bg-slate-50 p-3">
      <label className="text-sm font-medium text-steel" htmlFor="role-template">
        {ko.policyStudio.template}
      </label>
      <Select
        id="role-template"
        value={selectedTemplateKey}
        disabled={templates.length === 0}
        onChange={(event) => {
          onSelect(event.currentTarget.value);
        }}
      >
        <option value="">{ko.policyStudio.templatePlaceholder}</option>
        {templates.map((template) => (
          <option key={template.template_key} value={template.template_key}>
            {safeLabel(template.display_name)} ·{" "}
            {templateCategoryLabel(template.category)}
          </option>
        ))}
      </Select>
      <p className="text-xs text-steel">{ko.policyStudio.templateHint}</p>
      {selectedTemplate ? (
        <div className="rounded border border-line bg-white/70 p-2 text-xs text-steel">
          <div className="font-semibold text-ink">
            {safeLabel(selectedTemplate.display_name)}
          </div>
          <p>{safeLabel(selectedTemplate.description)}</p>
          <p>
            {ko.policyStudio.templateGrantCount.replace(
              "{count}",
              String(selectedTemplate.permissions.length),
            )}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function AssignmentPlanner({
  users,
  customRoles,
  selectedUserId,
  plannedRoleIds,
  assignments,
  loading,
  saving,
  preview,
  previewAcknowledged,
  previewing,
  error,
  onSelectUser,
  onToggleRole,
  onAcknowledgePreview,
  onPreview,
  onSave,
}: {
  users: UserSummary[];
  customRoles: PolicyRoleResponse[];
  selectedUserId: string;
  plannedRoleIds: ReadonlySet<string>;
  assignments: PolicyRoleAssignmentResponse[];
  loading: boolean;
  saving: boolean;
  preview: PolicyAssignmentPreviewResponse | undefined;
  previewAcknowledged: boolean;
  previewing: boolean;
  error: string | undefined;
  onSelectUser: (userId: string) => void;
  onToggleRole: (roleId: string) => void;
  onAcknowledgePreview: (acknowledged: boolean) => void;
  onPreview: () => void;
  onSave: () => void;
}) {
  if (users.length === 0) {
    return <PageEmpty message={ko.policyStudio.assignments.noUsers} />;
  }
  if (customRoles.length === 0) {
    return <PageEmpty message={ko.policyStudio.assignments.noRoles} />;
  }
  const selectedUser = users.find((user) => user.id === selectedUserId);
  const plannedRoles = customRoles.filter((role) => plannedRoleIds.has(role.id));

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 sm:max-w-md">
        <label className="text-sm font-medium text-steel" htmlFor="policy-user">
          {ko.policyStudio.assignments.user}
        </label>
        <Select
          id="policy-user"
          value={selectedUserId}
          onChange={(event) => {
            onSelectUser(event.currentTarget.value);
          }}
        >
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {safeLabel(user.display_name)}
            </option>
          ))}
        </Select>
      </div>

      <div className="rounded-md border border-line p-3">
        <div className="mb-2 text-sm font-semibold text-ink">
          {ko.policyStudio.assignments.roles}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {customRoles.map((role) => (
            <label
              key={role.id}
              className="flex items-start gap-2 rounded-md border border-line p-3 text-sm text-steel"
            >
              <input
                type="checkbox"
                aria-label={safeLabel(role.display_name)}
                className="mt-0.5 size-4 rounded border-line"
                checked={plannedRoleIds.has(role.id)}
                onChange={() => {
                  onToggleRole(role.id);
                }}
              />
              <span>
                <span className="block font-medium text-ink">
                  {safeLabel(role.display_name)}
                </span>
                <span className="block text-xs text-steel">
                  {role.role_key} · {role.status}
                </span>
                <span className="mt-1 block text-xs text-steel">
                  <RoleConditionSummary conditions={role.conditions} />
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
        {ko.policyStudio.assignments.notEffective}
      </div>

      {assignments.length > 0 ? (
        <p className="text-xs text-steel">
          {ko.policyStudio.assignments.current.replace(
            "{count}",
            String(assignments.length),
          )}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      <AssignmentImpactPreview
        preview={preview}
        selectedUser={selectedUser}
        currentAssignments={assignments}
        plannedRoles={plannedRoles}
      />

      {preview ? (
        <label className="flex items-start gap-2 rounded-md border border-line bg-white p-3 text-sm text-steel">
          <input
            type="checkbox"
            aria-label={ko.policyStudio.assignments.previewAcknowledgeLabel}
            className="mt-0.5 size-4 rounded border-line"
            checked={previewAcknowledged}
            onChange={(event) => {
              onAcknowledgePreview(event.currentTarget.checked);
            }}
          />
          <span>
            <span className="block font-medium text-ink">
              {ko.policyStudio.assignments.previewAcknowledgeLabel}
            </span>
            <span className="mt-1 block text-xs text-steel">
              {ko.policyStudio.assignments.previewAcknowledgeHint}
            </span>
          </span>
        </label>
      ) : null}

      {previewAcknowledged ? (
        <p className="text-xs font-medium text-emerald-700">
          {ko.policyStudio.assignments.previewAcknowledged}
        </p>
      ) : (
        <p className="text-xs font-medium text-amber-800">
          {ko.policyStudio.assignments.previewRequired}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={loading || saving || previewing}
          onClick={onPreview}
        >
          {previewing
            ? ko.policyStudio.assignments.previewing
            : ko.policyStudio.assignments.preview}
        </Button>
        <Button
          type="button"
          disabled={loading || saving || !preview || !previewAcknowledged}
          onClick={onSave}
        >
          {saving
            ? ko.policyStudio.assignments.saving
            : ko.policyStudio.assignments.save}
        </Button>
      </div>
    </div>
  );
}

function AssignmentImpactPreview({
  preview,
  selectedUser,
  currentAssignments,
  plannedRoles,
}: {
  preview: PolicyAssignmentPreviewResponse | undefined;
  selectedUser: UserSummary | undefined;
  currentAssignments: PolicyRoleAssignmentResponse[];
  plannedRoles: PolicyRoleResponse[];
}) {
  if (!preview) return null;
  const rollup = policyAssignmentPreviewRollup(preview);
  const featureCount = new Set(
    preview.feature_grants.map((grant) => grant.feature_key),
  ).size;
  const customRoleNames = preview.custom_roles.map((role) =>
    safeLabel(role.display_name),
  );
  const conditionedRoles = preview.custom_roles.filter(
    (role) => role.conditions.length > 0,
  );
  const runtimeRoleRows = preview.custom_roles.filter(
    (role) => !role.runtime_effective || role.runtime_warnings.length > 0,
  );
  const systemRoles = preview.system_roles.map(roleLabel);
  const grantRows = preview.feature_grants.slice(0, 8);

  return (
    <section
      aria-label={ko.policyStudio.assignments.previewTitle}
      className="grid gap-3 rounded-md border border-brand-teal/30 bg-brand-teal/5 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">
          {ko.policyStudio.assignments.previewTitle}
        </h3>
        <Badge className="border-amber-300 bg-amber-50 text-amber-800">
          {ko.policyStudio.assignments.previewOnly}
        </Badge>
        <Badge className={previewSeverityClassName(rollup.highestSeverity)}>
          {previewDecisionLabel(rollup.decision)}
        </Badge>
      </div>
      <PolicyAssignmentDecisionPath
        selectedUser={selectedUser}
        currentAssignments={currentAssignments}
        plannedRoles={plannedRoles}
        decision={rollup.decision}
      />
      <div
        className="grid gap-3 rounded border border-line bg-white/80 p-3 text-xs text-steel md:grid-cols-[auto_minmax(0,1fr)]"
        aria-label={ko.policyStudio.assignments.rollup.title}
      >
        <div className="grid grid-cols-3 gap-2 text-center">
          <PreviewMetric
            label={ko.policyStudio.assignments.rollup.blockers}
            value={rollup.blockerCount}
          />
          <PreviewMetric
            label={ko.policyStudio.assignments.rollup.warnings}
            value={rollup.warningCount}
          />
          <PreviewMetric
            label={ko.policyStudio.assignments.rollup.info}
            value={rollup.infoCount}
          />
        </div>
        <div>
          <div className="text-sm font-semibold text-ink">
            {ko.policyStudio.assignments.rollup.title}
          </div>
          <p className="mt-1">
            {ko.policyStudio.assignments.rollup.description}
          </p>
          <ul className="mt-2 grid gap-1">
            {rollup.rationale.map((item) => (
              <li key={item}>• {item}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="grid gap-2 text-sm text-steel sm:grid-cols-3">
        <PreviewMetric
          label={ko.policyStudio.assignments.added}
          value={preview.delta.added_role_ids.length}
        />
        <PreviewMetric
          label={ko.policyStudio.assignments.removed}
          value={preview.delta.removed_role_ids.length}
        />
        <PreviewMetric
          label={ko.policyStudio.assignments.unchanged}
          value={preview.delta.unchanged_role_ids.length}
        />
      </div>
      <p className="text-sm text-steel">
        {ko.policyStudio.assignments.previewSummary
          .replace("{features}", String(featureCount))
          .replace(
            "{roles}",
            String(preview.custom_roles.length + preview.system_roles.length),
          )}
      </p>
      <div className="grid gap-2 text-xs text-steel sm:grid-cols-2">
        <div>
          <span className="font-semibold text-ink">
            {ko.policyStudio.assignments.systemRoles}
          </span>
          <p>
            {systemRoles.length > 0
              ? systemRoles.join(", ")
              : ko.policyStudio.assignments.none}
          </p>
        </div>
        <div>
          <span className="font-semibold text-ink">
            {ko.policyStudio.assignments.customRoles}
          </span>
          <p>
            {customRoleNames.length > 0
              ? customRoleNames.join(", ")
              : ko.policyStudio.assignments.none}
          </p>
        </div>
      </div>
      <div className="rounded border border-line bg-white/70 p-2 text-xs text-steel">
        <span className="font-semibold text-ink">
          {ko.policyStudio.assignments.conditionScopes}
        </span>
        {conditionedRoles.length > 0 ? (
          <div className="mt-2 grid gap-2">
            {conditionedRoles.map((role) => (
              <div key={role.role_id} className="grid gap-1">
                <span className="font-medium text-ink">
                  {safeLabel(role.display_name)}
                </span>
                <RoleConditionSummary conditions={role.conditions} />
              </div>
            ))}
          </div>
        ) : (
          <p>{ko.policyStudio.assignments.noConditionScopes}</p>
        )}
      </div>
      <div className="rounded border border-line bg-white/70 p-2 text-xs text-steel">
        <span className="font-semibold text-ink">
          {ko.policyStudio.assignments.runtimeDecision}
        </span>
        {runtimeRoleRows.length > 0 ? (
          <ul className="mt-2 grid gap-1">
            {runtimeRoleRows.map((role) => (
              <li
                key={role.role_id}
                className="rounded border border-amber-200 bg-amber-50 px-2 py-1"
              >
                <span className="font-medium text-amber-900">
                  {safeLabel(role.display_name)} ·{" "}
                  {role.runtime_effective
                    ? ko.policyStudio.assignments.runtimeEffective
                    : ko.policyStudio.assignments.planningOnly}
                </span>
                <p className="text-amber-800">
                  {role.runtime_warnings.length > 0
                    ? role.runtime_warnings
                        .map(policyRuntimeWarningLabel)
                        .join(" / ")
                    : ko.policyStudio.assignments.noRuntimeWarnings}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p>{ko.policyStudio.assignments.allRuntimeEffective}</p>
        )}
      </div>
      {grantRows.length > 0 ? (
        <ul className="grid gap-1 text-xs text-steel">
          {grantRows.map((grant) => (
            <li
              key={`${grant.feature_key}:${grant.source_type}:${grant.source_key}:${grant.permission_level}`}
              className="flex flex-wrap justify-between gap-2 rounded border border-line bg-white/70 px-2 py-1"
            >
              <span className="font-medium text-ink">
                {featureLabel(grant.feature_key)}
              </span>
              <span>
                {permissionLabel(grant.permission_level)} ·{" "}
                {safeLabel(grant.source_label)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-steel">
          {ko.policyStudio.assignments.noPreviewGrants}
        </p>
      )}
      {preview.feature_grants.length > grantRows.length ? (
        <p className="text-xs text-steel">
          {ko.policyStudio.assignments.moreGrants.replace(
            "{count}",
            String(preview.feature_grants.length - grantRows.length),
          )}
        </p>
      ) : null}
    </section>
  );
}

function PolicyAssignmentDecisionPath({
  selectedUser,
  currentAssignments,
  plannedRoles,
  decision,
}: {
  selectedUser: UserSummary | undefined;
  currentAssignments: PolicyRoleAssignmentResponse[];
  plannedRoles: PolicyRoleResponse[];
  decision: PolicyAssignmentPreviewRollup["decision"];
}) {
  const currentRoleNames = currentAssignments.map((role) =>
    safeLabel(role.display_name),
  );
  const plannedRoleNames = plannedRoles.map((role) =>
    safeLabel(role.display_name),
  );
  return (
    <div
      role="group"
      aria-label={ko.policyStudio.assignments.decisionPath.title}
      className="rounded border border-line bg-white/90 p-3 text-xs text-steel"
    >
      <ol className="grid gap-2 md:grid-cols-5">
        <DecisionPathStep
          label={ko.policyStudio.assignments.decisionPath.targetUser}
          value={selectedUser ? safeLabel(selectedUser.display_name) : "—"}
          detail={selectedUser ? teamLabel(selectedUser.team) : undefined}
        />
        <DecisionPathStep
          label={ko.policyStudio.assignments.decisionPath.currentRoles}
          value={
            currentRoleNames.length > 0
              ? currentRoleNames.join(", ")
              : ko.policyStudio.assignments.decisionPath.noCurrentRoles
          }
        />
        <DecisionPathStep
          label={ko.policyStudio.assignments.decisionPath.proposedRoles}
          value={
            plannedRoleNames.length > 0
              ? plannedRoleNames.join(", ")
              : ko.policyStudio.assignments.decisionPath.noProposedRoles
          }
        />
        <DecisionPathStep
          label={ko.policyStudio.assignments.decisionPath.runtimeDecision}
          value={previewDecisionLabel(decision)}
        />
        <DecisionPathStep
          label={ko.policyStudio.assignments.decisionPath.nextStep}
          value={assignmentNextStepLabel(decision)}
        />
      </ol>
    </div>
  );
}

function DecisionPathStep({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <li className="rounded border border-line bg-slate-50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-steel">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-ink">{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-steel">{detail}</div> : null}
    </li>
  );
}

function assignmentNextStepLabel(
  decision: PolicyAssignmentPreviewRollup["decision"],
): string {
  if (decision === "runtime_blocked") {
    return ko.policyStudio.assignments.decisionPath.nextStepBlocked;
  }
  if (decision === "review") {
    return ko.policyStudio.assignments.decisionPath.nextStepReview;
  }
  return ko.policyStudio.assignments.decisionPath.nextStepReady;
}

function PreviewMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-line bg-white/70 px-3 py-2">
      <div className="text-xs text-steel">{label}</div>
      <div className="text-lg font-semibold text-ink">{value}</div>
    </div>
  );
}

function policyAssignmentPreviewRollup(
  preview: PolicyAssignmentPreviewResponse,
): PolicyAssignmentPreviewRollup {
  const runtimeBlockedRoles = preview.custom_roles.filter(
    (role) => !role.runtime_effective,
  );
  const previewWarningCodes = new Set<string>(preview.warnings);
  const runtimeWarningCodes = new Set<string>(
    preview.custom_roles.flatMap((role) => role.runtime_warnings),
  );
  const blockingFindingCodes = new Set<string>(
    runtimeBlockedRoles.flatMap((role) => role.runtime_warnings),
  );
  const warningCodes = new Set(
    [...previewWarningCodes, ...runtimeWarningCodes].filter(
      (warning) => !blockingFindingCodes.has(warning),
    ),
  );
  const changedRoles =
    preview.delta.added_role_ids.length + preview.delta.removed_role_ids.length;
  const grantCount = preview.feature_grants.length;
  const infoCount =
    Math.max(0, changedRoles) +
    (preview.delta.unchanged_role_ids.length > 0 ? 1 : 0) +
    (grantCount > 0 ? 1 : 0);
  const blockerCount = runtimeBlockedRoles.length;
  const warningCount = warningCodes.size;
  const highestSeverity: PolicyPreviewSeverity =
    blockerCount > 0 ? "blocker" : warningCount > 0 ? "warning" : "info";
  const decision =
    highestSeverity === "blocker"
      ? "runtime_blocked"
      : highestSeverity === "warning"
        ? "review"
        : "ready";
  const rationale = buildPreviewRollupRationale(
    preview,
    runtimeBlockedRoles,
    warningCodes,
    grantCount,
  );
  return {
    infoCount,
    warningCount,
    blockerCount,
    highestSeverity,
    decision,
    rationale,
  };
}

function buildPreviewRollupRationale(
  preview: PolicyAssignmentPreviewResponse,
  runtimeBlockedRoles: PolicyAssignmentPreviewResponse["custom_roles"],
  warningCodes: ReadonlySet<string>,
  grantCount: number,
): string[] {
  const rationale: string[] = [
    ko.policyStudio.assignments.rollup.delta
      .replace("{added}", String(preview.delta.added_role_ids.length))
      .replace("{removed}", String(preview.delta.removed_role_ids.length))
      .replace("{unchanged}", String(preview.delta.unchanged_role_ids.length)),
  ];
  if (runtimeBlockedRoles.length > 0) {
    rationale.push(
      ko.policyStudio.assignments.rollup.runtimeBlocked.replace(
        "{roles}",
        runtimeBlockedRoles
          .map((role) => safeLabel(role.display_name))
          .join(", "),
      ),
    );
  } else if (preview.effective) {
    rationale.push(
      ko.policyStudio.assignments.rollup.runtimeReady.replace(
        "{grants}",
        String(grantCount),
      ),
    );
  } else {
    rationale.push(ko.policyStudio.assignments.rollup.noRuntimeGrant);
  }
  if (warningCodes.size > 0) {
    rationale.push(
      ko.policyStudio.assignments.rollup.warningCodes.replace(
        "{count}",
        String(warningCodes.size),
      ),
    );
  }
  return rationale;
}

function previewSeverityClassName(severity: PolicyPreviewSeverity): string {
  if (severity === "blocker") {
    return "border-red-300 bg-red-50 text-red-700";
  }
  if (severity === "warning") {
    return "border-amber-300 bg-amber-50 text-amber-800";
  }
  return "border-emerald-300 bg-emerald-50 text-emerald-700";
}

function previewDecisionLabel(
  decision: PolicyAssignmentPreviewRollup["decision"],
): string {
  return ko.policyStudio.assignments.rollup.decisions[decision];
}

function sameStringSet(values: readonly string[], expected: ReadonlySet<string>) {
  if (values.length !== expected.size) return false;
  return values.every((value) => expected.has(value));
}

function buildRoleDefinitionDraft(
  displayName: string,
  description: string,
  selected: Partial<Record<string, PermissionLevel>>,
  conditionDrafts: DraftPolicyCondition[],
): PolicyRoleDefinitionDraft | undefined {
  const permissions = Object.entries(selected)
    .filter(
      (entry): entry is [string, PermissionLevel] => entry[1] !== undefined,
    )
    .map(([feature_key, permission_level]) => ({
      feature_key,
      permission_level,
    }));
  const conditions = buildConditionPayload(conditionDrafts);
  if (
    !displayName.trim() ||
    permissions.length === 0 ||
    conditions === undefined
  ) {
    return undefined;
  }
  return {
    display_name: displayName.trim(),
    description: description.trim() ? description.trim() : null,
    permissions,
    ...(conditions.length > 0 ? { conditions } : {}),
  };
}

function buildConditionPayload(
  conditionDrafts: DraftPolicyCondition[],
): PolicyConditionInput[] | undefined {
  const conditions: PolicyConditionInput[] = [];
  for (const [index, condition] of conditionDrafts.entries()) {
    const values = condition.values
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0) {
      return undefined;
    }
    conditions.push({
      condition_key: `${condition.attribute}_${String(index + 1)}`,
      attribute: condition.attribute as PolicyConditionInput["attribute"],
      operator: condition.operator,
      values,
    });
  }
  return conditions;
}

function isPolicyConditionOperator(
  value: string,
): value is PolicyConditionOperator {
  return CONDITION_OPERATORS.includes(value as PolicyConditionOperator);
}

function featureLabel(featureKey: string): string {
  const labels: Record<string, string> = ko.policyStudio.features;
  return labels[featureKey] ?? safeLabel(featureKey);
}

function permissionLabel(permissionLevel: string): string {
  if (permissionLevel === "allow") return ko.policyStudio.levels.allow;
  if (permissionLevel === "limited") return ko.policyStudio.levels.limited;
  if (permissionLevel === "request_only")
    return ko.policyStudio.levels.requestOnly;
  return safeLabel(permissionLevel);
}

function conditionAttributeLabel(attribute: string): string {
  const labels: Record<string, string> = ko.policyStudio.conditionAttributes;
  return labels[attribute] ?? safeLabel(attribute);
}

function conditionOperatorLabel(operator: string): string {
  const labels: Record<string, string> = ko.policyStudio.conditionOperators;
  return labels[operator] ?? safeLabel(operator);
}

function policyAuditActionLabel(action: string): string {
  const labels: Record<string, string> = ko.policyStudio.audit.actions;
  return labels[action] ?? safeLabel(action);
}

function policyAuditTargetLabel(targetType: string): string {
  const labels: Record<string, string> = ko.policyStudio.audit.targets;
  return labels[targetType] ?? safeLabel(targetType);
}

function policyStatusPreviewWarningLabel(warning: string): string {
  const labels: Record<string, string> = ko.policyStudio.statusPreview.warnings;
  return labels[warning] ?? safeLabel(warning);
}

function policyRuntimeWarningLabel(warning: string): string {
  const labels: Record<string, string> =
    ko.policyStudio.assignments.runtimeWarnings;
  return labels[warning] ?? safeLabel(warning);
}

function policyAuditActorLabel(event: PolicyAuditEventResponse): string {
  return event.actor
    ? ko.policyStudio.audit.actorRecorded
    : ko.policyStudio.audit.systemActor;
}

function policyAuditSnapshotLabel(event: PolicyAuditEventResponse): string {
  const before = snapshotObject(event.before_snapshot);
  const after = snapshotObject(event.after_snapshot);
  if (before && after) return ko.policyStudio.audit.diffAvailable;
  if (after) return ko.policyStudio.audit.afterOnly;
  return ko.policyStudio.audit.noSnapshot;
}

function policyAuditSummary(event: PolicyAuditEventResponse): string {
  const before = snapshotObject(event.before_snapshot);
  const after = snapshotObject(event.after_snapshot);
  const directRoleName = safeSnapshotText(after, "display_name");
  if (event.action === "policy.role.create" && directRoleName) {
    return ko.policyStudio.audit.roleCreated.replace(
      "{role}",
      safeLabel(directRoleName),
    );
  }

  const nextRole = snapshotObject(after?.role);
  const previousRole = snapshotObject(before?.role);
  const nextStatus = safeSnapshotText(nextRole, "status");
  const previousStatus = safeSnapshotText(previousRole, "status");
  const nextRoleName = safeSnapshotText(nextRole, "display_name");
  const previousRoleName = safeSnapshotText(previousRole, "display_name");
  if (event.action.includes("role.update") && nextRoleName) {
    return ko.policyStudio.audit.roleUpdated
      .replace(
        "{from}",
        safeLabel(previousRoleName ?? ko.policyStudio.audit.roleTarget),
      )
      .replace("{to}", safeLabel(nextRoleName));
  }
  if (event.action.includes("status_update") && nextStatus) {
    return ko.policyStudio.audit.roleStatusChanged
      .replace(
        "{role}",
        safeLabel(nextRoleName ?? ko.policyStudio.audit.roleTarget),
      )
      .replace(
        "{from}",
        safeLabel(previousStatus ?? ko.policyStudio.audit.unknown),
      )
      .replace("{to}", safeLabel(nextStatus));
  }

  const beforeAssignments = snapshotArray(before?.assignments);
  const afterAssignments = snapshotArray(after?.assignments);
  if (
    event.action.includes("role_assignment") &&
    (beforeAssignments.length > 0 || afterAssignments.length > 0)
  ) {
    return ko.policyStudio.audit.assignmentsChanged
      .replace("{from}", String(beforeAssignments.length))
      .replace("{to}", String(afterAssignments.length));
  }

  return ko.policyStudio.audit.genericEvidence;
}

function snapshotObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function snapshotArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeSnapshotText(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const raw = value?.[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function roleStatusActions(
  status: string,
): Array<{ status: PolicyRoleStatus; label: string }> {
  if (status === "DRAFT") {
    return [{ status: "ACTIVE", label: ko.policyStudio.publish }];
  }
  if (status === "ACTIVE") {
    return [
      { status: "DRAFT", label: ko.policyStudio.rollback },
      { status: "RETIRED", label: ko.policyStudio.retire },
    ];
  }
  return [];
}

function templateCategoryLabel(category: string): string {
  const labels: Record<string, string> = ko.policyStudio.templateCategories;
  return labels[category] ?? safeLabel(category);
}

function formatGrantedCount(
  permissions: Array<{ permission_level: string }>,
): string {
  const granted = permissions.filter(
    (permission) => permission.permission_level !== "deny",
  ).length;
  return ko.policyStudio.grantCount.replace("{count}", String(granted));
}
