export type ApprLineState =
  | "pending"
  | "current"
  | "approved"
  | "returned"
  | "rejected"
  | "skipped";

export type ApprStatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "purple";

export interface ApprLineNodeInput {
  node_id?: string;
  nodeId?: string;
  key?: string;
  label?: string;
  actor_id?: string | null;
  actorId?: string | null;
  actor_label?: string | null;
  actorLabel?: string | null;
  role?: string | null;
  state?: string | null;
  status?: string | null;
  decided_at?: string | null;
  decidedAt?: string | null;
  comment_required?: boolean | null;
  commentRequired?: boolean | null;
}

export interface ApprovalLineNode {
  nodeId: string;
  label: string;
  actorId?: string;
  actorLabel?: string;
  state: ApprLineState;
  decidedAt?: string;
  commentRequired?: boolean;
}

export interface ApprSubmittableDefinition {
  id: string;
  display_name?: string;
  displayName?: string;
  workflow_key?: string;
  workflowKey?: string;
  object_type?: string;
  objectType?: string;
  active_version?: number;
  activeVersion?: number;
  definition?: Record<string, unknown> | null;
  approval_line?: ApprLineNodeInput[] | null;
  approvalLine?: ApprLineNodeInput[] | null;
}

export interface ApprTemplate {
  definitionId: string;
  definitionVersion?: number;
  workflowKey?: string;
  label: string;
  reasonOptions: string[];
  requiredTargetKinds: string[];
  optionalTargetKinds: string[];
  attachmentPolicy?: "none" | "evidence_required" | "optional";
  previewLine: ApprovalLineNode[];
  tone: ApprStatusTone;
}

export interface ObjectLinkRef {
  kind: string;
  id: string;
  code?: string;
  label: string;
  policyAction: string;
}

export interface EvidenceRef {
  id: string;
  label: string;
  code?: string;
}

export interface ApprComposeValidation {
  title?: "required";
  reason?: "required";
  targets?: "required";
  evidence?: "required";
  sod?: "self_approval";
}

export interface ApprComposeDraft {
  definitionId: string;
  definitionVersion?: number;
  title: string;
  reason: string | null;
  body: string;
  targets: ObjectLinkRef[];
  evidence: EvidenceRef[];
  previewLine: ApprovalLineNode[];
  validation: ApprComposeValidation;
}

export interface ComposeValidationResult {
  valid: boolean;
  validation: ApprComposeValidation;
}

export interface StartWorkflowRunRequest {
  definition_id: string;
  definition_version?: number;
  object_type?: string;
  object_id?: string;
  trigger_type: "MANUAL";
  idempotency_key: string;
  correlation_id?: string;
  input_payload: Record<string, unknown>;
  context_payload: Record<string, unknown>;
}

export interface CreateObjectLinkRequest {
  src_kind: string;
  src_id: string;
  dst_kind: string;
  dst_id: string;
  link_type: string;
}

export interface BackendRunIdentity {
  runId: string;
  code?: string;
}

export interface ComposerCandidateSource {
  id?: string;
  label: string;
}

export interface ApprComposerSources {
  members: ComposerCandidateSource[];
  channels: ComposerCandidateSource[];
  objectCodes: string[];
}

export type ApprComposerCandidateKind = "mention" | "channel" | "object";

export interface ApprComposerCandidate {
  kind: ApprComposerCandidateKind;
  label: string;
  insertText: string;
  id?: string;
}

export type ArchiveVisibility = "pending" | "visible" | "blocked_records_archive";

export interface FinalizedWorkflowTask {
  id?: string;
  task_id?: string;
  run_id: string;
  status: string;
  completed_by?: string;
  decision_payload?: Record<string, unknown>;
}

export interface FinalizedWorkflowRun {
  id: string;
  status: string;
}

export interface FinalizeWorkflowTaskResponse {
  task: FinalizedWorkflowTask;
  run: FinalizedWorkflowRun;
  archive_ref?: Record<string, unknown>;
}

export interface PostFinalizationRejectionDocument {
  id: string;
  original_run_id: string;
  reason: string;
  created_by: string;
}

export interface PostFinalizationNotification {
  id?: string;
  channel?: string;
  recipient_id?: string;
  status?: string;
}

export interface PostFinalizationRejectionResponse {
  compensation: PostFinalizationRejectionDocument;
  notifications?: PostFinalizationNotification[];
  run: FinalizedWorkflowRun;
}

export type CompletionResult =
  | {
      mode: "author" | "delegate";
      runId: string;
      status: string;
      archive: ArchiveVisibility;
      archiveCode?: string;
    }
  | {
      mode: "post_rejection";
      runId: string;
      status: string;
      compensationId: string;
      notificationCount: number;
    };

const OBJECT_CODE_RE = /^(?:AP|WO|AT|CS|JL|PS|IN|DX|Bid|MT|EV|OT|SR|PAY|EQ|VC|FL|HR|TK|C|R)-[A-Za-z0-9-]*$/;
const ATTACHMENT_POLICIES = new Set(["none", "evidence_required", "optional"]);

export function mapSubmittableDefinition(definition: ApprSubmittableDefinition): ApprTemplate {
  const definitionBody = definition.definition ?? {};
  const activeVersion = numberFromUnknown(definition.active_version ?? definition.activeVersion);
  return {
    definitionId: definition.id,
    definitionVersion: activeVersion,
    workflowKey: stringFromUnknown(definition.workflow_key ?? definition.workflowKey),
    label: stringFromUnknown(definition.display_name ?? definition.displayName) ?? definition.id,
    reasonOptions: stringArrayFromDefinition(definitionBody, ["reason_options", "reasonOptions", "reasons"]),
    requiredTargetKinds: stringArrayFromDefinition(definitionBody, ["required_target_kinds", "requiredTargetKinds", "required_targets", "requiredTargets"]),
    optionalTargetKinds: stringArrayFromDefinition(definitionBody, ["optional_target_kinds", "optionalTargetKinds", "optional_targets", "optionalTargets"]),
    attachmentPolicy: attachmentPolicyFromUnknown(definitionBody.attachment_policy ?? definitionBody.attachmentPolicy),
    previewLine: (definition.approval_line ?? definition.approvalLine ?? []).map(mapLineNode),
    tone: "accent",
  };
}

export function createDraftFromTemplate(template: ApprTemplate): ApprComposeDraft {
  return {
    definitionId: template.definitionId,
    definitionVersion: template.definitionVersion,
    title: "",
    reason: template.reasonOptions.length === 1 ? template.reasonOptions[0] : null,
    body: "",
    targets: [],
    evidence: [],
    previewLine: template.previewLine,
    validation: {},
  };
}

export function validateComposeDraft(
  draft: ApprComposeDraft,
  template: ApprTemplate,
  options: { currentUserId?: string } = {},
): ComposeValidationResult {
  const validation: ApprComposeValidation = {};
  if (!draft.title.trim()) validation.title = "required";
  if (template.reasonOptions.length > 0 && !draft.reason) validation.reason = "required";
  if (!hasRequiredTargets(draft.targets, template.requiredTargetKinds)) validation.targets = "required";
  if (template.attachmentPolicy === "evidence_required" && draft.evidence.length === 0) {
    validation.evidence = "required";
  }
  if (lineHasSelfApproval(draft.previewLine, options.currentUserId)) {
    validation.sod = "self_approval";
  }
  return { valid: Object.keys(validation).length === 0, validation };
}

export function buildStartWorkflowRunRequest(
  draft: ApprComposeDraft,
  options: { idempotencyKey: string; correlationId?: string },
): StartWorkflowRunRequest {
  const primaryTarget = draft.targets.at(0);
  return removeUndefined({
    definition_id: draft.definitionId,
    definition_version: draft.definitionVersion,
    object_type: primaryTarget?.kind,
    object_id: primaryTarget?.id,
    trigger_type: "MANUAL" as const,
    idempotency_key: options.idempotencyKey,
    correlation_id: options.correlationId,
    input_payload: {
      title: draft.title.trim(),
      reason: draft.reason,
      body: draft.body,
      targets: draft.targets.map((target) => ({
        kind: target.kind,
        id: target.id,
        code: target.code,
        label: target.label,
      })),
      target_codes: draft.targets.flatMap((target) => (target.code ? [target.code] : [])),
      evidence: draft.evidence.map((item) => ({ id: item.id, label: item.label, code: item.code })),
    },
    context_payload: {
      object_links: draft.targets.map((target) => ({
        kind: target.kind,
        id: target.id,
        link_type: "approval_target",
      })),
    },
  });
}

export function buildObjectLinkRequests(
  run: BackendRunIdentity,
  targets: ObjectLinkRef[],
): CreateObjectLinkRequest[] {
  return targets.map((target) => ({
    src_kind: "approval_run",
    src_id: run.runId,
    dst_kind: target.kind,
    dst_id: target.id,
    link_type: "approval_target",
  }));
}

export function buildApprComposerCandidates(
  value: string,
  caret: number,
  sources: ApprComposerSources,
): ApprComposerCandidate[] {
  const token = tokenBeforeCaret(value, caret);
  if (!token || token.startsWith("!")) return [];
  if (token.startsWith("@")) {
    const query = normalize(token.slice(1));
    return sources.members
      .filter((member) => normalize(member.label).includes(query))
      .slice(0, 8)
      .map((member) => ({
        kind: "mention",
        id: member.id,
        label: member.label,
        insertText: `@${member.label}`,
      }));
  }
  if (token.startsWith("#")) {
    const query = normalize(token.slice(1));
    return sources.channels
      .filter((channel) => normalize(channel.label).includes(query))
      .slice(0, 8)
      .map((channel) => ({
        kind: "channel",
        id: channel.id,
        label: channel.label,
        insertText: `#${channel.label}`,
      }));
  }
  if (OBJECT_CODE_RE.test(token)) {
    const query = normalize(token);
    return sources.objectCodes
      .filter((code) => normalize(code).startsWith(query))
      .slice(0, 8)
      .map((code) => ({ kind: "object", label: code, insertText: code }));
  }
  return [];
}

export function deriveArchiveVisibility(response: Pick<FinalizeWorkflowTaskResponse, "run" | "archive_ref">): ArchiveVisibility {
  if (archiveCode(response.archive_ref) || stringFromUnknown(response.archive_ref?.id)) return "visible";
  if (["SUCCEEDED", "FINALIZED", "COMPLETED"].includes(response.run.status.toUpperCase())) {
    return "blocked_records_archive";
  }
  return "pending";
}

export function deriveCompletionResult(
  response: FinalizeWorkflowTaskResponse | PostFinalizationRejectionResponse,
): CompletionResult {
  if ("compensation" in response) {
    return {
      mode: "post_rejection",
      runId: response.run.id,
      status: response.run.status,
      compensationId: response.compensation.id,
      notificationCount: response.notifications?.length ?? 0,
    };
  }
  const mode = response.task.decision_payload?.mode === "delegate" ? "delegate" : "author";
  return removeUndefined({
    mode,
    runId: response.run.id,
    status: response.run.status,
    archive: deriveArchiveVisibility(response),
    archiveCode: archiveCode(response.archive_ref),
  });
}

function mapLineNode(node: ApprLineNodeInput, index: number): ApprovalLineNode {
  const nodeId = stringFromUnknown(node.node_id ?? node.nodeId ?? node.key) ?? `node-${String(index + 1)}`;
  const state = mapLineState(node.state ?? node.status);
  return removeUndefined({
    nodeId,
    label: stringFromUnknown(node.label ?? node.role) ?? nodeId,
    actorId: stringFromUnknown(node.actor_id ?? node.actorId),
    actorLabel: stringFromUnknown(node.actor_label ?? node.actorLabel),
    state,
    decidedAt: stringFromUnknown(node.decided_at ?? node.decidedAt),
    commentRequired: booleanFromUnknown(node.comment_required ?? node.commentRequired),
  });
}

function mapLineState(value: unknown): ApprLineState {
  const normalized = stringFromUnknown(value)?.toLowerCase();
  if (normalized === "current" || normalized === "waiting" || normalized === "claimed" || normalized === "open") return "current";
  if (normalized === "approved" || normalized === "succeeded" || normalized === "completed") return "approved";
  if (normalized === "returned" || normalized === "return") return "returned";
  if (normalized === "rejected" || normalized === "reject" || normalized === "failed") return "rejected";
  if (normalized === "skipped" || normalized === "cancelled") return "skipped";
  return "pending";
}

function hasRequiredTargets(targets: ObjectLinkRef[], requiredKinds: string[]): boolean {
  return requiredKinds.every((kind) => targets.some((target) => target.kind === kind));
}

function lineHasSelfApproval(line: ApprovalLineNode[], currentUserId: string | undefined): boolean {
  if (!currentUserId) return false;
  const normalizedUser = normalize(currentUserId);
  return line.some((node) => {
    if (!node.actorId || normalize(node.actorId) !== normalizedUser) return false;
    return node.state === "current" || node.state === "pending";
  });
}

function attachmentPolicyFromUnknown(value: unknown): ApprTemplate["attachmentPolicy"] {
  const normalized = stringFromUnknown(value);
  if (normalized && ATTACHMENT_POLICIES.has(normalized)) {
    return normalized as ApprTemplate["attachmentPolicy"];
  }
  return undefined;
}

function stringArrayFromDefinition(definition: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = definition[key];
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const stringValue = stringFromUnknown(item);
        return stringValue ? [stringValue] : [];
      });
    }
  }
  return [];
}

function archiveCode(ref: Record<string, unknown> | undefined): string | undefined {
  return stringFromUnknown(ref?.code ?? ref?.document_code ?? ref?.documentCode ?? ref?.ap_code ?? ref?.apCode);
}

function tokenBeforeCaret(value: string, caret: number): string {
  const before = value.slice(0, caret);
  return before.split(/\s/).at(-1) ?? "";
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("ko-KR");
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanFromUnknown(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function removeUndefined<TValue extends Record<string, unknown>>(value: TValue): TValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as TValue;
}
