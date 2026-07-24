import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import type { components } from "@maintenance/api-client-ts";

import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { toLocalDateTimeInput } from "./facilitiesDate";

export type FacilitiesCase = components["schemas"]["FacilitiesCase"];
type FacilitiesApi = ReturnType<typeof useAuth>["api"];
type FacilitiesStatus = FacilitiesCase["status"];

type Notice = { kind: "error" | "success"; text: string } | undefined;

const copy = ko.facilities;
const STATUS_LABEL: Record<FacilitiesStatus, string> = copy.statuses;

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
        setNotice({ kind: "error", text: errorText(result.error, copy.listLoadFailed) });
        return;
      }
      setCases(result.data);
      setNotice(undefined);
      setSelectedId((current) => current ?? result.data[0]?.id);
    } catch (error) {
      if (epoch === listEpoch.current) setNotice({ kind: "error", text: errorText(error, copy.listLoadFailed) });
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
        setNotice({ kind: "error", text: errorText(result.error, copy.detailLoadFailed) });
        return;
      }
      setSelected(result.data);
    } catch (error) {
      if (epoch === detailEpoch.current) setNotice({ kind: "error", text: errorText(error, copy.detailLoadFailed) });
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
        setNotice({ kind: "error", text: errorText(result.error, copy.requestFailed) });
        return false;
      }
      await refreshCase(caseId);
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error, copy.networkFailed) });
      return false;
    } finally { setPending(undefined); }
  }, [refreshCase]);

  async function createCase(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!obligationId.trim()) { setNotice({ kind: "error", text: copy.obligationRequired }); return; }
    const key = `create:${obligationId}`;
    setPending(key); setNotice(undefined);
    try {
      const result = await api.POST("/api/v1/facilities/cases", { body: { obligationId: obligationId.trim(), idempotencyKey: crypto.randomUUID() } });
      if (!result.data) { setNotice({ kind: "error", text: errorText(result.error, copy.createFailed) }); return; }
      setObligationId("");
      setSelectedId(result.data.id);
      await refreshCase(result.data.id);
    } catch (error) { setNotice({ kind: "error", text: errorText(error, copy.createFailed) }); }
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
        <h1 id="facilities-title" className="mt-1 text-2xl font-bold text-ink">{copy.title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-steel">{copy.description}</p>
      </div>
      <button type="button" className="rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold text-ink hover:bg-muted-panel" onClick={() => void refreshList()} disabled={loading}>{copy.refresh}</button>
    </header>
    {notice ? <section role={notice.kind === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${notice.kind === "error" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{notice.text}</section> : null}

    <section className="rounded-xl border border-line bg-white p-4 shadow-sm" aria-labelledby="facilities-intake-title">
      <h2 id="facilities-intake-title" className="text-base font-bold text-ink">{copy.intakeTitle}</h2>
      <p className="mt-1 text-sm text-steel">{copy.intakeDescription}</p>
      <form className="mt-3 flex flex-wrap gap-3" onSubmit={(event) => { void createCase(event); }}>
        <label className="grid min-w-[min(100%,32rem)] flex-1 gap-1 text-sm font-medium text-ink">{copy.obligationId}<input required value={obligationId} onChange={(event) => { setObligationId(event.target.value); }} className="rounded-md border border-line px-3 py-2 font-mono text-sm" aria-describedby="facilities-intake-help" /></label>
        <div className="flex items-end"><button type="submit" disabled={Boolean(pending)} className="rounded-md bg-brand-teal px-4 py-2 font-semibold text-white disabled:opacity-60">{pending?.startsWith("create:") ? copy.creating : copy.create}</button></div>
      </form>
      <p id="facilities-intake-help" className="mt-2 text-xs text-steel">{copy.intakeHelp}</p>
    </section>

    <section className="grid min-h-0 gap-4 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.7fr)]">
      <section className="rounded-xl border border-line bg-white shadow-sm" aria-labelledby="facilities-list-title">
        <div className="border-b border-line px-4 py-3"><h2 id="facilities-list-title" className="font-bold text-ink">{copy.listTitle}</h2><p className="text-sm text-steel">{copy.listDescription}</p></div>
        <div className="max-h-[58vh] overflow-auto p-2" aria-busy={loading}>
          {loading ? <p className="p-3 text-sm text-steel">{copy.loadingCases}</p> : null}
          {!loading && cases.length === 0 ? <p className="p-3 text-sm text-steel">{copy.emptyCases}</p> : null}
          {cases.map((item) => <button key={item.id} type="button" onClick={() => { setSelectedId(item.id); }} className={`grid w-full gap-2 rounded-lg p-3 text-left hover:bg-muted-panel ${selectedId === item.id ? "bg-brand-teal/10 ring-1 ring-brand-teal" : ""}`}>
            <span className="flex items-center justify-between gap-3"><strong className="font-mono text-sm text-ink">{item.id.slice(0, 8)}</strong><span className="rounded-full border border-line px-2 py-0.5 text-xs font-semibold text-ink">{STATUS_LABEL[item.status]}</span></span>
            <span className={`rounded border px-2 py-1 text-xs ${dueTone(item.completionDueAt)}`}>{copy.completionSla} {displayDate(item.completionDueAt)}</span>
            <span className="text-xs text-steel">{item.assigneeId ? `${copy.assigneePrefix} ${item.assigneeId.slice(0, 8)}` : copy.unassigned}</span>
          </button>)}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-white p-4 shadow-sm" aria-live="polite" aria-busy={detailLoading}>
        {!selectedId ? <p className="text-sm text-steel">{copy.selectCase}</p> : null}
        {selectedId && detailLoading && !selected ? <p className="text-sm text-steel">{copy.loadingDetail}</p> : null}
        {selected ? <div className="grid gap-5">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4"><div><p className="text-xs font-bold uppercase tracking-[0.12em] text-steel">Case {selected.id}</p><h2 className="mt-1 text-xl font-bold text-ink">{STATUS_LABEL[selected.status]}</h2></div><span className={`rounded-md border px-3 py-2 text-sm font-semibold ${dueTone(selected.completionDueAt)}`}>{copy.completionSla} {displayDate(selected.completionDueAt)}</span></div>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><Metric label={copy.responseSla} value={displayDate(selected.responseDueAt)} /><Metric label={copy.acceptanceSla} value={displayDate(selected.acceptanceDueAt)} /><Metric label={copy.assignee} value={selected.assigneeId ?? copy.unassignedShort} mono /><Metric label={copy.energyDelta} value={selected.energyDeltaKwh ? `${selected.energyDeltaKwh} kWh` : copy.notObserved} /><Metric label={copy.totalCost} value={`${selected.totalCostKrw.toLocaleString("ko-KR")} KRW`} /></dl>
          {can.triage ? <form className="rounded-lg border border-line bg-muted-panel p-4" onSubmit={(event) => { event.preventDefault(); if (!scheduledFor) return; void command("triage", () => api.POST("/api/v1/facilities/cases/{case_id}/triage", { params: { path: { case_id: selected.id } }, body: { scheduledFor: new Date(scheduledFor).toISOString() } }), selected.id); }}><h3 className="font-bold text-ink">{copy.triageTitle}</h3><label className="mt-3 grid max-w-sm gap-1 text-sm font-medium">{copy.scheduledFor}<input type="datetime-local" required value={scheduledFor} onChange={(event) => { setScheduledFor(event.target.value); }} className="rounded-md border border-line px-3 py-2" /></label><ActionButton pending={pending === "triage"}>{copy.schedule}</ActionButton></form> : null}
          {can.assign ? <form className="rounded-lg border border-line bg-muted-panel p-4" onSubmit={(event) => { event.preventDefault(); if (!assigneeId.trim()) return; void command("assign", () => api.POST("/api/v1/facilities/cases/{case_id}/assign", { params: { path: { case_id: selected.id } }, body: { assigneeId: assigneeId.trim() } }), selected.id); }}><h3 className="font-bold text-ink">{copy.assignTitle}</h3><label className="mt-3 grid max-w-xl gap-1 text-sm font-medium">{copy.assigneeId}<input required value={assigneeId} onChange={(event) => { setAssigneeId(event.target.value); }} className="rounded-md border border-line px-3 py-2 font-mono" /></label><ActionButton pending={pending === "assign"}>{copy.assign}</ActionButton></form> : null}
          {can.start ? <section className="rounded-lg border border-line bg-muted-panel p-4"><h3 className="font-bold text-ink">{copy.startTitle}</h3><p className="mt-1 text-sm text-steel">{copy.startDescription}</p><ActionButton pending={pending === "start"} onClick={() => void command("start", () => api.POST("/api/v1/facilities/cases/{case_id}/start", { params: { path: { case_id: selected.id } } }), selected.id)}>{copy.start}</ActionButton></section> : null}
          {can.observe ? <form className="rounded-lg border border-line bg-muted-panel p-4" onSubmit={(event) => { event.preventDefault(); const cost = costKrw.trim() ? Number(costKrw) : undefined; if (cost !== undefined && (!Number.isSafeInteger(cost) || cost < 0)) { setNotice({ kind: "error", text: copy.invalidCost }); return; } void command("observe", () => api.POST("/api/v1/facilities/cases/{case_id}/observations", { params: { path: { case_id: selected.id } }, body: { observedAt: new Date().toISOString(), ...(preKwh.trim() ? { preKwh: preKwh.trim() } : {}), ...(postKwh.trim() ? { postKwh: postKwh.trim() } : {}), ...(cost !== undefined ? { costKrw: cost } : {}) } }), selected.id); }}><h3 className="font-bold text-ink">{copy.observeTitle}</h3><div className="mt-3 grid gap-3 sm:grid-cols-3"><Input label={copy.preKwh} value={preKwh} onChange={setPreKwh} /><Input label={copy.postKwh} value={postKwh} onChange={setPostKwh} /><Input label={copy.costKrw} value={costKrw} onChange={setCostKrw} inputMode="numeric" /></div><ActionButton pending={pending === "observe"}>{copy.observe}</ActionButton></form> : null}
          {can.submit ? <form className="rounded-lg border border-line bg-muted-panel p-4" onSubmit={(event) => { event.preventDefault(); if (!safetyEvidenceId.trim() || !reportEvidenceId.trim()) { setNotice({ kind: "error", text: copy.evidenceRequired }); return; } void command("submit", () => api.POST("/api/v1/facilities/cases/{case_id}/submit", { params: { path: { case_id: selected.id } }, body: { safetyChecklistEvidenceId: safetyEvidenceId.trim(), serviceReportEvidenceId: reportEvidenceId.trim(), ...(photoEvidenceId.trim() ? { photoEvidenceId: photoEvidenceId.trim() } : {}) } }), selected.id); }}><h3 className="font-bold text-ink">{copy.submitTitle}</h3><div className="mt-3 grid gap-3 lg:grid-cols-3"><Input label={copy.safetyEvidenceId} value={safetyEvidenceId} onChange={setSafetyEvidenceId} required /><Input label={copy.reportEvidenceId} value={reportEvidenceId} onChange={setReportEvidenceId} required /><Input label={copy.photoEvidenceId} value={photoEvidenceId} onChange={setPhotoEvidenceId} /></div><ActionButton pending={pending === "submit"}>{copy.submit}</ActionButton></form> : null}
          {can.accept ? <section className="rounded-lg border border-line bg-muted-panel p-4"><h3 className="font-bold text-ink">{copy.acceptanceTitle}</h3><label className="mt-3 grid max-w-2xl gap-1 text-sm font-medium">{copy.rejectionReason}<textarea value={acceptanceReason} onChange={(event) => { setAcceptanceReason(event.target.value); }} className="min-h-20 rounded-md border border-line px-3 py-2" maxLength={1000} /></label><div className="mt-3 flex flex-wrap gap-2"><ActionButton pending={pending === "accepted"} onClick={() => void command("accepted", () => api.POST("/api/v1/facilities/cases/{case_id}/acceptance", { params: { path: { case_id: selected.id } }, body: { decision: "ACCEPTED" } }), selected.id)}>{copy.accept}</ActionButton><button type="button" disabled={Boolean(pending) || !acceptanceReason.trim()} onClick={() => void command("rejected", () => api.POST("/api/v1/facilities/cases/{case_id}/acceptance", { params: { path: { case_id: selected.id } }, body: { decision: "REJECTED", reason: acceptanceReason.trim() } }), selected.id)} className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-800 disabled:opacity-60">{pending === "rejected" ? copy.rejecting : copy.reject}</button></div></section> : null}
          {selected.status === "CLOSED" ? <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950"><h3 className="font-bold">{copy.closedTitle}</h3><p className="mt-1 text-sm">{copy.closedDescription}</p></section> : null}
        </div> : null}
      </section>
    </section>
  </main>;
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="rounded-lg border border-line bg-muted-panel p-3"><dt className="text-xs font-semibold text-steel">{label}</dt><dd className={`mt-1 break-all text-sm font-bold text-ink ${mono ? "font-mono" : ""}`}>{value}</dd></div>; }
function Input({ label, value, onChange, required = false, inputMode }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; inputMode?: "numeric" }) { return <label className="grid gap-1 text-sm font-medium text-ink">{label}<input required={required} value={value} inputMode={inputMode} onChange={(event) => { onChange(event.target.value); }} className="rounded-md border border-line px-3 py-2 font-mono" /></label>; }
function ActionButton({ children, pending, onClick }: { children: string; pending: boolean; onClick?: () => void }) { return <button type={onClick ? "button" : "submit"} onClick={onClick} disabled={pending} className="mt-3 rounded-md bg-brand-teal px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{pending ? copy.processing : children}</button>; }
