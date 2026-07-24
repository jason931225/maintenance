import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import { equipmentStrings as text } from "../../i18n/equipment";
import {
  EquipmentApiError,
  type EquipmentApi,
  type HistoryEntry,
  type UnitDetailView,
} from "./equipmentApi";
import type { EquipmentCapabilities } from "./equipmentCapabilities";
import {
  AVAILABILITY_CHIP,
  availabilityLabel,
  formatInstant,
  formatKrw,
} from "./format";
import {
  clearQuoteDraft,
  loadQuoteDraft,
  newIdempotencyKey,
  saveQuoteDraft,
  type QuoteDraft,
} from "./quoteDraft";

interface Props {
  api: EquipmentApi;
  unitId: string;
  branchId: string;
  capabilities: EquipmentCapabilities;
  onSelectCase: (caseId: string) => void;
  onChanged: () => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof EquipmentApiError ? cause.message : text.actionError;
}

function emptyDraft(): QuoteDraft {
  return {
    idempotencyKey: newIdempotencyKey(),
    customerName: "",
    siteReference: "",
    monthlyRate: "",
    durationMonths: "",
  };
}

export function EquipmentUnitDetail({ api, unitId, branchId, capabilities, onSelectCase, onChanged }: Props) {
  const [detail, setDetail] = useState<UnitDetailView>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [draft, setDraft] = useState<QuoteDraft>(
    () => loadQuoteDraft(branchId, unitId) ?? emptyDraft(),
  );
  const generation = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const customerId = useId();
  const siteId = useId();
  const rateId = useId();
  const durationId = useId();

  const load = useCallback(async () => {
    generation.current += 1;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const token = generation.current;
    setLoading(true);
    setLoadFailed(undefined);
    try {
      const [nextDetail, nextHistory] = await Promise.all([
        api.getUnit(unitId, controller.signal),
        api.unitHistory(unitId, controller.signal),
      ]);
      if (token !== generation.current) return;
      setDetail(nextDetail);
      setHistory(nextHistory);
      setLoading(false);
    } catch (cause) {
      if (token !== generation.current || controller.signal.aborted) return;
      setLoading(false);
      setLoadFailed(cause instanceof EquipmentApiError ? cause.message : text.detailLoadError);
    }
  }, [api, unitId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      abort.current?.abort();
    };
  }, [load]);

  const updateDraft = (patch: Partial<QuoteDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      saveQuoteDraft(branchId, unitId, next);
      return next;
    });
  };

  const submitQuote = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!capabilities.canQuote || busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const created = await api.createRentalCase(
        {
          branchId,
          unitId,
          customerName: draft.customerName.trim(),
          siteReference: draft.siteReference.trim(),
          monthlyRateMinor: Number(draft.monthlyRate),
          durationMonths: Number(draft.durationMonths),
          currencyCode: "KRW",
        },
        draft.idempotencyKey,
      );
      clearQuoteDraft(branchId, unitId);
      setDraft(emptyDraft());
      setBusy(false);
      onChanged();
      onSelectCase(created.id);
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

  const quotable = capabilities.canQuote && detail.availability !== "SOLD";

  return (
    <article aria-label={text.unitDetail}>
      <header className="equipment__head">
        <h2>{detail.serialNo}</h2>
        <span className={AVAILABILITY_CHIP[detail.availability]}>
          {availabilityLabel(detail.availability)}
        </span>
      </header>
      <dl className="equipment__details">
        <dt>{text.modelName}</dt>
        <dd>{detail.modelName}</dd>
        <dt>{text.capacityClass}</dt>
        <dd>{detail.capacityClass}</dd>
        <dt>{text.acquisitionCost}</dt>
        <dd>{formatKrw(detail.acquisitionCostMinor)}</dd>
        <dt>{text.branch}</dt>
        <dd>{detail.branchId}</dd>
        <dt>{text.createdAt}</dt>
        <dd>{formatInstant(detail.createdAt)}</dd>
        <dt>{text.updatedAt}</dt>
        <dd>{formatInstant(detail.updatedAt)}</dd>
        {detail.activeCaseId ? (
          <>
            <dt>{text.activeCase}</dt>
            <dd>
              <button
                className="equipment__link"
                type="button"
                onClick={() => {
                  if (detail.activeCaseId) onSelectCase(detail.activeCaseId);
                }}
              >
                {detail.activeCaseId}
              </button>
            </dd>
          </>
        ) : null}
        {detail.openDispositionId ? (
          <>
            <dt>{text.openDisposition}</dt>
            <dd>
              <span className="equipment__chip equipment__chip--warn">{text.dispositionStatus.OPEN}</span>
            </dd>
          </>
        ) : null}
      </dl>
      {actionError ? (
        <div className="equipment__alert" role="alert">
          <span>{actionError}</span>
        </div>
      ) : null}
      {quotable ? (
        <form className="equipment__form" onSubmit={(event) => void submitQuote(event)} aria-busy={busy}>
          <h3>{text.quote}</h3>
          <label htmlFor={customerId}>
            {text.customer}
            <input
              id={customerId}
              name="customerName"
              value={draft.customerName}
              onChange={(event) => { updateDraft({ customerName: event.currentTarget.value }); }}
              required
            />
          </label>
          <label htmlFor={siteId}>
            {text.site}
            <input
              id={siteId}
              name="siteReference"
              value={draft.siteReference}
              onChange={(event) => { updateDraft({ siteReference: event.currentTarget.value }); }}
              required
            />
          </label>
          <label htmlFor={rateId}>
            {text.monthlyRate}
            <input
              id={rateId}
              name="monthlyRateMinor"
              type="number"
              min={1}
              step={1}
              value={draft.monthlyRate}
              onChange={(event) => { updateDraft({ monthlyRate: event.currentTarget.value }); }}
              required
            />
          </label>
          <label htmlFor={durationId}>
            {text.durationMonths}
            <input
              id={durationId}
              name="durationMonths"
              type="number"
              min={1}
              max={120}
              step={1}
              value={draft.durationMonths}
              onChange={(event) => { updateDraft({ durationMonths: event.currentTarget.value }); }}
              required
            />
          </label>
          <button type="submit" disabled={busy}>{text.quote}</button>
        </form>
      ) : null}
      <section aria-label={text.history}>
        <h3>{text.history}</h3>
        {history.length === 0 ? (
          <p role="status">{text.historyEmpty}</p>
        ) : (
          <ol className="equipment__history">
            {history.map((entry) => (
              <li key={`${entry.aggregateKind}:${entry.aggregateId}:${entry.transition}:${entry.occurredAt}`}>
                <span className="equipment__chip equipment__chip--neutral">
                  {text.aggregateKind[entry.aggregateKind]}
                </span>
                {entry.aggregateKind === "case" ? (
                  <button
                    className="equipment__link"
                    type="button"
                    onClick={() => { onSelectCase(entry.aggregateId); }}
                  >
                    {entry.transition}
                  </button>
                ) : (
                  <strong>{entry.transition}</strong>
                )}
                <span>{entry.actorId}</span>
                <time dateTime={entry.occurredAt}>{formatInstant(entry.occurredAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
