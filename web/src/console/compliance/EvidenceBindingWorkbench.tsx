import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import {
  createEvidenceBinding,
  readEvidenceBindingWorkspace,
  type EvidenceBindingWorkspace,
} from "./complianceApi";
import type { EvidenceBinding } from "./types";
import "./EvidenceBindingWorkbench.css";

type LoadState = "loading" | "ready" | "denied" | "error";
type Issue = "invalid" | "range" | "conflict" | "denied" | "failed";

const TARGET_TYPES = [
  "audit_event",
  "evidence_media",
  "workflow_run",
  "workflow_task",
  "object_link",
  "governance_finding",
  "external_document",
  "future_ev_object",
] as const;
const CONFIDENCES = ["LOW", "MEDIUM", "HIGH", "SYSTEM"] as const;

function isDenied(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}

function issueText(issue: Issue): string {
  switch (issue) {
    case "invalid": return "Select a control and provide an evidence ID.";
    case "range": return "Valid to cannot precede valid from.";
    case "conflict": return "This conflicts with another change. Refresh server state and retry.";
    case "denied": return "You are not authorized to propose this evidence binding.";
    case "failed": return "The evidence binding was not saved. Retry the request.";
  }
}

function formatAt(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function newestFirst(bindings: EvidenceBinding[]): EvidenceBinding[] {
  return [...bindings].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Evidence workbench: a policy-gated control→evidence proposal surface.
 * It deliberately renders statuses only as returned by the backend. This API
 * has no evidence-status transition route, so it never presents fictional
 * accept/reject/expire actions.
 */
export function EvidenceBindingWorkbench({
  api,
  authorityKey,
  canRead = true,
  canWrite,
}: {
  api: ConsoleApiClient;
  authorityKey: string | undefined;
  canRead?: boolean;
  canWrite: boolean;
}) {
  const controllerRef = useRef<AbortController | null>(null);
  const writeControllerRef = useRef<AbortController | null>(null);
  const readEpochRef = useRef(0);
  const authorityEpochRef = useRef(0);
  const [workspace, setWorkspace] = useState<EvidenceBindingWorkspace>({ controls: [], obligations: [], bindings: [] });
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [issue, setIssue] = useState<Issue | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedBindingId, setSelectedBindingId] = useState<string | null>(null);
  const [controlId, setControlId] = useState("");
  const [obligationId, setObligationId] = useState("");
  const [targetType, setTargetType] = useState<(typeof TARGET_TYPES)[number]>("external_document");
  const [targetId, setTargetId] = useState("");
  const [confidence, setConfidence] = useState<(typeof CONFIDENCES)[number]>("HIGH");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const epoch = ++readEpochRef.current;
    setLoadState("loading");
    try {
      const next = await readEvidenceBindingWorkspace(api, controller.signal);
      if (controller.signal.aborted || epoch !== readEpochRef.current) return;
      setWorkspace(next);
      setSelectedBindingId((current) => current && next.bindings.some((item) => item.id === current) ? current : null);
      setLoadState("ready");
    } catch (error: unknown) {
      if (controller.signal.aborted || epoch !== readEpochRef.current) return;
      setLoadState(isDenied(error) ? "denied" : "error");
    }
  }, [api]);

  useEffect(() => {
    const run = async () => {
      await Promise.resolve();
      if (canRead && authorityKey) await refresh();
    };
    void run();
    return () => {
      authorityEpochRef.current += 1;
      readEpochRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      writeControllerRef.current?.abort();
      writeControllerRef.current = null;
    };
  }, [authorityKey, canRead, refresh]);

  const bindings = useMemo(() => newestFirst(workspace.bindings), [workspace.bindings]);
  const selectedBinding = bindings.find((item) => item.id === selectedBindingId);
  const controls = useMemo(() => [...workspace.controls].sort((left, right) =>
    `${left.frameworkCode}:${left.controlKey}`.localeCompare(`${right.frameworkCode}:${right.controlKey}`),
  ), [workspace.controls]);

  const submit = useCallback(async () => {
    const trimmedTargetId = targetId.trim();
    if (!controlId || !trimmedTargetId) {
      setIssue("invalid");
      return;
    }
    if (validFrom && validTo && validTo < validFrom) {
      setIssue("range");
      return;
    }
    const authorityEpoch = authorityEpochRef.current;
    const controller = new AbortController();
    writeControllerRef.current?.abort();
    writeControllerRef.current = controller;
    setIssue(null);
    setBusy(true);
    try {
      await createEvidenceBinding(api, {
        control_id: controlId,
        ...(obligationId ? { obligation_id: obligationId } : {}),
        evidence_target_type: targetType,
        evidence_target_id: trimmedTargetId,
        confidence,
        ...(validFrom ? { valid_from: validFrom } : {}),
        ...(validTo ? { valid_to: validTo } : {}),
      }, controller.signal);
      if (controller.signal.aborted || authorityEpoch !== authorityEpochRef.current) return;
      setTargetId("");
      setValidFrom("");
      setValidTo("");
      await refresh();
    } catch (error: unknown) {
      if (controller.signal.aborted || authorityEpoch !== authorityEpochRef.current) return;
      setIssue(error instanceof ApiCallError && error.status === 409 ? "conflict" : isDenied(error) ? "denied" : "failed");
    } finally {
      if (writeControllerRef.current === controller) writeControllerRef.current = null;
      if (!controller.signal.aborted && authorityEpoch === authorityEpochRef.current) setBusy(false);
    }
  }, [api, confidence, controlId, obligationId, refresh, targetId, targetType, validFrom, validTo]);

  if (!canRead || !authorityKey) return null;

  return (
    <section aria-label="Evidence bindings" className="evidence-workbench">
      <header className="evidence-workbench__heading">
        <div>
          <p className="evidence-workbench__eyebrow">CONTROL EVIDENCE</p>
          <h2>Evidence bindings</h2>
          <p>Review server-authorized control evidence, status, and source identity.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy || loadState === "loading"}>Refresh</button>
      </header>
      {issue ? <div role="alert" className="evidence-workbench__alert">{issueText(issue)} <button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loadState === "loading" ? <p role="status">Loading evidence bindings.</p> : null}
      {loadState === "denied" ? <p role="alert">You are not authorized to view evidence bindings.</p> : null}
      {loadState === "error" ? <div role="alert">Evidence bindings could not be loaded. <button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {canWrite ? (
        <form className="evidence-workbench__form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label>Control
            <select aria-label="Control" value={controlId} onChange={(event) => { setControlId(event.target.value); }} disabled={busy || loadState !== "ready"}>
              <option value="">Select a control</option>
              {controls.map((control) => <option key={control.id} value={control.id}>{control.frameworkCode} · {control.controlKey} · {control.title}</option>)}
            </select>
          </label>
          <label>Obligation (optional)
            <select aria-label="Obligation (optional)" value={obligationId} onChange={(event) => { setObligationId(event.target.value); }} disabled={busy || loadState !== "ready"}>
              <option value="">No obligation link</option>
              {workspace.obligations.map((obligation) => <option key={obligation.id} value={obligation.id}>{obligation.code} · {obligation.title}</option>)}
            </select>
          </label>
          <label>Evidence type
            <select aria-label="Evidence type" value={targetType} onChange={(event) => { setTargetType(event.target.value as (typeof TARGET_TYPES)[number]); }} disabled={busy}>
              {TARGET_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>Evidence ID<input aria-label="Evidence ID" value={targetId} onChange={(event) => { setTargetId(event.target.value); }} disabled={busy} /></label>
          <label>Confidence
            <select aria-label="Confidence" value={confidence} onChange={(event) => { setConfidence(event.target.value as (typeof CONFIDENCES)[number]); }} disabled={busy}>
              {CONFIDENCES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>Valid from<input aria-label="Valid from" type="date" value={validFrom} onChange={(event) => { setValidFrom(event.target.value); }} disabled={busy} /></label>
          <label>Valid to<input aria-label="Valid to" type="date" value={validTo} onChange={(event) => { setValidTo(event.target.value); }} disabled={busy} /></label>
          <button type="submit" disabled={busy || loadState !== "ready"}>{busy ? "Linking…" : "Propose binding"}</button>
        </form>
      ) : null}
      {loadState === "ready" && bindings.length === 0 ? <p>There are no evidence bindings in the authorized scope.</p> : null}
      {loadState === "ready" && bindings.length > 0 ? (
        <div className="evidence-workbench__layout">
          <div className="evidence-workbench__table-wrap">
            <table>
              <thead><tr><th scope="col">Control</th><th scope="col">Evidence ID</th><th scope="col">Status</th><th scope="col">Confidence</th><th scope="col">Valid to</th><th scope="col">Recorded</th></tr></thead>
              <tbody>{bindings.map((binding) => {
                const control = controls.find((item) => item.id === binding.controlId);
                const obligation = workspace.obligations.find((item) => item.id === binding.obligationId);
                return <tr key={binding.id} aria-selected={binding.id === selectedBindingId}>
                  <td>{control ? `${control.controlKey} · ${control.title}` : binding.controlId}{obligation ? ` · ${obligation.code}` : ""}</td>
                  <td><button type="button" onClick={() => { setSelectedBindingId(binding.id); }} aria-label={`${binding.evidenceTargetId} details`}>{binding.evidenceTargetId}</button></td>
                  <td>{binding.status}</td><td>{binding.confidence}</td><td>{binding.validTo ?? "—"}</td><td>{formatAt(binding.createdAt)}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          {selectedBinding ? <aside aria-label="Selected evidence details" className="evidence-workbench__detail">
            <h3>Evidence details</h3>
            <dl>
              <dt>Status</dt><dd>{selectedBinding.status}</dd>
              <dt>Type</dt><dd>{selectedBinding.evidenceTargetType}</dd>
              <dt>Evidence ID</dt><dd>{selectedBinding.evidenceTargetId}</dd>
              <dt>Control ID</dt><dd>{selectedBinding.controlId}</dd>
              <dt>Obligation</dt><dd>{selectedBinding.obligationId ? workspace.obligations.find((item) => item.id === selectedBinding.obligationId)?.code ?? selectedBinding.obligationId : "—"}</dd>
              <dt>Valid from</dt><dd>{selectedBinding.validFrom ?? "—"}</dd>
              <dt>Valid to</dt><dd>{selectedBinding.validTo ?? "—"}</dd>
              <dt>Source audit event</dt><dd>{selectedBinding.sourceAuditEventId ?? "—"}</dd>
              <dt>Collected at</dt><dd>{formatAt(selectedBinding.collectedAt)}</dd>
              <dt>Collected by</dt><dd>{selectedBinding.collectedBy ?? "—"}</dd>
              <dt>Created by</dt><dd>{selectedBinding.createdBy}</dd>
              <dt>Updated by</dt><dd>{selectedBinding.updatedBy}</dd>
              <dt>Hash</dt><dd>{selectedBinding.hashSha256 ?? "—"}</dd>
            </dl>
          </aside> : null}
        </div>
      ) : null}
    </section>
  );
}
