import { useCallback, useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";

import { equipmentStrings as text } from "../../i18n/equipment";
import {
  EquipmentApiError,
  type CaseStatus,
  type CaseView,
  type EquipmentApi,
  type UnitAvailability,
  type UnitView,
} from "./equipmentApi";
import type { EquipmentCapabilities } from "./equipmentCapabilities";
import { EquipmentCaseDetail } from "./EquipmentCaseDetail";
import { EquipmentUnitDetail } from "./EquipmentUnitDetail";
import { AVAILABILITY_CHIP, availabilityLabel, CASE_CHIP, caseStatusLabel, formatKrw } from "./format";
import "./equipment.css";

type Props = {
  api: EquipmentApi;
  branchId: string;
  actorId: string | undefined;
  capabilities: EquipmentCapabilities;
  /** Changes whenever auth replaces the effective tenant/session. */
  sessionKey: string | undefined;
};

type Selection = { kind: "unit" | "case"; id: string };

const AVAILABILITY_ORDER: readonly UnitAvailability[] = [
  "AVAILABLE",
  "RESERVED",
  "ON_RENT",
  "IN_ASSESSMENT",
  "IN_REPAIR",
  "IN_REFURBISHMENT",
  "FOR_SALE",
  "SOLD",
];

const CASE_STATUS_ORDER: readonly CaseStatus[] = [
  "QUOTED",
  "APPROVED",
  "DISPATCHED",
  "HANDED_OVER",
  "RETURNED",
  "CLOSED",
  "DECLINED",
];

const apiFenceIds = new WeakMap<object, number>();
let nextApiFenceId = 1;

function apiFenceKey(api: EquipmentApi): number {
  const reference = api as object;
  const existing = apiFenceIds.get(reference);
  if (existing) return existing;
  const id = nextApiFenceId++;
  apiFenceIds.set(reference, id);
  return id;
}

function selectionStorageKey(branchId: string): string {
  return `equipment3r.selection.${branchId}`;
}

function loadSelection(branchId: string): Selection | undefined {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(selectionStorageKey(branchId));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Record<string, unknown>;
    if ((value.kind === "unit" || value.kind === "case") && typeof value.id === "string") {
      return { kind: value.kind, id: value.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function storeSelection(branchId: string, selection: Selection | undefined): void {
  try {
    if (selection) {
      window.sessionStorage.setItem(selectionStorageKey(branchId), JSON.stringify(selection));
    } else {
      window.sessionStorage.removeItem(selectionStorageKey(branchId));
    }
  } catch {
    // Storage unavailable: selection simply won't survive refresh.
  }
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Re-mount synchronously whenever effective authority changes. Effects run too
 * late to fence an old tenant/session's selection, error, or busy state.
 */
export function EquipmentScreen(props: Props) {
  const capabilityKey = Object.values(props.capabilities).join(":");
  const sessionFence = [
    props.sessionKey ?? "no-session",
    props.branchId,
    props.actorId ?? "no-actor",
    apiFenceKey(props.api),
    capabilityKey,
  ].join(":");
  return <EquipmentScreenLayout key={sessionFence} {...props} />;
}

function EquipmentScreenLayout({ api, branchId, actorId, capabilities, sessionKey }: Props) {
  const [units, setUnits] = useState<UnitView[]>([]);
  const [cases, setCases] = useState<CaseView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [registerError, setRegisterError] = useState<string>();
  const [selection, setSelection] = useState<Selection | undefined>(() => loadSelection(branchId));
  const [unitFilter, setUnitFilter] = useState<UnitAvailability>();
  const [caseFilter, setCaseFilter] = useState<CaseStatus>();
  const generation = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const serialId = useId();
  const modelId = useId();
  const capacityId = useId();
  const costId = useId();

  const select = useCallback((next: Selection | undefined) => {
    setSelection(next);
    storeSelection(branchId, next);
  }, [branchId]);

  const load = useCallback(async () => {
    if (!capabilities.canObserve) {
      setUnits([]);
      setCases([]);
      setLoading(false);
      return;
    }
    generation.current += 1;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const token = generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const [nextUnits, nextCases] = await Promise.all([
        api.listUnits(controller.signal),
        api.listRentalCases(controller.signal),
      ]);
      if (token !== generation.current) return;
      setUnits(nextUnits.filter((unit) => unit.branchId === branchId));
      setCases(nextCases.filter((rentalCase) => rentalCase.branchId === branchId));
      setLoading(false);
    } catch (cause) {
      if (token !== generation.current || controller.signal.aborted) return;
      setLoading(false);
      setError(cause instanceof EquipmentApiError ? cause.message : text.loadError);
    }
  }, [api, branchId, capabilities.canObserve]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      abort.current?.abort();
    };
  }, [load, sessionKey]);

  const registerUnit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!capabilities.canRegister || busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setRegisterError(undefined);
    try {
      const created = await api.registerUnit({
        branchId,
        serialNo: formText(data, "serialNo"),
        modelName: formText(data, "modelName"),
        capacityClass: formText(data, "capacityClass"),
        acquisitionCostMinor: Number(formText(data, "acquisitionCostMinor")),
      });
      setBusy(false);
      form.reset();
      select({ kind: "unit", id: created.id });
      await load();
    } catch (cause) {
      setBusy(false);
      setRegisterError(cause instanceof EquipmentApiError ? cause.message : text.actionError);
    }
  };

  const unitCounts = useMemo(() => {
    const counts = new Map<UnitAvailability, number>();
    for (const unit of units) {
      counts.set(unit.availability, (counts.get(unit.availability) ?? 0) + 1);
    }
    return counts;
  }, [units]);

  const caseCounts = useMemo(() => {
    const counts = new Map<CaseStatus, number>();
    for (const rentalCase of cases) {
      counts.set(rentalCase.status, (counts.get(rentalCase.status) ?? 0) + 1);
    }
    return counts;
  }, [cases]);

  const visibleUnits = unitFilter
    ? units.filter((unit) => unit.availability === unitFilter)
    : units;
  const visibleCases = caseFilter
    ? cases.filter((rentalCase) => rentalCase.status === caseFilter)
    : cases;

  if (!capabilities.canObserve) {
    return (
      <main className="equipment">
        <section className="equipment__panel" aria-labelledby="equipment-title">
          <h1 id="equipment-title">{text.title}</h1>
          <p role="status">{text.denied}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="equipment" aria-busy={loading || busy}>
      <section className="equipment__panel" aria-labelledby="equipment-title">
        <header className="equipment__head">
          <h1 id="equipment-title">{text.title}</h1>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {text.refresh}
          </button>
        </header>
        {error ? (
          <div className="equipment__alert" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>{text.retry}</button>
          </div>
        ) : null}
        {loading ? <p role="status">{text.loading}</p> : (
          <>
            <section aria-label={text.unitSection}>
              <h2>{text.unitSection}</h2>
              <ul className="equipment__stats" aria-label={text.availabilityFilter}>
                {AVAILABILITY_ORDER.filter((availability) => (unitCounts.get(availability) ?? 0) > 0).map((availability) => (
                  <li key={availability}>
                    <button
                      className="equipment__stat"
                      type="button"
                      aria-pressed={unitFilter === availability}
                      onClick={() => { setUnitFilter((current) => current === availability ? undefined : availability); }}
                    >
                      <span className={AVAILABILITY_CHIP[availability]}>{availabilityLabel(availability)}</span>
                      <strong>{unitCounts.get(availability) ?? 0}</strong>
                    </button>
                  </li>
                ))}
              </ul>
              {visibleUnits.length === 0 ? (
                <p role="status">{text.unitsEmpty}</p>
              ) : (
                <ul className="equipment__list" aria-label={text.unitList}>
                  {visibleUnits.map((unit) => (
                    <li key={unit.id}>
                      <button
                        className={selection?.kind === "unit" && selection.id === unit.id
                          ? "equipment__row equipment__row--selected"
                          : "equipment__row"}
                        type="button"
                        aria-pressed={selection?.kind === "unit" && selection.id === unit.id}
                        onClick={() => { select({ kind: "unit", id: unit.id }); }}
                      >
                        <span>
                          <strong>{unit.serialNo}</strong>
                          {" "}
                          <small>{`${unit.modelName} · ${unit.capacityClass}`}</small>
                        </span>
                        <span className={AVAILABILITY_CHIP[unit.availability]}>
                          {availabilityLabel(unit.availability)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label={text.caseSection}>
              <h2>{text.caseSection}</h2>
              <ul className="equipment__stats" aria-label={text.statusFilter}>
                {CASE_STATUS_ORDER.filter((status) => (caseCounts.get(status) ?? 0) > 0).map((status) => (
                  <li key={status}>
                    <button
                      className="equipment__stat"
                      type="button"
                      aria-pressed={caseFilter === status}
                      onClick={() => { setCaseFilter((current) => current === status ? undefined : status); }}
                    >
                      <span className={CASE_CHIP[status]}>{caseStatusLabel(status)}</span>
                      <strong>{caseCounts.get(status) ?? 0}</strong>
                    </button>
                  </li>
                ))}
              </ul>
              {visibleCases.length === 0 ? (
                <p role="status">{text.casesEmpty}</p>
              ) : (
                <ul className="equipment__list" aria-label={text.caseList}>
                  {visibleCases.map((rentalCase) => (
                    <li key={rentalCase.id}>
                      <button
                        className={selection?.kind === "case" && selection.id === rentalCase.id
                          ? "equipment__row equipment__row--selected"
                          : "equipment__row"}
                        type="button"
                        aria-pressed={selection?.kind === "case" && selection.id === rentalCase.id}
                        onClick={() => { select({ kind: "case", id: rentalCase.id }); }}
                      >
                        <span>
                          <strong>{rentalCase.customerName}</strong>
                          {" "}
                          <small>{`${rentalCase.siteReference} · ${formatKrw(rentalCase.monthlyRateMinor)}`}</small>
                        </span>
                        <span className={CASE_CHIP[rentalCase.status]}>
                          {caseStatusLabel(rentalCase.status)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {capabilities.canRegister ? (
              <form className="equipment__form" onSubmit={(event) => void registerUnit(event)}>
                <h2>{text.registerUnit}</h2>
                {registerError ? (
                  <div className="equipment__alert" role="alert">
                    <span>{registerError}</span>
                  </div>
                ) : null}
                <label htmlFor={serialId}>
                  {text.serialNo}
                  <input id={serialId} name="serialNo" required />
                </label>
                <label htmlFor={modelId}>
                  {text.modelName}
                  <input id={modelId} name="modelName" required />
                </label>
                <label htmlFor={capacityId}>
                  {text.capacityClass}
                  <input id={capacityId} name="capacityClass" required />
                </label>
                <label htmlFor={costId}>
                  {text.acquisitionCost}
                  <input id={costId} name="acquisitionCostMinor" type="number" min={0} step={1} required />
                </label>
                <button type="submit" disabled={busy}>{text.registerUnit}</button>
              </form>
            ) : null}
          </>
        )}
      </section>
      <section className="equipment__panel" aria-live="polite" aria-label={selection?.kind === "case" ? text.caseDetail : text.unitDetail}>
        {!selection ? <p>{text.select}</p> : selection.kind === "unit" ? (
          <EquipmentUnitDetail
            key={`unit:${selection.id}`}
            api={api}
            unitId={selection.id}
            branchId={branchId}
            capabilities={capabilities}
            onSelectCase={(caseId) => { select({ kind: "case", id: caseId }); }}
            onChanged={() => void load()}
          />
        ) : (
          <EquipmentCaseDetail
            key={`case:${selection.id}`}
            api={api}
            caseId={selection.id}
            actorId={actorId}
            capabilities={capabilities}
            onSelectUnit={(unitId) => { select({ kind: "unit", id: unitId }); }}
            onChanged={() => void load()}
          />
        )}
      </section>
    </main>
  );
}
