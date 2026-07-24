import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import { equipmentStrings as text } from "../../i18n/equipment";
import {
  EquipmentApiError,
  type CaseDetailView,
  type CaseStatus,
  type ConditionGrade,
  type DispositionKind,
  type DispositionView,
  type EquipmentApi,
  type HandoverEvidenceOption,
  type InspectionOutcome,
} from "./equipmentApi";
import type { EquipmentCapabilities } from "./equipmentCapabilities";
import { CASE_CHIP, caseStatusLabel, formatInstant, formatKrw, formatMonths } from "./format";

interface Props {
  api: EquipmentApi;
  caseId: string;
  actorId: string | undefined;
  capabilities: EquipmentCapabilities;
  onSelectUnit: (unitId: string) => void;
  onChanged: () => void;
}

const HAPPY_PATH: readonly CaseStatus[] = [
  "QUOTED",
  "APPROVED",
  "DISPATCHED",
  "HANDED_OVER",
  "RETURNED",
  "CLOSED",
];

function errorMessage(cause: unknown): string {
  return cause instanceof EquipmentApiError ? cause.message : text.actionError;
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function toIso(local: string): string {
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? local : parsed.toISOString();
}

function stepClass(step: CaseStatus, current: CaseStatus, steps: readonly CaseStatus[]): string {
  if (step === current) return "equipment__step equipment__step--current";
  // Index against the rendered sequence so QUOTED reads as done on a
  // declined case too (both step and current are members by construction).
  return steps.indexOf(step) < steps.indexOf(current)
    ? "equipment__step equipment__step--done"
    : "equipment__step";
}

export function EquipmentCaseDetail({ api, caseId, actorId, capabilities, onSelectUnit, onChanged }: Props) {
  const [detail, setDetail] = useState<CaseDetailView>();
  const [completion, setCompletion] = useState<DispositionView>();
  /**
   * The contract has no GET /dispositions/{id}; the unit's openDispositionId is
   * the truthful open/completed signal (one OPEN per unit, COMPLETED immutable).
   */
  const [unitOpenDispositionId, setUnitOpenDispositionId] = useState<string | null>();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [declineIntent, setDeclineIntent] = useState(false);
  const [inspectionOutcome, setInspectionOutcome] = useState<InspectionOutcome>("PASS");
  const [handoverEvidence, setHandoverEvidence] = useState<HandoverEvidenceOption[]>([]);
  const generation = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const reasonId = useId();
  const carrierId = useId();
  const vehicleId = useId();
  const recipientId = useId();
  const evidenceId = useId();
  const handedOverId = useId();
  const outcomeId = useId();
  const inspectionFindingsId = useId();
  const maintenanceNoteId = useId();
  const returnedAtId = useId();
  const gradeId = useId();
  const assessmentFindingsId = useId();
  const dispositionSelectId = useId();
  const costId = useId();
  const saleAmountId = useId();
  const buyerId = useId();

  const load = useCallback(async () => {
    generation.current += 1;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const token = generation.current;
    setLoading(true);
    setLoadFailed(undefined);
    try {
      const next = await api.getRentalCase(caseId, controller.signal);
      const unit = next.dispositionId !== null
        ? await api.getUnit(next.unitId, controller.signal)
        : undefined;
      if (token !== generation.current) return;
      setDetail(next);
      setUnitOpenDispositionId(unit ? unit.openDispositionId : undefined);
      setLoading(false);
    } catch (cause) {
      if (token !== generation.current || controller.signal.aborted) return;
      setLoading(false);
      setLoadFailed(cause instanceof EquipmentApiError ? cause.message : text.detailLoadError);
    }
  }, [api, caseId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      abort.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!capabilities.canDispatch) return;
    void api.listHandoverEvidence().then(setHandoverEvidence).catch(() => setHandoverEvidence([]));
  }, [api, capabilities.canDispatch]);

  /** Run a transition; on success refresh this detail from the backend + notify lists. */
  const transition = useCallback(async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await work();
      setBusy(false);
      onChanged();
      await load();
    } catch (cause) {
      setBusy(false);
      setActionError(errorMessage(cause));
    }
  }, [busy, load, onChanged]);

  const decide = async (decision: "APPROVED" | "DECLINED") => {
    const reason = reasonRef.current?.value.trim() ?? "";
    if (decision === "DECLINED" && !reason) {
      setDeclineIntent(true);
      setActionError(text.reasonRequired);
      return;
    }
    await transition(() =>
      api.approval(caseId, decision === "DECLINED" ? { decision, reason } : { decision }),
    );
  };

  const submitDispatch = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await transition(() =>
      api.dispatch(caseId, {
        carrierName: formText(data, "carrierName"),
        vehicleReference: formText(data, "vehicleReference"),
      }),
    );
  };

  const submitHandover = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await transition(() =>
      api.handover(caseId, {
        recipientName: formText(data, "recipientName"),
        evidenceId: formText(data, "evidenceId"),
        handedOverAt: toIso(formText(data, "handedOverAt")),
      }),
    );
  };

  const submitInspection = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const outcome: InspectionOutcome = formText(data, "outcome") === "MAINTENANCE_PERFORMED"
      ? "MAINTENANCE_PERFORMED"
      : "PASS";
    const maintenanceNote = formText(data, "maintenanceNote");
    await transition(() =>
      api.recordInspection(caseId, {
        outcome,
        findings: formText(data, "findings"),
        ...(outcome === "MAINTENANCE_PERFORMED" ? { maintenanceNote } : {}),
      }),
    );
  };

  const submitReturn = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await transition(() =>
      api.recordReturn(caseId, { returnedAt: toIso(formText(data, "returnedAt")) }),
    );
  };

  const submitAssessment = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const grade = formText(data, "conditionGrade");
    const disposition = formText(data, "disposition");
    if (!["A", "B", "C", "D"].includes(grade)) return;
    if (!["REPAIR", "REFURBISH", "RESALE", "REDEPLOY"].includes(disposition)) return;
    // transition() refetches the case AND the unit, so the freshly opened
    // disposition's open/completed state is derived from the backend.
    await transition(() =>
      api.assessment(caseId, {
        conditionGrade: grade as ConditionGrade,
        findings: formText(data, "findings"),
        disposition: disposition as DispositionKind,
      }),
    );
  };

  const submitCompletion = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail?.dispositionId || !detail.assessment || busy) return;
    const data = new FormData(event.currentTarget);
    const input = detail.assessment.disposition === "RESALE"
      ? { saleAmountMinor: Number(formText(data, "saleAmountMinor")), buyerName: formText(data, "buyerName") }
      : { costMinor: Number(formText(data, "costMinor")) };
    setBusy(true);
    setActionError(undefined);
    try {
      const view = await api.completeDisposition(detail.dispositionId, input);
      setBusy(false);
      setCompletion(view);
      onChanged();
    } catch (cause) {
      setBusy(false);
      setActionError(errorMessage(cause));
    }
  };

  if (loading) {
    return <p role="status">{text.detailLoading}</p>;
  }
  if (loadFailed || !detail) {
    return (
      <div className="equipment__alert" role="alert">
        <span>{loadFailed ?? text.detailLoadError}</span>
        <button type="button" onClick={() => void load()}>{text.retry}</button>
      </div>
    );
  }

  const steps: readonly CaseStatus[] = detail.status === "DECLINED"
    ? ["QUOTED", "DECLINED"]
    : HAPPY_PATH;
  // Four-eyes mirror of the server guard: the quote creator never sees approval
  // controls (the backend 403s them regardless).
  const mayDecide = detail.status === "QUOTED"
    && capabilities.canApprove
    && actorId !== undefined
    && detail.createdBy !== actorId;
  const dispositionKind = detail.assessment?.disposition;
  // Truthful open/completed readback: the case's disposition is OPEN iff it is
  // the unit's single open disposition. REDEPLOY is inserted already COMPLETED,
  // so it never matches. `completion` covers the just-completed-in-session case.
  const dispositionChip = detail.dispositionId !== null && completion === undefined
    ? (unitOpenDispositionId === detail.dispositionId ? "OPEN" : "COMPLETED")
    : undefined;
  const dispositionOpen = dispositionChip === "OPEN";

  return (
    <article aria-label={text.caseDetail} aria-busy={busy}>
      <header className="equipment__head">
        <h2>{detail.customerName}</h2>
        <span className={CASE_CHIP[detail.status]}>{caseStatusLabel(detail.status)}</span>
      </header>
      <ol className="equipment__steps" aria-label={text.steps}>
        {steps.map((step) => (
          <li
            key={step}
            className={stepClass(step, detail.status, steps)}
            aria-current={step === detail.status ? "step" : undefined}
          >
            {caseStatusLabel(step)}
          </li>
        ))}
      </ol>
      <dl className="equipment__details">
        <dt>{text.unit}</dt>
        <dd>
          <button className="equipment__link" type="button" onClick={() => { onSelectUnit(detail.unitId); }}>
            {detail.unitId}
          </button>
        </dd>
        <dt>{text.site}</dt>
        <dd>{detail.siteReference}</dd>
        <dt>{text.monthlyRate}</dt>
        <dd>{formatKrw(detail.monthlyRateMinor)}</dd>
        <dt>{text.durationMonths}</dt>
        <dd>{formatMonths(detail.durationMonths)}</dd>
        <dt>{text.branch}</dt>
        <dd>{detail.branchId}</dd>
        <dt>{text.createdBy}</dt>
        <dd>{detail.createdBy}</dd>
        <dt>{text.createdAt}</dt>
        <dd>{formatInstant(detail.createdAt)}</dd>
        {detail.approval ? (
          <>
            <dt>{detail.approval.decision === "APPROVED" ? text.approve : text.decline}</dt>
            <dd>
              {detail.approval.decidedBy}
              {" · "}
              <time dateTime={detail.approval.decidedAt}>{formatInstant(detail.approval.decidedAt)}</time>
              {detail.approval.reason ? ` · ${detail.approval.reason}` : null}
            </dd>
          </>
        ) : null}
        {detail.dispatch ? (
          <>
            <dt>{text.dispatch}</dt>
            <dd>
              {detail.dispatch.carrierName}
              {" · "}
              {detail.dispatch.vehicleReference}
              {" · "}
              <time dateTime={detail.dispatch.dispatchedAt}>{formatInstant(detail.dispatch.dispatchedAt)}</time>
            </dd>
          </>
        ) : null}
        {detail.handover ? (
          <>
            <dt>{text.handover}</dt>
            <dd>
              {detail.handover.recipientName}
              {" · "}
              {detail.handover.evidenceReference}
              {" · "}
              <time dateTime={detail.handover.handedOverAt}>{formatInstant(detail.handover.handedOverAt)}</time>
            </dd>
          </>
        ) : null}
        {detail.returnedAt ? (
          <>
            <dt>{text.returnedAt}</dt>
            <dd><time dateTime={detail.returnedAt}>{formatInstant(detail.returnedAt)}</time></dd>
          </>
        ) : null}
        {detail.assessment ? (
          <>
            <dt>{text.assessment}</dt>
            <dd>
              {`${text.conditionGrade} ${detail.assessment.conditionGrade}`}
              {" · "}
              {text.dispositionKind[detail.assessment.disposition]}
              {" · "}
              {detail.assessment.findings}
              {" · "}
              {detail.assessment.assessedBy}
              {" · "}
              <time dateTime={detail.assessment.assessedAt}>{formatInstant(detail.assessment.assessedAt)}</time>
            </dd>
          </>
        ) : null}
        {dispositionChip ? (
          <>
            <dt>{text.disposition}</dt>
            <dd>
              <span
                className={dispositionChip === "OPEN"
                  ? "equipment__chip equipment__chip--warn"
                  : "equipment__chip equipment__chip--ok"}
              >
                {dispositionChip === "OPEN"
                  ? text.dispositionStatus.OPEN
                  : text.dispositionStatus.COMPLETED}
              </span>
            </dd>
          </>
        ) : null}
        {completion ? (
          <>
            <dt>{text.dispositionStatus.COMPLETED}</dt>
            <dd>
              {completion.costMinor !== null ? formatKrw(completion.costMinor) : null}
              {completion.saleAmountMinor !== null ? formatKrw(completion.saleAmountMinor) : null}
              {completion.buyerName !== null ? ` · ${completion.buyerName}` : null}
              {completion.completedAt !== null ? (
                <>
                  {" · "}
                  <time dateTime={completion.completedAt}>{formatInstant(completion.completedAt)}</time>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {actionError ? (
        <div className="equipment__alert" role="alert">
          <span>{actionError}</span>
        </div>
      ) : null}
      {mayDecide ? (
        <div className="equipment__form">
          <label htmlFor={reasonId}>
            {text.declineReason}
            <textarea
              ref={reasonRef}
              id={reasonId}
              maxLength={500}
              aria-invalid={declineIntent && actionError === text.reasonRequired ? true : undefined}
            />
          </label>
          <div className="equipment__actions">
            <button type="button" disabled={busy} onClick={() => void decide("APPROVED")}>
              {text.approve}
            </button>
            <button className="equipment__danger" type="button" disabled={busy} onClick={() => void decide("DECLINED")}>
              {text.decline}
            </button>
          </div>
        </div>
      ) : null}
      {detail.status === "APPROVED" && capabilities.canDispatch ? (
        <form className="equipment__form" onSubmit={(event) => void submitDispatch(event)}>
          <h3>{text.dispatch}</h3>
          <label htmlFor={carrierId}>
            {text.carrier}
            <input id={carrierId} name="carrierName" required />
          </label>
          <label htmlFor={vehicleId}>
            {text.vehicle}
            <input id={vehicleId} name="vehicleReference" required />
          </label>
          <button type="submit" disabled={busy}>{text.dispatch}</button>
        </form>
      ) : null}
      {detail.status === "DISPATCHED" && capabilities.canDispatch ? (
        <form className="equipment__form" onSubmit={(event) => void submitHandover(event)}>
          <h3>{text.handover}</h3>
          <label htmlFor={recipientId}>
            {text.recipient}
            <input id={recipientId} name="recipientName" required />
          </label>
          <label htmlFor={evidenceId}>
            {text.evidenceRef}
            <select
              id={evidenceId}
              name="evidenceId"
              required
              defaultValue=""
            >
              <option value="" disabled>Select immutable custody evidence</option>
              {handoverEvidence.map((evidence) => <option key={evidence.id} value={evidence.id}>{evidence.label}</option>)}
            </select>
          </label>
          <label htmlFor={handedOverId}>
            {text.handedOverAt}
            <input id={handedOverId} name="handedOverAt" type="datetime-local" required />
          </label>
          <button type="submit" disabled={busy}>{text.handover}</button>
        </form>
      ) : null}
      {detail.status === "HANDED_OVER" && capabilities.canInspect ? (
        <form className="equipment__form" onSubmit={(event) => void submitInspection(event)}>
          <h3>{text.inspection}</h3>
          <label htmlFor={outcomeId}>
            {text.outcome}
            <select
              id={outcomeId}
              name="outcome"
              value={inspectionOutcome}
              onChange={(event) => {
                setInspectionOutcome(
                  event.currentTarget.value === "MAINTENANCE_PERFORMED" ? "MAINTENANCE_PERFORMED" : "PASS",
                );
              }}
            >
              <option value="PASS">{text.outcomeLabels.PASS}</option>
              <option value="MAINTENANCE_PERFORMED">{text.outcomeLabels.MAINTENANCE_PERFORMED}</option>
            </select>
          </label>
          <label htmlFor={inspectionFindingsId}>
            {text.findings}
            <textarea id={inspectionFindingsId} name="findings" maxLength={2000} required />
          </label>
          {inspectionOutcome === "MAINTENANCE_PERFORMED" ? (
            <label htmlFor={maintenanceNoteId}>
              {text.maintenanceNote}
              <textarea id={maintenanceNoteId} name="maintenanceNote" maxLength={2000} required />
            </label>
          ) : null}
          <button type="submit" disabled={busy}>{text.inspection}</button>
        </form>
      ) : null}
      {detail.status === "HANDED_OVER" && capabilities.canAssess ? (
        <form className="equipment__form" onSubmit={(event) => void submitReturn(event)}>
          <h3>{text.recordReturn}</h3>
          <label htmlFor={returnedAtId}>
            {text.returnedAt}
            <input id={returnedAtId} name="returnedAt" type="datetime-local" required />
          </label>
          <button type="submit" disabled={busy}>{text.recordReturn}</button>
        </form>
      ) : null}
      {detail.status === "RETURNED" && capabilities.canAssess ? (
        <form className="equipment__form" onSubmit={(event) => void submitAssessment(event)}>
          <h3>{text.assessment}</h3>
          <label htmlFor={gradeId}>
            {text.conditionGrade}
            <select id={gradeId} name="conditionGrade" required>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
              <option value="D">D</option>
            </select>
          </label>
          <label htmlFor={assessmentFindingsId}>
            {text.findings}
            <textarea id={assessmentFindingsId} name="findings" maxLength={2000} required />
          </label>
          <label htmlFor={dispositionSelectId}>
            {text.disposition}
            <select id={dispositionSelectId} name="disposition" required>
              <option value="REPAIR">{text.dispositionKind.REPAIR}</option>
              <option value="REFURBISH">{text.dispositionKind.REFURBISH}</option>
              <option value="RESALE">{text.dispositionKind.RESALE}</option>
              <option value="REDEPLOY">{text.dispositionKind.REDEPLOY}</option>
            </select>
          </label>
          <button type="submit" disabled={busy}>{text.assessment}</button>
        </form>
      ) : null}
      {dispositionOpen && capabilities.canDisposition ? (
        <form className="equipment__form" onSubmit={(event) => void submitCompletion(event)}>
          <h3>{text.completeDisposition}</h3>
          {dispositionKind === "RESALE" ? (
            <>
              <label htmlFor={saleAmountId}>
                {text.saleAmount}
                <input id={saleAmountId} name="saleAmountMinor" type="number" min={0} step={1} required />
              </label>
              <label htmlFor={buyerId}>
                {text.buyer}
                <input id={buyerId} name="buyerName" required />
              </label>
            </>
          ) : (
            <label htmlFor={costId}>
              {text.cost}
              <input id={costId} name="costMinor" type="number" min={0} step={1} required />
            </label>
          )}
          <button type="submit" disabled={busy}>{text.completeDisposition}</button>
        </form>
      ) : null}
      <section aria-label={text.inspections}>
        <h3>{text.inspections}</h3>
        {detail.inspections.length === 0 ? (
          <p role="status">{text.inspectionsEmpty}</p>
        ) : (
          <ol className="equipment__history">
            {detail.inspections.map((inspection) => (
              <li key={inspection.id}>
                <span
                  className={inspection.outcome === "PASS"
                    ? "equipment__chip equipment__chip--ok"
                    : "equipment__chip equipment__chip--warn"}
                >
                  {text.outcomeLabels[inspection.outcome]}
                </span>
                <span>{inspection.findings}</span>
                {inspection.maintenanceNote ? <span>{inspection.maintenanceNote}</span> : null}
                <span>{inspection.inspectedBy}</span>
                <time dateTime={inspection.inspectedAt}>{formatInstant(inspection.inspectedAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
