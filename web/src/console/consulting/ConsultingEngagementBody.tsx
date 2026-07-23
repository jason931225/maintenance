import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { components } from "@maintenance/api-client-ts";
import { useAuth } from "../../context/auth";
import "../tokens.css";

type Engagement = components["schemas"]["ConsultingEngagement"];
type Detail = components["schemas"]["ConsultingEngagementDetail"];
type Page = components["schemas"]["ConsultingEngagementPage"];
const page: CSSProperties = { height: "100%", overflowY: "auto", padding: "var(--sp-6)", background: "var(--canvas)", color: "var(--ink)" };
const panel: CSSProperties = { border: "var(--border-hairline)", borderRadius: "var(--radius-card)", background: "var(--surface)", padding: "var(--sp-4)", display: "grid", gap: "var(--sp-3)" };
const button: CSSProperties = { minHeight: 40, padding: "0 var(--sp-3)", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", background: "var(--accent)", color: "var(--on-accent)", font: "inherit", cursor: "pointer" };
function message(error: unknown) { const value = error as { error?: { message?: string } }; return value?.error?.message ?? "요청을 완료하지 못했습니다."; }

/** Real API console vertical; every control either performs a supported mutation or is absent. */
export function ConsultingEngagementBody() {
  const { api: authority } = useAuth(); const [data, setData] = useState<Page>(); const [selected, setSelected] = useState<Detail>();
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string>(); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setLoading(true); const r = await authority.GET("/api/v1/consulting/engagements", { params: { query: { limit: 25, offset: 0 } } }).catch(() => undefined); setLoading(false); if (!r?.data) { setError(message(r?.error)); return; } setError(undefined); setData(r.data); }, [authority]);
  const detail = useCallback(async (id: string) => { setBusy(true); const r = await authority.GET("/api/v1/consulting/engagements/{engagement_id}", { params: { path: { engagement_id: id } } }).catch(() => undefined); setBusy(false); if (!r?.data) { setError(message(r?.error)); return; } setError(undefined); setSelected(r.data); }, [authority]);
  useEffect(() => { void load(); }, [load]);
  return <section aria-label="컨설팅 실행" style={page}><header style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)", flexWrap: "wrap" }}><h1 style={{ margin: 0 }}>컨설팅 실행 · 실현효익</h1><button onClick={() => void load()} style={button}>새로고침</button></header>
    <p style={{ ...panel, marginTop: "var(--sp-4)" }}>이 파일럿은 롤아웃 비활성 상태입니다. 고객·승인·증거·KPI 식별자를 임의 입력해 기록을 만들 수 없으며, 권한 있는 소스 선택 및 승인 요청 연결이 제공되기 전에는 읽기 전용입니다.</p>
    {loading ? <p role="status">불러오는 중…</p> : null}{error ? <div role="alert" style={panel}>{error}<button onClick={() => void load()} style={button}>다시 시도</button></div> : null}
    {!loading && !error && data?.items.length === 0 ? <div role="status" style={panel}>표시할 컨설팅 참여가 없습니다.</div> : null}
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px,1fr) minmax(320px,2fr)", gap: "var(--sp-4)", marginTop: "var(--sp-4)" }}><div style={{ display: "grid", gap: "var(--sp-2)" }}>{data?.items.map((item: Engagement) => <button key={item.id} onClick={() => void detail(item.id)} style={{ ...panel, textAlign: "left", cursor: "pointer" }}><b>{item.title}</b><span>{item.status} · v{item.version}</span></button>)}</div>
      <div>{selected ? <article style={panel}><header><h2 style={{ margin: 0 }}>{selected.title}</h2><span>{selected.status} · v{selected.version}</span></header><div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
        <p>변경 작업은 권한 있는 고객·문서·KPI·증거 선택과 서버 발급 승인 연결이 배포될 때까지 사용할 수 없습니다.</p>
        <section><h3>추적 연결</h3><ul>{selected.diagnostics.map(v => <li key={v.id}>진단 {v.id} · 문서 {v.document_id ?? "없음"}</li>)}{selected.findings.map(v => <li key={v.id}>발견 {v.id} · 증거 {v.evidence_id}</li>)}{selected.initiatives.map(v => <li key={v.id}>이니셔티브 {v.id} · KPI 정의 {v.kpi_definition_id}</li>)}{selected.observations.map(v => <li key={v.id}>관측 {v.id} · KPI 정의 {v.kpi_definition_id} · 증거 {v.evidence_id}</li>)}</ul></section>
      </article> : <div style={panel}>왼쪽에서 참여를 선택하면 상세 이력과 다음 허용 작업이 표시됩니다.</div>}</div></div></section>;
}
