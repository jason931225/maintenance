import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";

import type { components } from "@maintenance/api-client-ts";

import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import "../tokens.css";

type Engagement = components["schemas"]["ConsultingEngagement"];
type Detail = components["schemas"]["ConsultingEngagementDetail"];
type History = components["schemas"]["ConsultingHistoryEntry"];
type Page = components["schemas"]["ConsultingEngagementPage"];
type Status = Engagement["status"];
type TransitionStatus = Exclude<Status, "DRAFT">;

const T = ko.console.consulting;
const page: CSSProperties = { height: "100%", overflowY: "auto", padding: "var(--sp-6)", background: "var(--canvas)", color: "var(--ink)" };
const panel: CSSProperties = { border: "var(--border-hairline)", borderRadius: "var(--radius-card)", background: "var(--surface)", padding: "var(--sp-4)", display: "grid", gap: "var(--sp-3)" };
const button: CSSProperties = { minHeight: 40, padding: "0 var(--sp-3)", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", background: "var(--accent)", color: "var(--on-accent)", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { display: "grid", gap: "var(--sp-1)", minWidth: 0 };
const input: CSSProperties = { minHeight: 40, border: "var(--border-hairline)", borderRadius: "var(--radius-sm)", padding: "0 var(--sp-2)", background: "var(--canvas)", color: "var(--ink)", font: "inherit" };

function message(error: unknown): string {
  if (typeof error !== "object" || error === null) return T.requestFailed;
  if ("message" in error && typeof error.message === "string") return error.message;
  if ("error" in error && typeof error.error === "object" && error.error !== null && "message" in error.error && typeof error.error.message === "string") return error.error.message;
  return T.requestFailed;
}
function statusLabel(status: Engagement["status"]): string { return T.status[status]; }
function eventLabel(event: string): string { return Object.hasOwn(T.event, event) ? T.event[event as keyof typeof T.event] : event; }
function nextStatus(status: Status): TransitionStatus | undefined {
  if (status === "DRAFT") return "PROPOSED";
  if (status === "PROPOSED") return "APPROVED";
  if (status === "APPROVED") return "IMPLEMENTED";
  if (status === "IMPLEMENTED") return "MEASURED";
  return undefined;
}
function transitionLabel(status: TransitionStatus): string {
  return { PROPOSED: T.proposed, APPROVED: T.approved, IMPLEMENTED: T.implemented, MEASURED: T.measured, SUSTAINED: T.sustained, CORRECTIVE: T.corrective }[status];
}
function isNonEmpty(value: string): boolean { return value.trim().length > 0; }
function asIso(value: string): string | undefined {
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? undefined : instant.toISOString();
}

/** A typed, tenant-fenced lifecycle console over Consulting's real evidence, KPI, approval, and history APIs. */
export function ConsultingEngagementBody() {
  const { api: authority, session } = useAuth();
  const [data, setData] = useState<Page>();
  const [selected, setSelected] = useState<Detail>();
  const [history, setHistory] = useState<History[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [approvalId, setApprovalId] = useState("");
  const [diagnosticSummary, setDiagnosticSummary] = useState("");
  const [diagnosticDocumentId, setDiagnosticDocumentId] = useState("");
  const [findingStatement, setFindingStatement] = useState("");
  const [findingEvidenceId, setFindingEvidenceId] = useState("");
  const [findingDocumentId, setFindingDocumentId] = useState("");
  const [initiativeTitle, setInitiativeTitle] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [kpiDefinitionId, setKpiDefinitionId] = useState("");
  const [targetDirection, setTargetDirection] = useState<"INCREASE" | "DECREASE">("INCREASE");
  const [observationEvidenceId, setObservationEvidenceId] = useState("");
  const [observationNote, setObservationNote] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const generation = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const authKey = `${session?.org_id ?? ""}:${session?.user_id ?? ""}:${session?.client_session_incarnation ?? ""}:${session?.access_token ?? ""}`;

  const begin = useCallback(() => {
    generation.current += 1;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    return { controller, generation: generation.current, authKey };
  }, [authKey]);
  const current = useCallback((request: { generation: number; authKey: string }) => request.generation === generation.current && request.authKey === authKey, [authKey]);

  const readDetail = useCallback(async (id: string, request: { controller: AbortController; generation: number; authKey: string }) => {
    const [detailResult, historyResult] = await Promise.all([
      authority.GET("/api/v1/consulting/engagements/{engagement_id}", { params: { path: { engagement_id: id } }, signal: request.controller.signal }).catch(() => undefined),
      authority.GET("/api/v1/consulting/engagements/{engagement_id}/history", { params: { path: { engagement_id: id } }, signal: request.controller.signal }).catch(() => undefined),
    ]);
    if (!current(request)) return;
    setBusy(false);
    if (!detailResult?.data) { setError(message(detailResult?.error)); return; }
    if (!historyResult?.data) { setError(T.historyFailed); return; }
    setError(undefined);
    setData(previous => previous ? { ...previous, items: previous.items.map(item => item.id === id ? detailResult.data : item) } : previous);
    setSelected(detailResult.data);
    setHistory(historyResult.data);
  }, [authority, current]);

  const load = useCallback(async () => {
    const request = begin();
    setLoading(true); setSelected(undefined); setHistory([]); setNotice(undefined);
    const r = await authority.GET("/api/v1/consulting/engagements", { params: { query: { limit: 25, offset: 0 } }, signal: request.controller.signal }).catch(() => undefined);
    if (!current(request)) return;
    setLoading(false);
    if (!r?.data) { setError(message(r?.error)); return; }
    setError(undefined); setData(r.data);
  }, [authority, begin, current]);
  const detail = useCallback(async (id: string) => {
    const request = begin(); setBusy(true); setNotice(undefined); await readDetail(id, request);
  }, [begin, readDetail]);
  const refreshSelected = useCallback(async () => { if (selected) await detail(selected.id); }, [detail, selected]);
  const run = useCallback(async (operation: (request: { controller: AbortController; generation: number; authKey: string }) => Promise<{ data?: unknown; error?: unknown } | undefined>) => {
    if (!selected || busy) return;
    const id = selected.id;
    const request = begin(); setBusy(true); setNotice(undefined);
    const result = await operation(request).catch(() => undefined);
    if (!current(request)) return;
    if (!result?.data) { setBusy(false); setError(message(result?.error)); return; }
    setError(undefined); setNotice(T.saved); await readDetail(id, request);
  }, [begin, busy, current, readDetail, selected]);

  const createDiagnostic = useCallback((event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !isNonEmpty(diagnosticSummary)) return;
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/diagnostics", { params: { path: { engagement_id: selected.id } }, body: { summary: diagnosticSummary.trim(), ...(isNonEmpty(diagnosticDocumentId) ? { documentId: diagnosticDocumentId.trim() } : {}) }, signal: request.controller.signal }));
  }, [authority, diagnosticDocumentId, diagnosticSummary, run, selected]);
  const createFinding = useCallback((event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const diagnostic = selected?.diagnostics.at(-1);
    if (!selected || !diagnostic || !isNonEmpty(findingStatement) || !isNonEmpty(findingEvidenceId)) return;
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/findings", { params: { path: { engagement_id: selected.id } }, body: { diagnosticId: diagnostic.id, statement: findingStatement.trim(), evidenceId: findingEvidenceId.trim(), ...(isNonEmpty(findingDocumentId) ? { documentId: findingDocumentId.trim() } : {}) }, signal: request.controller.signal }));
  }, [authority, findingDocumentId, findingEvidenceId, findingStatement, run, selected]);
  const createInitiative = useCallback((event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const finding = selected?.findings.at(-1);
    if (!selected || !finding || !isNonEmpty(initiativeTitle) || !isNonEmpty(hypothesis) || !isNonEmpty(kpiDefinitionId)) return;
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/initiatives", { params: { path: { engagement_id: selected.id } }, body: { findingId: finding.id, title: initiativeTitle.trim(), hypothesis: hypothesis.trim(), kpiDefinitionId: kpiDefinitionId.trim(), targetDirection }, signal: request.controller.signal }));
  }, [authority, hypothesis, initiativeTitle, kpiDefinitionId, run, selected, targetDirection]);
  const createObservation = useCallback((event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const initiative = selected?.initiatives.at(-1);
    const observedAtIso = asIso(observedAt);
    if (!selected || !initiative || !isNonEmpty(observationEvidenceId) || !isNonEmpty(observationNote) || !observedAtIso) return;
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/observations", { params: { path: { engagement_id: selected.id } }, body: { initiativeId: initiative.id, kpiDefinitionId: initiative.kpi_definition_id, evidenceId: observationEvidenceId.trim(), observedAt: observedAtIso, note: observationNote.trim() }, signal: request.controller.signal }));
  }, [authority, observationEvidenceId, observationNote, observedAt, run, selected]);
  const transition = useCallback((toStatus: TransitionStatus) => {
    if (!selected || !isNonEmpty(reason)) return;
    if (toStatus === "MEASURED" && selected.observations.length === 0) { setError(T.needsObservation); return; }
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/transition", { params: { path: { engagement_id: selected.id } }, body: { toStatus, expectedVersion: selected.version, reason: reason.trim(), ...(toStatus === "APPROVED" && isNonEmpty(approvalId) ? { approvalId: approvalId.trim() } : {}) }, signal: request.controller.signal }));
  }, [approvalId, authority, reason, run, selected]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }); return () => { window.clearTimeout(timer); abort.current?.abort(); }; }, [load]);

  const next = selected ? nextStatus(selected.status) : undefined;
  const transitions = selected?.status === "MEASURED" ? ["SUSTAINED", "CORRECTIVE"] as const : next ? [next] : [];
  return <section aria-label={T.region} style={page}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)", flexWrap: "wrap" }}><h1 style={{ margin: 0 }}>{T.title}</h1><button type="button" onClick={() => void load()} style={button}>{T.refresh}</button></header>
    <p style={{ ...panel, marginTop: "var(--sp-4)" }}>{T.pilotNotice}</p>
    {loading ? <p role="status">{T.loading}</p> : null}
    {error ? <div role="alert" style={panel}><span>{error}</span>{selected ? <button type="button" onClick={() => void refreshSelected()} style={button}>{T.current}</button> : <button type="button" onClick={() => void load()} style={button}>{T.retry}</button>}</div> : null}
    {notice ? <p role="status" style={panel}>{notice}</p> : null}
    {!loading && !error && data?.items.length === 0 ? <div role="status" style={panel}>{T.empty}</div> : null}
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px,1fr) minmax(320px,2fr)", gap: "var(--sp-4)", marginTop: "var(--sp-4)" }}>
      <div style={{ display: "grid", gap: "var(--sp-2)", alignContent: "start" }}>{data?.items.map((item: Engagement) => <button type="button" key={item.id} onClick={() => void detail(item.id)} aria-pressed={selected?.id === item.id} style={{ ...panel, textAlign: "left", cursor: "pointer", color: "var(--ink)" }}><b>{item.title}</b><span>{statusLabel(item.status)} · v{item.version}</span></button>)}</div>
      <div>{selected ? <article style={panel} aria-busy={busy}>
        <header><h2 style={{ margin: 0 }}>{selected.title}</h2><span>{statusLabel(selected.status)} · v{selected.version}</span></header>
        <section><h3>{T.lineage}</h3><ul>{selected.diagnostics.map(value => <li key={value.id}>{T.diagnostic} {value.summary} · {T.document} {value.document_id ?? T.none}</li>)}{selected.findings.map(value => <li key={value.id}>{T.finding} {value.statement} · {T.evidence} {value.evidence_id}</li>)}{selected.initiatives.map(value => <li key={value.id}>{T.initiative} {value.title} · {T.kpiDefinition} {value.kpi_definition_id}</li>)}{selected.observations.map(value => <li key={value.id}>{T.observation} {value.note} · {T.kpiDefinition} {value.kpi_definition_id} · {T.evidence} {value.evidence_id}</li>)}</ul></section>
        <section style={panel} aria-label={T.actions}><h3 style={{ margin: 0 }}>{T.actions}</h3>
          {selected.status === "DRAFT" ? <form onSubmit={createDiagnostic} style={panel}><label style={field}>{T.diagnosticSummary}<input aria-label={T.diagnosticSummary} style={input} value={diagnosticSummary} onChange={event => { setDiagnosticSummary(event.target.value); }} required /></label><label style={field}>{T.documentId}<input aria-label={T.documentId} style={input} value={diagnosticDocumentId} onChange={event => { setDiagnosticDocumentId(event.target.value); }} /></label><button style={button} disabled={busy}>{T.recordDiagnostic}</button></form> : null}
          {selected.status === "DRAFT" && selected.diagnostics.length > 0 ? <form onSubmit={createFinding} style={panel}><label style={field}>{T.findingStatement}<input aria-label={T.findingStatement} style={input} value={findingStatement} onChange={event => { setFindingStatement(event.target.value); }} required /></label><label style={field}>{T.evidenceId}<input aria-label={T.evidenceId} style={input} value={findingEvidenceId} onChange={event => { setFindingEvidenceId(event.target.value); }} required /></label><label style={field}>{T.documentId}<input aria-label={T.documentId} style={input} value={findingDocumentId} onChange={event => { setFindingDocumentId(event.target.value); }} /></label><button style={button} disabled={busy}>{T.recordFinding}</button></form> : null}
          {selected.status === "DRAFT" && selected.findings.length > 0 ? <form onSubmit={createInitiative} style={panel}><label style={field}>{T.initiativeTitle}<input aria-label={T.initiativeTitle} style={input} value={initiativeTitle} onChange={event => { setInitiativeTitle(event.target.value); }} required /></label><label style={field}>{T.hypothesis}<input aria-label={T.hypothesis} style={input} value={hypothesis} onChange={event => { setHypothesis(event.target.value); }} required /></label><label style={field}>{T.kpiDefinitionId}<input aria-label={T.kpiDefinitionId} style={input} value={kpiDefinitionId} onChange={event => { setKpiDefinitionId(event.target.value); }} required /></label><label style={field}>{T.direction}<select aria-label={T.direction} style={input} value={targetDirection} onChange={event => { setTargetDirection(event.target.value === "DECREASE" ? "DECREASE" : "INCREASE"); }}><option value="INCREASE">{T.increase}</option><option value="DECREASE">{T.decrease}</option></select></label><button style={button} disabled={busy}>{T.proposeInitiative}</button></form> : null}
          {selected.status === "IMPLEMENTED" && selected.initiatives.length > 0 ? <form onSubmit={createObservation} style={panel}><label style={field}>{T.evidenceId}<input aria-label={T.evidenceId} style={input} value={observationEvidenceId} onChange={event => { setObservationEvidenceId(event.target.value); }} required /></label><label style={field}>{T.observedAt}<input aria-label={T.observedAt} type="datetime-local" style={input} value={observedAt} onChange={event => { setObservedAt(event.target.value); }} required /></label><label style={field}>{T.note}<input aria-label={T.note} style={input} value={observationNote} onChange={event => { setObservationNote(event.target.value); }} required /></label><button style={button} disabled={busy}>{T.recordObservation}</button></form> : null}
          {selected.status === "DRAFT" && selected.diagnostics.length === 0 ? <p>{T.needsDiagnostic}</p> : null}
          {selected.status === "DRAFT" && selected.diagnostics.length > 0 && selected.findings.length === 0 ? <p>{T.needsFinding}</p> : null}
          {selected.status === "APPROVED" && selected.initiatives.length === 0 ? <p>{T.needsInitiative}</p> : null}
          {(selected.status === "IMPLEMENTED" || selected.status === "MEASURED") && selected.observations.length === 0 ? <p>{T.needsObservation}</p> : null}
          {transitions.length > 0 ? <form onSubmit={event => { event.preventDefault(); transition(transitions[0]); }} style={panel}><label style={field}>{T.reason}<input aria-label={T.reason} style={input} value={reason} onChange={event => { setReason(event.target.value); }} required /></label>{selected.status === "PROPOSED" ? <><p>{T.needsApproval}</p><label style={field}>{T.approval}<input aria-label={T.approval} style={input} value={approvalId} onChange={event => { setApprovalId(event.target.value); }} required /></label></> : null}<div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>{transitions.map(toStatus => <button key={toStatus} type={transitions.length === 1 ? "submit" : "button"} onClick={transitions.length === 1 ? undefined : () => { transition(toStatus); }} style={button} disabled={busy || !isNonEmpty(reason) || (toStatus === "APPROVED" && !isNonEmpty(approvalId)) || (toStatus === "IMPLEMENTED" && selected.initiatives.length === 0) || ((toStatus === "MEASURED" || toStatus === "SUSTAINED" || toStatus === "CORRECTIVE") && selected.observations.length === 0)}>{transitionLabel(toStatus)}</button>)}</div></form> : null}
        </section>
        <section><h3>{T.history}</h3>{history.length === 0 ? <p>{T.historyEmpty}</p> : <ol>{history.map(item => <li key={item.id}>{eventLabel(item.event_type)} · v{item.version}</li>)}</ol>}</section>
      </article> : <div style={panel}>{T.select}</div>}</div>
    </div>
  </section>;
}
