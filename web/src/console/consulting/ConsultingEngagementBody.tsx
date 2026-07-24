import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import type { components } from "@maintenance/api-client-ts";

import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import "../tokens.css";

type Engagement = components["schemas"]["ConsultingEngagement"];
type Detail = components["schemas"]["ConsultingEngagementDetail"];
type History = components["schemas"]["ConsultingHistoryEntry"];
type Page = components["schemas"]["ConsultingEngagementPage"];

const T = ko.console.consulting;
const page: CSSProperties = { height: "100%", overflowY: "auto", padding: "var(--sp-6)", background: "var(--canvas)", color: "var(--ink)" };
const panel: CSSProperties = { border: "var(--border-hairline)", borderRadius: "var(--radius-card)", background: "var(--surface)", padding: "var(--sp-4)", display: "grid", gap: "var(--sp-3)" };
const button: CSSProperties = { minHeight: 40, padding: "0 var(--sp-3)", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", background: "var(--accent)", color: "var(--on-accent)", font: "inherit", cursor: "pointer" };

function message(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return T.requestFailed;
}

function statusLabel(status: Engagement["status"]): string {
  return T.status[status];
}

function eventLabel(event: string): string {
  return Object.hasOwn(T.event, event) ? T.event[event as keyof typeof T.event] : event;
}

/** Read-only, rollout-dark surface. Every response is fenced to its auth incarnation. */
export function ConsultingEngagementBody() {
  const { api: authority, session } = useAuth();
  const [data, setData] = useState<Page>();
  const [selected, setSelected] = useState<Detail>();
  const [history, setHistory] = useState<History[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
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

  const load = useCallback(async () => {
    const request = begin();
    setLoading(true);
    setSelected(undefined);
    setHistory([]);
    const r = await authority.GET("/api/v1/consulting/engagements", { params: { query: { limit: 25, offset: 0 } }, signal: request.controller.signal }).catch(() => undefined);
    if (!current(request)) return;
    setLoading(false);
    if (!r?.data) { setError(message(r?.error)); return; }
    setError(undefined);
    setData(r.data);
  }, [authority, begin, current]);

  const detail = useCallback(async (id: string) => {
    const request = begin();
    setBusy(true);
    const [detailResult, historyResult] = await Promise.all([
      authority.GET("/api/v1/consulting/engagements/{engagement_id}", { params: { path: { engagement_id: id } }, signal: request.controller.signal }).catch(() => undefined),
      authority.GET("/api/v1/consulting/engagements/{engagement_id}/history", { params: { path: { engagement_id: id } }, signal: request.controller.signal }).catch(() => undefined),
    ]);
    if (!current(request)) return;
    setBusy(false);
    if (!detailResult?.data) { setError(message(detailResult?.error)); return; }
    if (!historyResult?.data) { setError(T.historyFailed); return; }
    setError(undefined);
    setSelected(detailResult.data);
    setHistory(historyResult.data);
  }, [authority, begin, current]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); });
    return () => { window.clearTimeout(timer); abort.current?.abort(); };
  }, [load]);

  return <section aria-label={T.region} style={page}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)", flexWrap: "wrap" }}>
      <h1 style={{ margin: 0 }}>{T.title}</h1><button onClick={() => void load()} style={button}>{T.refresh}</button>
    </header>
    <p style={{ ...panel, marginTop: "var(--sp-4)" }}>{T.pilotNotice}</p>
    {loading ? <p role="status">{T.loading}</p> : null}
    {error ? <div role="alert" style={panel}>{error}<button onClick={() => void load()} style={button}>{T.retry}</button></div> : null}
    {!loading && !error && data?.items.length === 0 ? <div role="status" style={panel}>{T.empty}</div> : null}
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px,1fr) minmax(320px,2fr)", gap: "var(--sp-4)", marginTop: "var(--sp-4)" }}>
      <div style={{ display: "grid", gap: "var(--sp-2)" }}>{data?.items.map((item: Engagement) => <button key={item.id} onClick={() => void detail(item.id)} style={{ ...panel, textAlign: "left", cursor: "pointer" }}><b>{item.title}</b><span>{statusLabel(item.status)} · v{item.version}</span></button>)}</div>
      <div>{selected ? <article style={panel} aria-busy={busy}>
        <header><h2 style={{ margin: 0 }}>{selected.title}</h2><span>{statusLabel(selected.status)} · v{selected.version}</span></header>
        <section><h3>{T.lineage}</h3><ul>{selected.diagnostics.map(v => <li key={v.id}>{T.diagnostic} {v.id} · {T.document} {v.document_id ?? T.none}</li>)}{selected.findings.map(v => <li key={v.id}>{T.finding} {v.id} · {T.evidence} {v.evidence_id}</li>)}{selected.initiatives.map(v => <li key={v.id}>{T.initiative} {v.id} · {T.kpiDefinition} {v.kpi_definition_id}</li>)}{selected.observations.map(v => <li key={v.id}>{T.observation} {v.id} · {T.kpiDefinition} {v.kpi_definition_id} · {T.evidence} {v.evidence_id}</li>)}</ul></section>
        <section><h3>{T.history}</h3>{history.length === 0 ? <p>{T.historyEmpty}</p> : <ol>{history.map(item => <li key={item.id}>{eventLabel(item.event_type)} · v{item.version}</li>)}</ol>}</section>
      </article> : <div style={panel}>{T.select}</div>}</div>
    </div>
  </section>;
}
