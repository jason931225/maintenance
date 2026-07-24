import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import type { components } from "@maintenance/api-client-ts";

import { useAuth } from "../../context/auth";
import { toLocalDateTimeInput } from "./facilitiesDate";

export type FacilitiesCase = components["schemas"]["FacilitiesCase"];
type FacilitiesApi = ReturnType<typeof useAuth>["api"];
type FacilitiesStatus = FacilitiesCase["status"];

type Notice = { kind: "error" | "success"; text: string } | undefined;

const STATUS_LABEL: Record<FacilitiesStatus, string> = {
  DUE: "접수 대기",
  TRIAGED: "분류됨",
  SCHEDULED: "일정 확정",
  ASSIGNED: "담당 배정",
  IN_PROGRESS: "작업 진행",
  SUBMITTED: "제출됨",
  REWORK_REQUIRED: "재작업 필요",
  AWAITING_ACCEPTANCE: "인수 확인 대기",
  CLOSED: "종결",
};

function errorText(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message;
  }
  return fallback;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function dueTone(value: string): string {
  return new Date(value).valueOf() < Date.now()
    ? "border-rose-200 bg-rose-50 text-rose-800"
    : "border-sky-200 bg-sky-50 text-sky-800";
}

function localDateTime(): string {
  return toLocalDateTimeInput(new Date());
}

/**
 * Facilities / IFM operator workbench. Every card represents a persisted case:
 * commands are offered only for server-declared lifecycle states and each write
 * is followed by a fresh case read, never an optimistic fabricated transition.
 */
export function FacilitiesWorkflowPage() {
  const { api, session } = useAuth();
  const authorityKey = [session?.org_id, session?.user_id, session?.client_session_incarnation].join(":");
  return <FacilitiesWorkflowSession key={authorityKey} api={api} />;
}

export function FacilitiesWorkflowSession({ api }: { api: FacilitiesApi }) {
  const [cases, setCases] = useState<FacilitiesCase[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<FacilitiesCase>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [obligationId, setObligationId] = useState("");
  const [scheduledFor, setScheduledFor] = useState(localDateTime);
  const [assigneeId, setAssigneeId] = useState("");
  const [preKwh, setPreKwh] = useState("");
  const [postKwh, setPostKwh] = useState("");
  const [costKrw, setCostKrw] = useState("");
  const [safetyEvidenceId, setSafetyEvidenceId] = useState("");
  const [reportEvidenceId, setReportEvidenceId] = useState("");
  const [photoEvidenceId, setPhotoEvidenceId] = useState("");
  const [acceptanceReason, setAcceptanceReason] = useState("");
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);

  const refreshList = useCallback(async () => {
    const epoch = ++listEpoch.current;
    setLoading(true);
    try {
      const result = await api.GET("/api/v1/facilities/cases");
      if (epoch !== listEpoch.current) return;
      if (!result.data) {
        setNotice({ kind: "error", text: errorText(result.error, "시설 사례 목록을 불러오지 못했습니다.") });
        return;
      }
      setCases(result.data);
      setNotice(undefined);
      setSelectedId((current) => current ?? result.data[0]?.id);
    } catch (error) {
      if (epoch === listEpoch.current) setNotice({ kind: "error", text: errorText(error, "시설 사례 목록을 불러오지 못했습니다.") });
    } finally {
      if (epoch === listEpoch.current) setLoading(false);
    }
  }, [api]);

  const refreshDetail = useCallback(async (caseId: string) => {
    const epoch = ++detailEpoch.current;
    setDetailLoading(true);
    try {
      const result = await api.GET("/api/v1/facilities/cases/{case_id}", { params: { path: { case_id: caseId } } });
      if (epoch !== detailEpoch.current) return;
      if (!result.data) {
        setSelected(undefined);
        setNotice({ kind: "error", text: errorText(result.error, "선택한 시설 사례를 불러오지 못했습니다.") });
        return;
      }
      setSelected(result.data);
    } catch (error) {
      if (epoch === detailEpoch.current) setNotice({ kind: "error", text: errorText(error, "선택한 시설 사례를 불러오지 못했습니다.") });
    } finally {
      if (epoch === detailEpoch.current) setDetailLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshList(); }, 0);
    return () => { window.clearTimeout(timer); };
  }, [refreshList]);
  useEffect(() => {
    if (!selectedId) return undefined;
    const timer = window.setTimeout(() => { void refreshDetail(selectedId); }, 0);
    return () => { window.clearTimeout(timer); };
  }, [refreshDetail, selectedId]);

  const refreshCase = useCallback(async (caseId: string) => {
    await Promise.all([refreshList(), refreshDetail(caseId)]);
  }, [refreshDetail, refreshList]);

  const command = useCallback(async (key: string, operation: () => Promise<{ data?: unknown; error?: unknown }>, caseId: string) => {
    setPending(key); setNotice(undefined);
    try {
      const result = await operation();
      if (!result.data && result.error) {
        setNotice({ kind: "error", text: errorText(result.error, "서버가 요청을 처리하지 못했습니다.") });
        return false;
      }
      await refreshCase(caseId);
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error, "서버와 통신할 수 없습니다.") });
      return false;
    } finally { setPending(undefined); }
  }, [refreshCase]);

  async function createCase(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!obligationId.trim()) { setNotice({ kind: "error", text: "활성 HVAC 의무 ID를 입력해야 합니다." }); return; }
    const key = `create:${obligationId}`;
    setPending(key); setNotice(undefined);
    try {
      const result = await api.POST("/api/v1/facilities/cases", { body: { obligationId: obligationId.trim(), idempotencyKey: crypto.randomUUID() } });
      if (!result.data) { setNotice({ kind: "error", text: errorText(result.error, "시설 사례를 접수하지 못했습니다.") }); return; }
      setObligationId("");
      setSelectedId(result.data.id);
      await refreshCase(result.data.id);
    } catch (error) { setNotice({ kind: "error", text: errorText(error, "시설 사례를 접수하지 못했습니다.") }); }
    finally { setPending(undefined); }
  }

  const can = useMemo(() => ({
    triage: selected?.status === "DUE" || selected?.status === "TRIAGED",
    assign: selected?.status === "SCHEDULED",
    start: selected?.status === "ASSIGNED" || selected?.status === "REWORK_REQUIRED",
    observe: selected?.status === "IN_PROGRESS",
    submit: selected?.status === "IN_PROGRESS",
    accept: selected?.status === "AWAITING_ACCEPTANCE",
  }), [selected?.status]);

  return <main className="mx-auto grid w-full max-w-[1800px] gap-4 px-4 py-5 lg:px-6" aria-labelledby="facilities-title">
    <header className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-line bg-white px-5 py-4 shadow-sm">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-teal">Integrated Facilities Management</p>
        <h1 id="facilities-title" className="mt-1 text-2xl font-bold text-ink">시설 운영 사례 워크벤치</h1>
        <p className="mt-1 max-w-3xl text-sm text-steel">정기 HVAC 의무를 실제 접수부터 현장 실행, 증빙, 고객 인수와 에너지·비용 관측까지 추적합니다.</p>
      </div>
      <button type="button" className="rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold text-ink hover:bg-muted-panel" onClick={() => void refreshList()} disabled={loading}>새로 고침</button>
    </header>
    {notice ? <section role={notice.kind === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${notice.kind === "error" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{notice.text}</section> : null}

    <section className="rounded-xl border border-line bg-white p-4 shadow-sm" aria-labelledby="facilities-intake-title">
      <h2 id="facilities-intake-title" className="text-base font-bold text-ink">의무 기반 사례 접수</h2>
      <p className="mt-1 text-sm text-steel">활성 HVAC 의무 ID를 사용합니다. 임의 사례나 데모 데이터는 생성하지 않습니다.</p>
      <form className="mt-3 flex flex-wrap gap-3" onSubmit={(event) => { void createCase(event); }}>
        <label className="grid min-w-[min(100%,32rem)] flex-1 gap-1 text-sm font-medium text-ink">활성 HVAC 의무 ID<input required value={obligationId} onChange={(event) => { setObligationId(event.target.value); }} className="rounded-md border border-line px-3 py-2 font-mono text-sm" aria-describedby="facilities-intake-help" /></label>
        <div className="flex items-end"><button type="submit" disabled={Boolean(pending)} className="rounded-md bg-brand-teal px-4 py-2 font-semibold text-white disabled:opacity-60">{pending?.startsWith("create:") ? "접수 중…" : "사례 접수"}</button></div>
      </form>
      <p id="facilities-intake-help" className="mt-2 text-xs text-steel">서버가 동일 요청을 멱등하게 처리하고, 새 사례의 SLA를 계산합니다.</p>
    </section>

    <section className="grid min-h-0 gap-4 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.7fr)]">
      <section className="rounded-xl border border-line bg-white shadow-sm" aria-labelledby="facilities-list-title">
        <div className="border-b border-line px-4 py-3"><h2 id="facilities-list-title" className="font-bold text-ink">사례 큐</h2><p className="text-sm text-steel">서버에서 읽은 최근 100개 사례</p></div>
        <div className="max-h-[58vh] overflow-auto p-2" aria-busy={loading}>
          {loading ? <p className="p-3 text-sm text-steel">사례를 불러오는 중…</p> : null}
          {!loading && cases.length === 0 ? <p className="p-3 text-sm text-steel">현재 권한 범위에 시설 사례가 없습니다.</p> : null}
          {cases.map((item) => <button key={item.id} type="button" onClick={() => { setSelectedId(item.id); }} className={`grid w-full gap-2 rounded-lg p-3 text-left hover:bg-muted-panel ${selectedId === item.id ? "bg-brand-teal/10 ring-1 ring-brand-teal" : ""}`}>
            <span className="flex items-center justify-between gap-3"><strong className="font-mono text-sm text-ink">{item.id.slice(0, 8)}</strong><span className="rounded-full border border-line px-2 py-0.5 text-xs font-semibold text-ink">{STATUS_LABEL[item.status]}</span></span>
            <span className={`rounded border px-2 py-1 text-xs ${dueTone(item.completionDueAt)}`}>완료 SLA {displayDate(item.completionDueAt)}</span>
            <span className="text-xs text-steel">{item.assigneeId ? `담당 ${item.assigneeId.slice(0, 8)}` : "담당자 미배정"}</span>
          </button>)}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-white p-4 shadow-sm" aria-live="polite" aria-busy={detailLoading}>
        {!selectedId ? <p className="text-sm text-steel">목록에서 사례를 선택하세요.</p> : null}
        {selectedId && detailLoading && !selected ? <p className="text-sm text-steel">사례 상세를 불러오는 중…</p> : null}
        {selected ? <div className="grid gap-5">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4"><div><p className="text-xs font-bold uppercase tracking-[0.12em] text-steel">Case {selected.id}</p><h2 className="mt-1 text-xl font-bold text-ink">{STATUS_LABEL[selected.status]}</h2></div><span className={`rounded-md border px-3 py-2 text-sm font-semibold ${dueTone(selected.completionDueAt)}`}>완료 SLA {displayDate(selected.completionDueAt)}</span></div>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><Metric label="응답 SLA" value={displayDate(selected.responseDueAt)} /><Metric label="인수 SLA" value={displayDate(selected.acceptanceDueAt)} /><Metric label="담당자" value={selected.assigneeId ?? "미배정"} mono /><Metric label="에너지 변화" value={selected.energyDeltaKwh ? `${selected.energyDeltaKwh} kWh` : "관측 전"} /><Metric label="누적 비용" value={`${selected.totalCostKrw.toLocaleString("ko-KR")} KRW`} /></dl>
          {can.triage ? <form className="rounded-lg border border-line bg-muted-panel p-4" onSubmit={(event) => { event.preventDefault(); if (!scheduledFor) return; void command("triage", () => api.POST("/api/v1/facilities/cases/{case_id}/triage", { params: { path: { case_id: selected.id } }, body: { scheduledFor: new Date(scheduledFor).toISOString() } }), selected.id); }}><h3 className="font-bold text-ink">1. 분류 및 일정 확정</h3><label className="mt-3 grid max-w-sm gap-1 text-sm font-medium">현장 예정 시각<input type="datetime-local" required value={scheduledFor} onChange={(event) => { setScheduledFor(event.target.value); }} className="rounded-md border border-line px-3 py-2" /></label><ActionButton pending={pending === "triage"}>일정 확정</ActionButton></form> : null}
          {can.assign ? <form className="rounded-lg border border-line bg-muted-panel p-4" onSubmit={(event) => { event.preventDefault(); if (!assigneeId.trim()) return; void command("assign", () => api.POST("/api/v1/facilities/cases/{case_id}/assign", { params: { path: { case_id: selected.id } }, body: { assigneeId: assigneeId.trim() } }), selected.id); }}><h3 className="font-bold text-ink">2. 현장 담당 배정</h3><label className="mt-3 grid max-w-xl gap-1 text-sm font-medium">담당 사용자 ID<input required value={assigneeId} onChange={(event) => { setAssigneeId(event.target.value); }} className="rounded-md border border-line px-3 py-2 font-mono" /></label><ActionButton pending={pending === "assign"}>담당 배정</ActionButton></form> : null}
          {can.start ? <section className="rounded-lg border border-line bg-muted-panel p-4"><h3 className="font-bold text-ink">3. 안전 확인 후 작업 시작</h3><p className="mt-1 text-sm text-steel">작업을 시작할 수 있는 권한은 서버가 담당자 기준으로 재검증합니다.</p><ActionButton pending={pending === "start"} onClick={() => void command("start", () => api.POST("/api/v1/facilities/cases/{case_id}/start", { params: { path: { case_id: selected.id } } }), selected.id)}>작업 시작</ActionButton></section> : null}
          {can.observe ? <form className="rounded-lg border border-line bg-muted-panel p-4" onSubmit={(event) => { event.preventDefault(); const cost = costKrw.trim() ? Number(costKrw) : undefined; if (cost !== undefined && (!Number.isSafeInteger(cost) || cost < 0)) { setNotice({ kind: "error", text: "비용은 0 이상의 정수 KRW여야 합니다." }); return; } void command("observe", () => api.POST("/api/v1/facilities/cases/{case_id}/observations", { params: { path: { case_id: selected.id } }, body: { observedAt: new Date().toISOString(), ...(preKwh.trim() ? { preKwh: preKwh.trim() } : {}), ...(postKwh.trim() ? { postKwh: postKwh.trim() } : {}), ...(cost !== undefined ? { costKrw: cost } : {}) } }), selected.id); }}><h3 className="font-bold text-ink">4. 에너지·비용 관측</h3><div className="mt-3 grid gap-3 sm:grid-cols-3"><Input label="작업 전 kWh" value={preKwh} onChange={setPreKwh} /><Input label="작업 후 kWh" value={postKwh} onChange={setPostKwh} /><Input label="비용 (KRW)" value={costKrw} onChange={setCostKrw} inputMode="numeric" /></div><ActionButton pending={pending === "observe"}>관측 기록</ActionButton></form> : null}
          {can.submit ? <form className="rounded-lg border border-line bg-muted-panel p-4" onSubmit={(event) => { event.preventDefault(); if (!safetyEvidenceId.trim() || !reportEvidenceId.trim()) { setNotice({ kind: "error", text: "안전 점검과 서비스 보고 증빙 ID가 모두 필요합니다." }); return; } void command("submit", () => api.POST("/api/v1/facilities/cases/{case_id}/submit", { params: { path: { case_id: selected.id } }, body: { safetyChecklistEvidenceId: safetyEvidenceId.trim(), serviceReportEvidenceId: reportEvidenceId.trim(), ...(photoEvidenceId.trim() ? { photoEvidenceId: photoEvidenceId.trim() } : {}) } }), selected.id); }}><h3 className="font-bold text-ink">5. 실행 증빙 제출</h3><div className="mt-3 grid gap-3 lg:grid-cols-3"><Input label="안전 점검 증빙 ID" value={safetyEvidenceId} onChange={setSafetyEvidenceId} required /><Input label="서비스 보고 증빙 ID" value={reportEvidenceId} onChange={setReportEvidenceId} required /><Input label="사진 증빙 ID (선택)" value={photoEvidenceId} onChange={setPhotoEvidenceId} /></div><ActionButton pending={pending === "submit"}>인수 요청 제출</ActionButton></form> : null}
          {can.accept ? <section className="rounded-lg border border-line bg-muted-panel p-4"><h3 className="font-bold text-ink">6. 고객 인수 결정</h3><label className="mt-3 grid max-w-2xl gap-1 text-sm font-medium">반려 사유 (반려 시 기록)<textarea value={acceptanceReason} onChange={(event) => { setAcceptanceReason(event.target.value); }} className="min-h-20 rounded-md border border-line px-3 py-2" maxLength={1000} /></label><div className="mt-3 flex flex-wrap gap-2"><ActionButton pending={pending === "accepted"} onClick={() => void command("accepted", () => api.POST("/api/v1/facilities/cases/{case_id}/acceptance", { params: { path: { case_id: selected.id } }, body: { decision: "ACCEPTED" } }), selected.id)}>인수 및 종결</ActionButton><button type="button" disabled={Boolean(pending) || !acceptanceReason.trim()} onClick={() => void command("rejected", () => api.POST("/api/v1/facilities/cases/{case_id}/acceptance", { params: { path: { case_id: selected.id } }, body: { decision: "REJECTED", reason: acceptanceReason.trim() } }), selected.id)} className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-800 disabled:opacity-60">{pending === "rejected" ? "반려 중…" : "재작업 요청"}</button></div></section> : null}
          {selected.status === "CLOSED" ? <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950"><h3 className="font-bold">종결된 사례</h3><p className="mt-1 text-sm">서버가 인수를 기록하고 종결 상태를 반환했습니다. 추가 상태 변경은 제공하지 않습니다.</p></section> : null}
        </div> : null}
      </section>
    </section>
  </main>;
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="rounded-lg border border-line bg-muted-panel p-3"><dt className="text-xs font-semibold text-steel">{label}</dt><dd className={`mt-1 break-all text-sm font-bold text-ink ${mono ? "font-mono" : ""}`}>{value}</dd></div>; }
function Input({ label, value, onChange, required = false, inputMode }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; inputMode?: "numeric" }) { return <label className="grid gap-1 text-sm font-medium text-ink">{label}<input required={required} value={value} inputMode={inputMode} onChange={(event) => { onChange(event.target.value); }} className="rounded-md border border-line px-3 py-2 font-mono" /></label>; }
function ActionButton({ children, pending, onClick }: { children: string; pending: boolean; onClick?: () => void }) { return <button type={onClick ? "button" : "submit"} onClick={onClick} disabled={pending} className="mt-3 rounded-md bg-brand-teal px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{pending ? "처리 중…" : children}</button>; }
