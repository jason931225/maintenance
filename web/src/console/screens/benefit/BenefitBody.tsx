import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import type { components } from "@maintenance/api-client-ts";

import { useAuth } from "../../../context/auth";
import { DENY_ALL_PROJECTION, fetchAuthzProjection, gateAllows, type AuthzProjection } from "../../policy/authz";
import "../../tokens.css";

type BenefitItem = components["schemas"]["BenefitCatalogItem"];
type BenefitPage = components["schemas"]["BenefitCatalogItemPage"];

const pageStyle: CSSProperties = { height: "100%", overflowY: "auto", padding: "var(--sp-6)", background: "var(--canvas)", color: "var(--ink)", fontFamily: "var(--font-sans)" };
const panelStyle: CSSProperties = { border: "var(--border-hairline)", borderRadius: "var(--radius-card)", background: "var(--surface)", boxShadow: "var(--shadow)" };
const chipStyle: CSSProperties = { display: "inline-flex", alignItems: "center", minHeight: 26, padding: "0 var(--sp-2)", borderRadius: 999, border: "1px solid var(--border)", background: "var(--muted)", fontSize: "var(--text-caption)", whiteSpace: "nowrap" };

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "error" in error) {
    const nested = (error as { error?: { message?: unknown } }).error;
    if (typeof nested?.message === "string" && nested.message.trim()) return nested.message;
  }
  return "복리후생 목록을 불러오지 못했습니다.";
}

function nextState(state: string | null | undefined): string | undefined {
  return ({ draft: "pending", pending: "finalized", finalized: "implemented", implemented: "retiring", retiring: "retired" } as const)[state ?? ""];
}

function lifecycleLabel(state: string | null | undefined): string {
  return ({ draft: "초안", pending: "승인 대기", finalized: "시행 예정", implemented: "시행 중", retiring: "폐지 예정", retired: "폐지됨" } as Record<string, string>)[state ?? ""] ?? "상태 미등록";
}

function scopeLabel(item: BenefitItem): string {
  if (item.scope.site_id) return "사업장 적용";
  if (item.scope.branch_id) return "법인 적용";
  return item.scope.scope_type === "ORG" ? "전사 적용" : `${item.scope.scope_type} 적용`;
}

export function BenefitBody() {
  const { api, session } = useAuth();
  const authority = api;
  const [category, setCategory] = useState<"legal" | "extra">("legal");
  const [page, setPage] = useState<BenefitPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [advancing, setAdvancing] = useState<string>();
  const [projection, setProjection] = useState<AuthzProjection>(DENY_ALL_PROJECTION);
  const [authzReady, setAuthzReady] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const result = await authority.GET("/api/v1/benefit-catalog/items", { params: { query: { category, limit: 50, offset: 0 } } }).catch(() => undefined);
    if (!result?.data) {
      setPage(undefined);
      setError(errorMessage(result?.error));
      setLoading(false);
      return;
    }
    setPage(result.data);
    setLoading(false);
  }, [authority, category]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthzProjection(session?.access_token, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setProjection(next ?? DENY_ALL_PROJECTION);
      setAuthzReady(true);
    });
    return () => controller.abort();
  }, [session?.access_token]);

  const annualCost = useMemo(() => page?.items.reduce((total, item) => total + (item.estimated_annual_cost_won ?? 0), 0) ?? 0, [page]);
  const canAdvanceLifecycle = authzReady && gateAllows(projection, { feature: "lifecycle_manage" });
  const advance = useCallback(async (item: BenefitItem) => {
    const to_state = nextState(item.lifecycle.current_state);
    if (!to_state || item.lifecycle.legal_hold) return;
    setAdvancing(item.id);
    const result = await authority.POST("/api/v1/lifecycles/{objectType}/{objectId}/transition", {
      params: { path: { objectType: item.lifecycle.object_type, objectId: item.lifecycle.object_id } },
      body: { toState: to_state, reason: `benefit_catalog:${item.benefit_code}` },
    }).catch(() => undefined);
    setAdvancing(undefined);
    if (!result?.data) {
      setError(errorMessage(result?.error));
      return;
    }
    await load();
  }, [authority, load]);

  return <section aria-label="복리후생" style={pageStyle}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-4)", alignItems: "start", marginBottom: "var(--sp-5)", flexWrap: "wrap" }}>
      <div><h1 style={{ margin: 0, fontSize: "var(--text-title)", letterSpacing: "-0.02em" }}>복리후생</h1></div>
      <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <span style={chipStyle}>{page?.total ?? 0}개 정책</span>
        {annualCost > 0 ? <span style={chipStyle}>연 ₩{annualCost.toLocaleString("ko-KR")}</span> : null}
      </div>
    </header>
    <div role="tablist" aria-label="복리후생 분류" style={{ display: "flex", gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
      {([ ["legal", "법정"], ["extra", "선택" ] ] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={category === value} onClick={() => setCategory(value)} style={{ minHeight: 40, padding: "0 var(--sp-4)", cursor: "pointer", border: category === value ? "1px solid var(--accent)" : "var(--border-hairline)", borderRadius: "var(--radius-sm)", background: category === value ? "var(--accent-soft)" : "var(--surface)", color: "var(--ink)", font: "inherit" }}>{label}</button>)}
    </div>
    {loading ? <div style={{ ...panelStyle, padding: "var(--sp-5)" }} role="status">복리후생 정책을 불러오는 중…</div> : null}
    {error ? <div style={{ ...panelStyle, padding: "var(--sp-5)", display: "grid", gap: "var(--sp-3)", justifyItems: "start" }} role="alert"><span>{error}</span><button onClick={() => void load()} style={{ minHeight: 40, padding: "0 var(--sp-4)", border: "var(--border-hairline)", borderRadius: "var(--radius-sm)", background: "var(--muted)", color: "var(--ink)", font: "inherit", cursor: "pointer" }}>다시 시도</button></div> : null}
    {!loading && !error && page?.items.length === 0 ? <div style={{ ...panelStyle, padding: "var(--sp-6)" }} role="status">이 분류에 등록된 복리후생 정책이 없습니다.</div> : null}
    {!loading && !error && page?.items.length ? <div style={{ display: "grid", gap: "var(--sp-3)" }}>{page.items.map((item) => {
      const next = nextState(item.lifecycle.current_state);
      return <article key={item.id} style={{ ...panelStyle, padding: "var(--sp-4)", display: "grid", gap: "var(--sp-3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)", flexWrap: "wrap" }}><div><div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}><strong style={{ fontSize: "var(--text-body)" }}>{item.name}</strong><code style={{ color: "var(--ink-muted)", fontSize: "var(--text-caption)" }}>{item.benefit_code}</code><span style={chipStyle}>{lifecycleLabel(item.lifecycle.current_state)}</span></div><div style={{ marginTop: "var(--sp-1)", color: "var(--ink-muted)", fontSize: "var(--text-caption)" }}>{scopeLabel(item)} · {item.coverage_label} · {item.cost_label}</div></div>{canAdvanceLifecycle && next && !item.lifecycle.legal_hold ? <button aria-label="다음 상태" disabled={advancing === item.id} onClick={() => void advance(item)} style={{ minHeight: 40, padding: "0 var(--sp-3)", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", background: "var(--accent)", color: "var(--on-accent)", font: "inherit", cursor: "pointer" }}>{advancing === item.id ? "처리 중…" : "다음 상태"}</button> : null}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--sp-3)", borderTop: "var(--border-hairline)", paddingTop: "var(--sp-3)" }}>
          <div><b style={{ fontSize: "var(--text-caption)" }}>적격성</b><div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1)", marginTop: "var(--sp-1)" }}>{item.conditions.length ? item.conditions.map((condition) => <span key={condition.id} style={chipStyle}>{condition.display_label}</span>) : <span style={{ color: "var(--ink-muted)", fontSize: "var(--text-caption)" }}>등록된 조건 없음</span>}</div></div>
          <div><b style={{ fontSize: "var(--text-caption)" }}>등급</b><div style={{ display: "grid", gap: "var(--sp-1)", marginTop: "var(--sp-1)" }}>{item.tiers.length ? item.tiers.map((tier) => <span key={tier.id} style={{ fontSize: "var(--text-caption)" }}><b>{tier.tier_basis} · {tier.tier_key}</b> · {tier.value_label}</span>) : <span style={{ color: "var(--ink-muted)", fontSize: "var(--text-caption)" }}>등록된 등급 없음</span>}</div></div>
          <div><b style={{ fontSize: "var(--text-caption)" }}>근거·연결</b><div style={{ marginTop: "var(--sp-1)", color: "var(--ink-muted)", fontSize: "var(--text-caption)" }}>{item.legal_basis ?? item.note ?? "등록된 근거 없음"}{item.related_domain ? ` · ${item.related_domain}` : ""}</div></div>
        </div>
      </article>;
    })}</div> : null}
  </section>;
}
