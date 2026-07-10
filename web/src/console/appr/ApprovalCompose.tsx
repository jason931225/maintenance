import { useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import "../tokens.css";
import {
  ApprWorkflowApiError,
  createApprWorkflowApi,
  type ApprWorkflowApi,
  type SubmittedComposeRun,
  type WorkflowDecision,
  type WorkflowDecisionResult,
} from "./composeApi";
import {
  createDraftFromTemplate,
  validateComposeDraft,
  type ApprComposeDraft,
  type ApprTemplate,
  type CompletionResult,
  type ObjectLinkRef,
} from "./composeModel";

const T = ko.console.appr;

export interface ApprovalComposeProps {
  api?: ApprWorkflowApi;
  bearerToken?: string;
  currentUserId?: string;
  onSubmitted?: (run: SubmittedComposeRun) => void;
}

export interface ApprovalCompletionPanelProps {
  api?: ApprWorkflowApi;
  bearerToken?: string;
  runId: string;
  taskId: string;
  onCompleted?: (result: CompletionResult) => void;
}

export interface ApprovalDecisionPanelProps {
  api?: ApprWorkflowApi;
  bearerToken?: string;
  taskId: string;
  runId: string;
  currentUserId?: string;
  authorUserId?: string;
  onDecided?: (result: WorkflowDecisionResult) => void;
}

type ComposeStatus = "loading" | "ready" | "submitting" | "submitted" | "serverRejected" | "validation";
type CompletionStatus = "ready" | "submitting" | "completed" | "serverRejected";
type DecisionStatus = "ready" | "submitting" | "decided" | "serverRejected" | "selfBlocked";

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

const panelGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(260px, 320px) minmax(420px, 1fr)",
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

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: "1px solid var(--signal-deep)",
  background: "var(--signal)",
  color: "var(--accent-tx)",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  cursor: "not-allowed",
  opacity: 0.55,
};

const listButtonStyle: CSSProperties = {
  ...buttonStyle,
  width: "100%",
  minHeight: 50,
  display: "grid",
  justifyItems: "stretch",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  textAlign: "left",
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

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 72,
  padding: "var(--sp-3)",
  resize: "vertical",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const lineStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: "var(--sp-3)",
  alignItems: "center",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
};

const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
};

export function ApprovalCompose({ api, bearerToken, currentUserId, onSubmitted }: ApprovalComposeProps) {
  const workflowApi = useApprWorkflowApi(api, bearerToken);
  const [status, setStatus] = useState<ComposeStatus>("loading");
  const [templates, setTemplates] = useState<ApprTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<ApprTemplate | undefined>();
  const [draft, setDraft] = useState<ApprComposeDraft | undefined>();
  const [objectQuery, setObjectQuery] = useState("");
  const [objectResults, setObjectResults] = useState<ObjectLinkRef[]>([]);
  const [submittedRun, setSubmittedRun] = useState<SubmittedComposeRun | undefined>();

  useEffect(() => {
    let cancelled = false;
    workflowApi
      .listSubmittableDefinitions()
      .then((items) => {
        if (cancelled) return;
        setTemplates(items);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("serverRejected");
      });
    return () => {
      cancelled = true;
    };
  }, [workflowApi]);

  function selectTemplate(template: ApprTemplate) {
    setSelectedTemplate(template);
    setDraft(createDraftFromTemplate(template));
    setSubmittedRun(undefined);
    setObjectResults([]);
    setStatus("ready");
  }

  function updateDraft(patch: Partial<ApprComposeDraft>) {
    setDraft((current) => (current ? { ...current, ...patch, validation: { ...current.validation, ...patch.validation } } : current));
  }

  async function searchObjects(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const results = await workflowApi.searchObjects(objectQuery);
    setObjectResults(results);
  }

  function addTarget(target: ObjectLinkRef) {
    setDraft((current) => {
      if (!current) return current;
      if (current.targets.some((item) => item.kind === target.kind && item.id === target.id)) return current;
      return { ...current, targets: [...current.targets, target] };
    });
  }

  function removeTarget(target: ObjectLinkRef) {
    setDraft((current) => {
      if (!current) return current;
      return { ...current, targets: current.targets.filter((item) => item.kind !== target.kind || item.id !== target.id) };
    });
  }

  async function submitDraft() {
    if (!draft || !selectedTemplate) return;
    const validation = validateComposeDraft(draft, selectedTemplate, { currentUserId });
    setDraft({ ...draft, validation: validation.validation });
    if (!validation.valid) {
      setStatus("validation");
      return;
    }
    setStatus("submitting");
    try {
      const run = await workflowApi.submitDraft(draft);
      setSubmittedRun(run);
      setStatus("submitted");
      onSubmitted?.(run);
    } catch (error) {
      setStatus(error instanceof ApprWorkflowApiError ? "serverRejected" : "serverRejected");
    }
  }

  return (
    <section className="console" data-console-appr style={rootStyle} aria-label={T.title}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{T.title}</h1>
        <StatusChip tone={statusTone(status)} role="status">
          {statusLabel(status, draft)}
        </StatusChip>
      </header>
      <div style={panelGridStyle}>
        <section style={cardStyle} aria-label={T.sections.composeGallery}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{T.sections.composeGallery}</h2>
            <StatusChip tone="neutral">{T.count(templates.length)}</StatusChip>
          </div>
          {status === "loading" ? <p style={mutedTextStyle}>{T.status.loading}</p> : null}
          {status !== "loading" && templates.length === 0 ? <p style={mutedTextStyle}>{T.status.emptyCatalog}</p> : null}
          <ul style={listStyle}>
            {templates.map((template) => (
              <li key={template.definitionId}>
                <button
                  type="button"
                  style={listButtonStyle}
                  onClick={() => {
                    selectTemplate(template);
                  }}
                  aria-label={T.actions.selectTemplate(template.label)}
                >
                  <span>{template.label}</span>
                  <span style={chipRowStyle}>
                    {template.definitionVersion ? <StatusChip tone="accent">{T.labels.definitionVersion(template.definitionVersion)}</StatusChip> : null}
                    {template.requiredTargetKinds.map((kind) => (
                      <StatusChip key={kind} tone="info">{T.labels.targetKind(kind)}</StatusChip>
                    ))}
                  </span>
                  <span aria-hidden="true">{T.actions.selectTemplate(template.label)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section style={cardStyle} aria-label={T.sections.compose}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{T.sections.compose}</h2>
            {selectedTemplate ? <StatusChip tone="accent">{T.labels.selectedTemplate(selectedTemplate.label)}</StatusChip> : null}
          </div>
          {draft && selectedTemplate ? (
            <>
              <div style={fieldGridStyle}>
                <label style={fieldStyle}>
                  {T.fields.title}
                  <input
                    aria-invalid={draft.validation.title ? true : undefined}
                    value={draft.title}
                    style={inputStyle}
                    onChange={(event) => {
                      updateDraft({ title: event.currentTarget.value });
                    }}
                  />
                </label>
                {selectedTemplate.reasonOptions.length > 0 ? (
                  <label style={fieldStyle}>
                    {T.fields.reason}
                    <select
                      aria-invalid={draft.validation.reason ? true : undefined}
                      value={draft.reason ?? ""}
                      style={inputStyle}
                      onChange={(event) => {
                        updateDraft({ reason: event.currentTarget.value || null });
                      }}
                    >
                      <option value="">-</option>
                      {selectedTemplate.reasonOptions.map((reason) => (
                        <option key={reason} value={reason}>
                          {reason}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label style={fieldStyle}>
                  {T.fields.body}
                  <textarea
                    value={draft.body}
                    style={textareaStyle}
                    onChange={(event) => {
                      updateDraft({ body: event.currentTarget.value });
                    }}
                  />
                </label>
              </div>
              <section style={cardStyle} aria-label={T.sections.targetLinks}>
                <form
                  style={sectionHeaderStyle}
                  onSubmit={(event) => {
                    void searchObjects(event);
                  }}
                >
                  <label style={fieldStyle}>
                    {T.fields.objectSearch}
                    <input
                      value={objectQuery}
                      style={inputStyle}
                      onChange={(event) => {
                        setObjectQuery(event.currentTarget.value);
                      }}
                    />
                  </label>
                  <button type="submit" style={buttonStyle}>{T.actions.searchObject}</button>
                </form>
                <div style={chipRowStyle}>
                  {objectResults.map((result) => (
                    <button
                      key={`${result.kind}:${result.id}`}
                      type="button"
                      style={buttonStyle}
                      onClick={() => {
                        addTarget(result);
                      }}
                      aria-label={T.actions.connectObject(displayObject(result))}
                    >
                      {displayObject(result)}
                    </button>
                  ))}
                </div>
                <div style={chipRowStyle}>
                  {draft.targets.map((target) => (
                    <button
                      key={`${target.kind}:${target.id}`}
                      type="button"
                      style={buttonStyle}
                      onClick={() => {
                        removeTarget(target);
                      }}
                      aria-label={T.actions.removeTarget(displayObject(target))}
                    >
                      {displayObject(target)}
                    </button>
                  ))}
                </div>
              </section>
              <section style={cardStyle} aria-label={T.sections.approvalLine}>
                <h3 style={sectionTitleStyle}>{T.sections.approvalLine}</h3>
                <ol style={listStyle}>
                  {draft.previewLine.map((node) => (
                    <li key={node.nodeId} style={lineStyle}>
                      <StatusChip tone={lineTone(node.state)}>{node.state}</StatusChip>
                      <span>{node.label} · {node.actorLabel ?? node.actorId ?? "-"}</span>
                    </li>
                  ))}
                </ol>
              </section>
              {draft.validation.sod ? (
                <div role="alert" style={chipRowStyle}>
                  <StatusChip tone="danger">{T.validation.sod}</StatusChip>
                </div>
              ) : null}
              <button
                type="button"
                style={status === "submitting" ? disabledButtonStyle : primaryButtonStyle}
                onClick={() => {
                  void submitDraft();
                }}
                disabled={status === "submitting"}
              >
                {T.actions.submit}
              </button>
              {submittedRun ? (
                <div style={chipRowStyle}>
                  <StatusChip tone="ok">{T.status.submitted}</StatusChip>
                  {submittedRun.code ? <StatusChip tone="accent">{submittedRun.code}</StatusChip> : null}
                </div>
              ) : null}
            </>
          ) : (
            <p style={mutedTextStyle}>{T.status.ready}</p>
          )}
        </section>
      </div>
    </section>
  );
}

export function ApprovalDecisionPanel({
  api,
  bearerToken,
  taskId,
  currentUserId,
  authorUserId,
  onDecided,
}: ApprovalDecisionPanelProps) {
  const workflowApi = useApprWorkflowApi(api, bearerToken);
  const [status, setStatus] = useState<DecisionStatus>("ready");
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<WorkflowDecisionResult | undefined>();
  const selfBlocked = Boolean(currentUserId && authorUserId && currentUserId === authorUserId);

  async function decide(decision: WorkflowDecision) {
    if (selfBlocked) {
      setStatus("selfBlocked");
      return;
    }
    if ((decision === "reject" || decision === "return") && comment.trim().length === 0) {
      setStatus("serverRejected");
      return;
    }
    setStatus("submitting");
    try {
      const nextResult = await workflowApi.decideTask(taskId, decision, { comment: comment.trim() || undefined });
      setResult(nextResult);
      setStatus("decided");
      onDecided?.(nextResult);
    } catch {
      setStatus("serverRejected");
    }
  }

  return (
    <section className="console" style={cardStyle} aria-label={T.sections.approvalLine}>
      <div style={sectionHeaderStyle}>
        <h2 style={sectionTitleStyle}>{T.sections.approvalLine}</h2>
        <StatusChip tone={decisionTone(status)} role={status === "selfBlocked" || status === "serverRejected" ? "alert" : "status"}>
          {decisionLabel(status)}
        </StatusChip>
      </div>
      <label style={fieldStyle}>
        {T.fields.decisionComment}
        <input
          value={comment}
          style={inputStyle}
          onChange={(event) => {
            setComment(event.currentTarget.value);
          }}
        />
      </label>
      <div style={chipRowStyle}>
        <button type="button" style={primaryButtonStyle} onClick={() => { void decide("approve"); }}>
          {T.actions.approve}
        </button>
        <button type="button" style={buttonStyle} onClick={() => { void decide("reject"); }}>
          {T.actions.reject}
        </button>
        <button type="button" style={buttonStyle} onClick={() => { void decide("return"); }}>
          {T.actions.return}
        </button>
      </div>
      {result ? (
        <div style={chipRowStyle}>
          <StatusChip tone="ok">{result.taskStatus}</StatusChip>
          <StatusChip tone="info">{result.runStatus}</StatusChip>
        </div>
      ) : null}
    </section>
  );
}

export function ApprovalCompletionPanel({ api, bearerToken, runId, taskId, onCompleted }: ApprovalCompletionPanelProps) {
  const workflowApi = useApprWorkflowApi(api, bearerToken);
  const [status, setStatus] = useState<CompletionStatus>("ready");
  const [result, setResult] = useState<CompletionResult | undefined>();
  const [delegateReason, setDelegateReason] = useState("");
  const [postRejectReason, setPostRejectReason] = useState("");

  async function finalize(mode: "author" | "delegate") {
    if (mode === "delegate" && delegateReason.trim().length === 0) {
      setStatus("serverRejected");
      return;
    }
    setStatus("submitting");
    try {
      const nextResult = await workflowApi.finalizeTask(taskId, mode, { reason: delegateReason.trim() || undefined });
      setResult(nextResult);
      setStatus("completed");
      onCompleted?.(nextResult);
    } catch {
      setStatus("serverRejected");
    }
  }

  async function postReject() {
    if (postRejectReason.trim().length === 0) {
      setStatus("serverRejected");
      return;
    }
    setStatus("submitting");
    try {
      const nextResult = await workflowApi.postFinalizationReject(runId, postRejectReason.trim());
      setResult(nextResult);
      setStatus("completed");
      onCompleted?.(nextResult);
    } catch {
      setStatus("serverRejected");
    }
  }

  return (
    <section className="console" style={cardStyle} aria-label={T.sections.completion}>
      <div style={sectionHeaderStyle}>
        <h2 style={sectionTitleStyle}>{T.sections.completion}</h2>
        <StatusChip tone={completionTone(status, result)} role={status === "serverRejected" ? "alert" : "status"}>
          {completionLabel(status, result)}
        </StatusChip>
      </div>
      <div style={chipRowStyle}>
        <button type="button" style={primaryButtonStyle} onClick={() => { void finalize("author"); }}>
          {T.actions.finalize}
        </button>
        <label style={fieldStyle}>
          {T.fields.delegateReason}
          <input
            value={delegateReason}
            style={inputStyle}
            onChange={(event) => {
              setDelegateReason(event.currentTarget.value);
            }}
          />
        </label>
        <button type="button" style={buttonStyle} onClick={() => { void finalize("delegate"); }}>
          {T.actions.delegateFinalize}
        </button>
      </div>
      <PolicyGated action="appr.post_finalization_reject" resource={{ kind: "approval_run", id: runId }}>
        <div style={fieldGridStyle}>
          <label style={fieldStyle}>
            {T.fields.postRejectReason}
            <input
              value={postRejectReason}
              style={inputStyle}
              onChange={(event) => {
                setPostRejectReason(event.currentTarget.value);
              }}
            />
          </label>
          <button type="button" style={buttonStyle} onClick={() => { void postReject(); }}>
            {T.actions.postReject}
          </button>
        </div>
      </PolicyGated>
      {result ? (
        <div style={chipRowStyle}>
          {"archive" in result && result.archiveCode ? <StatusChip tone="accent">{result.archiveCode}</StatusChip> : null}
          {"compensationId" in result ? <StatusChip tone="purple">{result.compensationId}</StatusChip> : null}
        </div>
      ) : null}
    </section>
  );
}

function useApprWorkflowApi(api: ApprWorkflowApi | undefined, bearerToken: string | undefined): ApprWorkflowApi {
  return useMemo(() => api ?? createApprWorkflowApi({ bearerToken }), [api, bearerToken]);
}

function displayObject(target: ObjectLinkRef): string {
  return [target.code, target.label].filter(Boolean).join(" ");
}

function statusTone(status: ComposeStatus): "neutral" | "ok" | "warn" | "danger" | "info" | "accent" {
  if (status === "submitted") return "ok";
  if (status === "serverRejected") return "danger";
  if (status === "validation") return "warn";
  if (status === "loading" || status === "submitting") return "info";
  return "neutral";
}

function statusLabel(status: ComposeStatus, draft: ApprComposeDraft | undefined): string {
  if (draft?.validation.sod) return T.status.selfApprovalBlocked;
  if (status === "loading") return T.status.loading;
  if (status === "submitting") return T.status.submitting;
  if (status === "submitted") return T.status.submitted;
  if (status === "serverRejected") return T.status.serverRejected;
  if (status === "validation") return T.status.validation;
  return T.status.ready;
}

function lineTone(state: string): "neutral" | "ok" | "warn" | "danger" | "info" | "accent" {
  if (state === "approved") return "ok";
  if (state === "current") return "accent";
  if (state === "returned") return "warn";
  if (state === "rejected") return "danger";
  return "neutral";
}

function decisionTone(status: DecisionStatus): "neutral" | "ok" | "warn" | "danger" | "info" {
  if (status === "decided") return "ok";
  if (status === "serverRejected" || status === "selfBlocked") return "danger";
  if (status === "submitting") return "info";
  return "neutral";
}

function decisionLabel(status: DecisionStatus): string {
  if (status === "decided") return T.status.submitted;
  if (status === "selfBlocked") return T.status.selfApprovalBlocked;
  if (status === "serverRejected") return T.status.serverRejected;
  if (status === "submitting") return T.status.submitting;
  return T.status.ready;
}

function completionTone(
  status: CompletionStatus,
  result: CompletionResult | undefined,
): "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "purple" {
  if (status === "serverRejected") return "danger";
  if (status === "submitting") return "info";
  if (result && "compensationId" in result) return "purple";
  if (result && "archive" in result && result.archive === "visible") return "ok";
  if (result && "archive" in result && result.archive === "blocked_records_archive") return "warn";
  return "neutral";
}

function completionLabel(status: CompletionStatus, result: CompletionResult | undefined): string {
  if (status === "serverRejected") return T.status.serverRejected;
  if (status === "submitting") return T.status.submitting;
  if (result && "compensationId" in result) return T.status.compensationCreated;
  if (result && "archive" in result && result.archive === "visible") return T.status.archiveVisible;
  if (result && "archive" in result && result.archive === "blocked_records_archive") return T.status.archiveBlocked;
  return T.status.ready;
}
