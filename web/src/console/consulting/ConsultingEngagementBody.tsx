import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

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
const C = {
  pilotNotice: "참여 상태, 근거, KPI 연결과 승인 이력을 실제 권한 범위에서 관리합니다.",
  actions: "실행 단계",
  current: "현재 상태 새로고침",
  reason: "전환 사유",
  approval: "승인 ID",
  diagnosticSummary: "진단 요약",
  documentId: "문서 ID (선택)",
  findingStatement: "발견 진술",
  evidenceId: "증거 ID",
  initiativeTitle: "이니셔티브 제목",
  hypothesis: "가설",
  kpiDefinitionId: "KPI 정의 ID",
  observedAt: "관측 시각",
  note: "관측 메모",
  recordDiagnostic: "진단 기록",
  recordFinding: "근거 연결 발견 기록",
  proposeInitiative: "KPI 이니셔티브 제안",
  recordObservation: "효익 관측 기록",
  proposed: "제안으로 전환",
  approved: "승인으로 전환",
  implemented: "구현으로 전환",
  measured: "측정으로 전환",
  sustained: "지속으로 전환",
  corrective: "시정으로 전환",
  direction: "목표 방향",
  increase: "증가",
  decrease: "감소",
  needsDiagnostic: "발견을 기록하려면 먼저 진단이 필요합니다.",
  needsFinding: "이니셔티브를 제안하려면 먼저 근거 연결 발견이 필요합니다.",
  needsInitiative: "구현 전환은 실제 KPI 이니셔티브가 필요합니다.",
  needsObservation: "측정, 지속 또는 시정 전환은 실제 효익 관측이 필요합니다.",
  needsApproval: "승인 전환은 별도 승인자가 발급한 미사용 승인 ID가 필요합니다.",
  saved: "기록이 저장되었습니다. 서버 이력과 상세를 다시 읽었습니다.",
} as const;
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
  return { PROPOSED: C.proposed, APPROVED: C.approved, IMPLEMENTED: C.implemented, MEASURED: C.measured, SUSTAINED: C.sustained, CORRECTIVE: C.corrective }[status];
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
    setError(undefined); setNotice(C.saved); await readDetail(id, request);
  }, [begin, busy, current, readDetail, selected]);

  const createDiagnostic = useCallback((event: FormEvent) => {
    event.preventDefault();
    if (!selected || !isNonEmpty(diagnosticSummary)) return;
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/diagnostics", { params: { path: { engagement_id: selected.id } }, body: { summary: diagnosticSummary.trim(), ...(isNonEmpty(diagnosticDocumentId) ? { documentId: diagnosticDocumentId.trim() } : {}) }, signal: request.controller.signal }));
  }, [authority, diagnosticDocumentId, diagnosticSummary, run, selected]);
  const createFinding = useCallback((event: FormEvent) => {
    event.preventDefault();
    const diagnostic = selected?.diagnostics.at(-1);
    if (!selected || !diagnostic || !isNonEmpty(findingStatement) || !isNonEmpty(findingEvidenceId)) return;
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/findings", { params: { path: { engagement_id: selected.id } }, body: { diagnosticId: diagnostic.id, statement: findingStatement.trim(), evidenceId: findingEvidenceId.trim(), ...(isNonEmpty(findingDocumentId) ? { documentId: findingDocumentId.trim() } : {}) }, signal: request.controller.signal }));
  }, [authority, findingDocumentId, findingEvidenceId, findingStatement, run, selected]);
  const createInitiative = useCallback((event: FormEvent) => {
    event.preventDefault();
    const finding = selected?.findings.at(-1);
    if (!selected || !finding || !isNonEmpty(initiativeTitle) || !isNonEmpty(hypothesis) || !isNonEmpty(kpiDefinitionId)) return;
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/initiatives", { params: { path: { engagement_id: selected.id } }, body: { findingId: finding.id, title: initiativeTitle.trim(), hypothesis: hypothesis.trim(), kpiDefinitionId: kpiDefinitionId.trim(), targetDirection }, signal: request.controller.signal }));
  }, [authority, hypothesis, initiativeTitle, kpiDefinitionId, run, selected, targetDirection]);
  const createObservation = useCallback((event: FormEvent) => {
    event.preventDefault();
    const initiative = selected?.initiatives.at(-1);
    const observedAtIso = asIso(observedAt);
    if (!selected || !initiative || !isNonEmpty(observationEvidenceId) || !isNonEmpty(observationNote) || !observedAtIso) return;
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/observations", { params: { path: { engagement_id: selected.id } }, body: { initiativeId: initiative.id, kpiDefinitionId: initiative.kpi_definition_id, evidenceId: observationEvidenceId.trim(), observedAt: observedAtIso, note: observationNote.trim() }, signal: request.controller.signal }));
  }, [authority, observationEvidenceId, observationNote, observedAt, run, selected]);
  const transition = useCallback((toStatus: TransitionStatus) => {
    if (!selected || !isNonEmpty(reason)) return;
    if (toStatus === "MEASURED" && selected.observations.length === 0) { setError(C.needsObservation); return; }
    void run(request => authority.POST("/api/v1/consulting/engagements/{engagement_id}/transition", { params: { path: { engagement_id: selected.id } }, body: { toStatus, expectedVersion: selected.version, reason: reason.trim(), ...(toStatus === "APPROVED" && isNonEmpty(approvalId) ? { approvalId: approvalId.trim() } : {}) }, signal: request.controller.signal }));
  }, [approvalId, authority, reason, run, selected]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }); return () => { window.clearTimeout(timer); abort.current?.abort(); }; }, [load]);

  const next = selected ? nextStatus(selected.status) : undefined;
  const transitions = selected?.status === "MEASURED" ? ["SUSTAINED", "CORRECTIVE"] as const : next ? [next] : [];
  return <section aria-label={T.region} style={page}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)", flexWrap: "wrap" }}><h1 style={{ margin: 0 }}>{T.title}</h1><button type="button" onClick={() => void load()} style={button}>{T.refresh}</button></header>
    <p style={{ ...panel, marginTop: "var(--sp-4)" }}>{C.pilotNotice}</p>
    {loading ? <p role="status">{T.loading}</p> : null}
    {error ? <div role="alert" style={panel}><span>{error}</span>{selected ? <button type="button" onClick={() => void refreshSelected()} style={button}>{C.current}</button> : <button type="button" onClick={() => void load()} style={button}>{T.retry}</button>}</div> : null}
    {notice ? <p role="status" style={panel}>{notice}</p> : null}
    {!loading && !error && data?.items.length === 0 ? <div role="status" style={panel}>{T.empty}</div> : null}
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px,1fr) minmax(320px,2fr)", gap: "var(--sp-4)", marginTop: "var(--sp-4)" }}>
      <div style={{ display: "grid", gap: "var(--sp-2)", alignContent: "start" }}>{data?.items.map((item: Engagement) => <button type="button" key={item.id} onClick={() => void detail(item.id)} aria-pressed={selected?.id === item.id} style={{ ...panel, textAlign: "left", cursor: "pointer", color: "var(--ink)" }}><b>{item.title}</b><span>{statusLabel(item.status)} · v{item.version}</span></button>)}</div>
      <div>{selected ? <article style={panel} aria-busy={busy}>
        <header><h2 style={{ margin: 0 }}>{selected.title}</h2><span>{statusLabel(selected.status)} · v{selected.version}</span></header>
        <section><h3>{T.lineage}</h3><ul>{selected.diagnostics.map(value => <li key={value.id}>{T.diagnostic} {value.summary} · {T.document} {value.document_id ?? T.none}</li>)}{selected.findings.map(value => <li key={value.id}>{T.finding} {value.statement} · {T.evidence} {value.evidence_id}</li>)}{selected.initiatives.map(value => <li key={value.id}>{T.initiative} {value.title} · {T.kpiDefinition} {value.kpi_definition_id}</li>)}{selected.observations.map(value => <li key={value.id}>{T.observation} {value.note} · {T.kpiDefinition} {value.kpi_definition_id} · {T.evidence} {value.evidence_id}</li>)}</ul></section>
        <section style={panel} aria-label={C.actions}><h3 style={{ margin: 0 }}>{C.actions}</h3>
          {selected.status === "DRAFT" ? <form onSubmit={createDiagnostic} style={panel}><label style={field}>{C.diagnosticSummary}<input aria-label={C.diagnosticSummary} style={input} value={diagnosticSummary} onChange={event => setDiagnosticSummary(event.target.value)} required /></label><label style={field}>{C.documentId}<input aria-label={C.documentId} style={input} value={diagnosticDocumentId} onChange={event => setDiagnosticDocumentId(event.target.value)} /></label><button style={button} disabled={busy}>{C.recordDiagnostic}</button></form> : null}
          {selected.status === "DRAFT" && selected.diagnostics.length > 0 ? <form onSubmit={createFinding} style={panel}><label style={field}>{C.findingStatement}<input aria-label={C.findingStatement} style={input} value={findingStatement} onChange={event => setFindingStatement(event.target.value)} required /></label><label style={field}>{C.evidenceId}<input aria-label={C.evidenceId} style={input} value={findingEvidenceId} onChange={event => setFindingEvidenceId(event.target.value)} required /></label><label style={field}>{C.documentId}<input aria-label={C.documentId} style={input} value={findingDocumentId} onChange={event => setFindingDocumentId(event.target.value)} /></label><button style={button} disabled={busy}>{C.recordFinding}</button></form> : null}
          {selected.status === "DRAFT" && selected.findings.length > 0 ? <form onSubmit={createInitiative} style={panel}><label style={field}>{C.initiativeTitle}<input aria-label={C.initiativeTitle} style={input} value={initiativeTitle} onChange={event => setInitiativeTitle(event.target.value)} required /></label><label style={field}>{C.hypothesis}<input aria-label={C.hypothesis} style={input} value={hypothesis} onChange={event => setHypothesis(event.target.value)} required /></label><label style={field}>{C.kpiDefinitionId}<input aria-label={C.kpiDefinitionId} style={input} value={kpiDefinitionId} onChange={event => setKpiDefinitionId(event.target.value)} required /></label><label style={field}>{C.direction}<select aria-label={C.direction} style={input} value={targetDirection} onChange={event => setTargetDirection(event.target.value === "DECREASE" ? "DECREASE" : "INCREASE")}><option value="INCREASE">{C.increase}</option><option value="DECREASE">{C.decrease}</option></select></label><button style={button} disabled={busy}>{C.proposeInitiative}</button></form> : null}
          {selected.status === "IMPLEMENTED" && selected.initiatives.length > 0 ? <form onSubmit={createObservation} style={panel}><label style={field}>{C.evidenceId}<input aria-label={C.evidenceId} style={input} value={observationEvidenceId} onChange={event => setObservationEvidenceId(event.target.value)} required /></label><label style={field}>{C.observedAt}<input aria-label={C.observedAt} type="datetime-local" style={input} value={observedAt} onChange={event => setObservedAt(event.target.value)} required /></label><label style={field}>{C.note}<input aria-label={C.note} style={input} value={observationNote} onChange={event => setObservationNote(event.target.value)} required /></label><button style={button} disabled={busy}>{C.recordObservation}</button></form> : null}
          {selected.status === "DRAFT" && selected.diagnostics.length === 0 ? <p>{C.needsDiagnostic}</p> : null}
          {selected.status === "DRAFT" && selected.diagnostics.length > 0 && selected.findings.length === 0 ? <p>{C.needsFinding}</p> : null}
          {selected.status === "APPROVED" && selected.initiatives.length === 0 ? <p>{C.needsInitiative}</p> : null}
          {(selected.status === "IMPLEMENTED" || selected.status === "MEASURED") && selected.observations.length === 0 ? <p>{C.needsObservation}</p> : null}
          {transitions.length > 0 ? <form onSubmit={event => { event.preventDefault(); transition(transitions[0]); }} style={panel}><label style={field}>{C.reason}<input aria-label={C.reason} style={input} value={reason} onChange={event => setReason(event.target.value)} required /></label>{selected.status === "PROPOSED" ? <><p>{C.needsApproval}</p><label style={field}>{C.approval}<input aria-label={C.approval} style={input} value={approvalId} onChange={event => setApprovalId(event.target.value)} required /></label></> : null}<div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>{transitions.map(toStatus => <button key={toStatus} type={transitions.length === 1 ? "submit" : "button"} onClick={transitions.length === 1 ? undefined : () => transition(toStatus)} style={button} disabled={busy || !isNonEmpty(reason) || (toStatus === "APPROVED" && !isNonEmpty(approvalId)) || (toStatus === "IMPLEMENTED" && selected.initiatives.length === 0) || ((toStatus === "MEASURED" || toStatus === "SUSTAINED" || toStatus === "CORRECTIVE") && selected.observations.length === 0)}>{transitionLabel(toStatus)}</button>)}</div></form> : null}
        </section>
        <section><h3>{T.history}</h3>{history.length === 0 ? <p>{T.historyEmpty}</p> : <ol>{history.map(item => <li key={item.id}>{eventLabel(item.event_type)} · v{item.version}</li>)}</ol>}</section>
      </article> : <div style={panel}>{T.select}</div>}</div>
    </div>
  </section>;
}
