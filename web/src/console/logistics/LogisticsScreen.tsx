import { useCallback, useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { logisticsStrings as text } from "../../i18n/logistics";
import {
  createLogisticsApi,
  newIdempotencyKey,
  type AsnStatus,
  type FulfillmentStatus,
  type ShipmentStatus,
  type SlaAssessment,
} from "./logisticsApi";
import type { LogisticsCapabilities } from "./logisticsCapabilities";
import "./logistics.css";

type Props = {
  api: ConsoleApiClient;
  branchId: string;
  actorId: string | undefined;
  capabilities: LogisticsCapabilities;
  /** Changes whenever auth replaces the effective tenant/session. */
  sessionKey: string | undefined;
};

/**
 * The backend exposes no logistics read endpoints (write-only pilot router),
 * so every row below is an aggregate this session created or advanced, rebuilt
 * from the mutation responses. Nothing is fabricated: absent server reads, the
 * queues start empty and fill only with server-confirmed working-set objects.
 */
interface ReceiptEntry {
  quantity: number;
  totalAfter: number | undefined;
  status: AsnStatus;
  replayed: boolean;
}

export interface AsnRecord {
  id: string;
  branchId: string;
  warehouseCode: string;
  externalReference: string;
  sku: string;
  expectedQuantity: number;
  receivedQuantity: number;
  status: AsnStatus;
  receipts: ReceiptEntry[];
}

export interface FulfillmentRecord {
  id: string;
  branchId: string;
  warehouseCode: string;
  sku: string;
  requestedQuantity: number;
  reservedQuantity: number;
  pickedQuantity: number | undefined;
  dueAt: string;
  status: FulfillmentStatus;
  shipmentId: string | undefined;
}

export interface ShipmentRecord {
  id: string;
  fulfillmentId: string;
  branchId: string;
  carrierName: string;
  vehicleReference: string;
  status: ShipmentStatus;
  pod:
    | {
        recipientName: string;
        evidenceReference: string;
        confirmedAt: string;
        slaAssessment: SlaAssessment;
      }
    | undefined;
  settlement: { amountMinor: number; settledAt: string } | undefined;
}

type Selected =
  | { kind: "asn"; id: string }
  | { kind: "fulfillment"; id: string }
  | { kind: "shipment"; id: string };

const apiFenceIds = new WeakMap<object, number>();
let nextApiFenceId = 1;

function apiFenceKey(api: ConsoleApiClient): number {
  const reference = api as object;
  const existing = apiFenceIds.get(reference);
  if (existing) return existing;
  const id = nextApiFenceId++;
  apiFenceIds.set(reference, id);
  return id;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function formInt(data: FormData, name: string): number | undefined {
  const value = Number.parseInt(formText(data, name), 10);
  return Number.isNaN(value) ? undefined : value;
}

function formDateTime(data: FormData, name: string): string | undefined {
  const value = formText(data, name);
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function asnStatusLabel(status: AsnStatus): string {
  return status in text.asnStatus
    ? text.asnStatus[status as keyof typeof text.asnStatus]
    : text.asnStatus.unknown;
}

function fulfillmentStatusLabel(status: FulfillmentStatus): string {
  return status in text.fulfillmentStatus
    ? text.fulfillmentStatus[status as keyof typeof text.fulfillmentStatus]
    : text.fulfillmentStatus.unknown;
}

function shipmentStatusLabel(status: ShipmentStatus): string {
  return status in text.shipmentStatus
    ? text.shipmentStatus[status as keyof typeof text.shipmentStatus]
    : text.shipmentStatus.unknown;
}

function asnChip(status: AsnStatus): string {
  switch (status) {
    case "EXPECTED":
      return "logistics__chip logistics__chip--info";
    case "PARTIAL_RECEIVED":
      return "logistics__chip logistics__chip--warn";
    case "RECEIVED":
      return "logistics__chip logistics__chip--ok";
    default:
      return "logistics__chip";
  }
}

function fulfillmentChip(status: FulfillmentStatus): string {
  switch (status) {
    case "RELEASED":
      return "logistics__chip logistics__chip--info";
    case "SHORT_PICK":
      return "logistics__chip logistics__chip--warn";
    case "PICKED":
    case "DELIVERED":
      return "logistics__chip logistics__chip--ok";
    default:
      return "logistics__chip";
  }
}

function shipmentChip(status: ShipmentStatus): string {
  switch (status) {
    case "DISPATCHED":
      return "logistics__chip logistics__chip--info";
    case "DELIVERED":
      return "logistics__chip logistics__chip--ok";
    default:
      return "logistics__chip";
  }
}

function slaChip(assessment: SlaAssessment): string {
  return assessment === "MET"
    ? "logistics__chip logistics__chip--ok"
    : "logistics__chip logistics__chip--danger";
}

/**
 * Re-mount synchronously whenever effective authority changes. Effects run too
 * late to fence an old tenant/session's working set, error, or busy state.
 */
export function LogisticsScreen(props: Props) {
  const capabilityKey = Object.values(props.capabilities).join(":");
  const sessionFence = [
    props.sessionKey ?? "no-session",
    props.branchId,
    props.actorId ?? "no-actor",
    apiFenceKey(props.api),
    capabilityKey,
  ].join(":");
  return <LogisticsScreenFencedBody key={sessionFence} {...props} />;
}

function LogisticsScreenFencedBody({ api, branchId, capabilities }: Props) {
  const [asns, setAsns] = useState<AsnRecord[]>([]);
  const [fulfillments, setFulfillments] = useState<FulfillmentRecord[]>([]);
  const [shipments, setShipments] = useState<ShipmentRecord[]>([]);
  const [selected, setSelected] = useState<Selected>();
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const operation = useRef<AbortController | undefined>(undefined);
  const retryIntent = useRef<(() => Promise<boolean>) | undefined>(undefined);
  /** Intent fingerprint (asnId:quantity) → idempotency key, kept until applied. */
  const receiptKeys = useRef(new Map<string, string>());
  const filterId = useId();
  const warehouseId = useId();
  const referenceId = useId();
  const skuId = useId();
  const expectedId = useId();
  const receiveQtyId = useId();
  const releaseWarehouseId = useId();
  const releaseSkuId = useId();
  const releaseQtyId = useId();
  const releaseDueId = useId();
  const pickQtyId = useId();
  const carrierId = useId();
  const vehicleId = useId();
  const recipientId = useId();
  const evidenceId = useId();
  const confirmedId = useId();
  const amountId = useId();
  const settledId = useId();
  const logisticsApi = useMemo(() => createLogisticsApi(api), [api]);

  const isCurrent = useCallback((token: number) => generation.current === token, []);

  useEffect(
    () => () => {
      generation.current += 1;
      operation.current?.abort();
    },
    [],
  );

  const run = useCallback(
    async <T,>(
      work: (signal: AbortSignal) => Promise<T>,
      apply: (result: T) => void,
    ): Promise<boolean> => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const token = ++generation.current;
      setBusy(true);
      setError(undefined);
      try {
        const result = await work(controller.signal);
        const applies = isCurrent(token) && !controller.signal.aborted;
        if (applies) apply(result);
        return applies;
      } catch (cause) {
        if (isCurrent(token) && !controller.signal.aborted) {
          setError(message(cause, text.actionError));
        }
        return false;
      } finally {
        if (isCurrent(token)) setBusy(false);
      }
    },
    [isCurrent],
  );

  const perform = useCallback(async (intent: () => Promise<boolean>): Promise<boolean> => {
    retryIntent.current = intent;
    const applied = await intent();
    if (applied) retryIntent.current = undefined;
    return applied;
  }, []);

  const retry = useCallback(() => {
    const intent = retryIntent.current;
    if (intent) void perform(intent);
  }, [perform]);

  const createAsn = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!capabilities.canReceive) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const expectedQuantity = formInt(data, "expectedQuantity");
    if (expectedQuantity === undefined || expectedQuantity <= 0) return;
    const input = {
      branchId,
      warehouseCode: formText(data, "warehouseCode").trim(),
      externalReference: formText(data, "externalReference").trim(),
      sku: formText(data, "sku").trim(),
      expectedQuantity,
    };
    const applied = await perform(() =>
      run(
        (signal) => logisticsApi.createAsn(input, signal),
        (created) => {
          setAsns((current) => [
            {
              id: created.id,
              branchId: created.branchId,
              warehouseCode: input.warehouseCode,
              externalReference: input.externalReference,
              sku: input.sku,
              expectedQuantity: input.expectedQuantity,
              receivedQuantity: 0,
              status: created.status,
              receipts: [],
            },
            ...current,
          ]);
          setSelected({ kind: "asn", id: created.id });
        },
      ),
    );
    if (applied) form.reset();
  };

  const receive = async (event: SyntheticEvent<HTMLFormElement>, asn: AsnRecord) => {
    event.preventDefault();
    if (!capabilities.canReceive) return;
    const form = event.currentTarget;
    const quantity = formInt(new FormData(form), "receivedQuantity");
    if (quantity === undefined || quantity <= 0) return;
    const fingerprint = `${asn.id}:${String(quantity)}`;
    const key = receiptKeys.current.get(fingerprint) ?? newIdempotencyKey();
    receiptKeys.current.set(fingerprint, key);
    const applied = await perform(() =>
      run(
        (signal) =>
          logisticsApi.receive(asn.id, { branchId, receivedQuantity: quantity }, key, signal),
        (result) => {
          receiptKeys.current.delete(fingerprint);
          setAsns((current) =>
            current.map((entry) =>
              entry.id === asn.id
                ? {
                    ...entry,
                    status: result.status,
                    receivedQuantity: result.receivedQuantity ?? entry.receivedQuantity,
                    receipts: [
                      ...entry.receipts,
                      {
                        quantity,
                        totalAfter: result.receivedQuantity,
                        status: result.status,
                        replayed: result.replayed === true,
                      },
                    ],
                  }
                : entry,
            ),
          );
        },
      ),
    );
    if (applied) form.reset();
  };

  const putaway = async (asn: AsnRecord) => {
    if (!capabilities.canPutaway) return;
    await perform(() =>
      run(
        (signal) => logisticsApi.putaway(asn.id, { branchId }, signal),
        (result) => {
          setAsns((current) =>
            current.map((entry) =>
              entry.id === asn.id ? { ...entry, status: result.status } : entry,
            ),
          );
        },
      ),
    );
  };

  const release = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!capabilities.canRelease) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const requestedQuantity = formInt(data, "requestedQuantity");
    const dueAt = formDateTime(data, "dueAt");
    if (requestedQuantity === undefined || requestedQuantity <= 0 || dueAt === undefined) return;
    const input = {
      branchId,
      warehouseCode: formText(data, "warehouseCode").trim(),
      sku: formText(data, "sku").trim(),
      requestedQuantity,
      dueAt,
    };
    const applied = await perform(() =>
      run(
        (signal) => logisticsApi.release(input, signal),
        (released) => {
          setFulfillments((current) => [
            {
              id: released.id,
              branchId,
              warehouseCode: input.warehouseCode,
              sku: input.sku,
              requestedQuantity: input.requestedQuantity,
              reservedQuantity: released.reservedQuantity,
              pickedQuantity: undefined,
              dueAt: input.dueAt,
              status: released.status,
              shipmentId: undefined,
            },
            ...current,
          ]);
          setSelected({ kind: "fulfillment", id: released.id });
        },
      ),
    );
    if (applied) form.reset();
  };

  const pick = async (event: SyntheticEvent<HTMLFormElement>, fulfillment: FulfillmentRecord) => {
    event.preventDefault();
    if (!capabilities.canPickPack) return;
    const form = event.currentTarget;
    const pickedQuantity = formInt(new FormData(form), "pickedQuantity");
    if (
      pickedQuantity === undefined ||
      pickedQuantity < 0 ||
      pickedQuantity > fulfillment.reservedQuantity
    ) {
      return;
    }
    const applied = await perform(() =>
      run(
        (signal) => logisticsApi.pick(fulfillment.id, { branchId, pickedQuantity }, signal),
        (result) => {
          setFulfillments((current) =>
            current.map((entry) =>
              entry.id === fulfillment.id
                ? { ...entry, status: result.status, pickedQuantity: result.pickedQuantity }
                : entry,
            ),
          );
        },
      ),
    );
    if (applied) form.reset();
  };

  const pack = async (fulfillment: FulfillmentRecord) => {
    if (!capabilities.canPickPack) return;
    await perform(() =>
      run(
        (signal) => logisticsApi.pack(fulfillment.id, { branchId }, signal),
        (result) => {
          setFulfillments((current) =>
            current.map((entry) =>
              entry.id === fulfillment.id
                ? { ...entry, status: result.status, pickedQuantity: result.pickedQuantity }
                : entry,
            ),
          );
        },
      ),
    );
  };

  const dispatch = async (
    event: SyntheticEvent<HTMLFormElement>,
    fulfillment: FulfillmentRecord,
  ) => {
    event.preventDefault();
    if (!capabilities.canDispatch) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = {
      branchId,
      carrierName: formText(data, "carrierName").trim(),
      vehicleReference: formText(data, "vehicleReference").trim(),
    };
    const applied = await perform(() =>
      run(
        (signal) => logisticsApi.dispatch(fulfillment.id, input, signal),
        (result) => {
          setFulfillments((current) =>
            current.map((entry) =>
              entry.id === fulfillment.id
                ? { ...entry, status: "DISPATCHED", shipmentId: result.id }
                : entry,
            ),
          );
          setShipments((current) => [
            {
              id: result.id,
              fulfillmentId: result.fulfillmentId,
              branchId,
              carrierName: input.carrierName,
              vehicleReference: input.vehicleReference,
              status: result.status,
              pod: undefined,
              settlement: undefined,
            },
            ...current,
          ]);
          setSelected({ kind: "shipment", id: result.id });
        },
      ),
    );
    if (applied) form.reset();
  };

  const pod = async (event: SyntheticEvent<HTMLFormElement>, shipment: ShipmentRecord) => {
    event.preventDefault();
    if (!capabilities.canPod) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const confirmedAt = formDateTime(data, "confirmedAt");
    if (confirmedAt === undefined) return;
    const input = {
      branchId,
      recipientName: formText(data, "recipientName").trim(),
      evidenceReference: formText(data, "evidenceReference").trim(),
      confirmedAt,
    };
    const applied = await perform(() =>
      run(
        (signal) => logisticsApi.pod(shipment.id, input, signal),
        (result) => {
          setShipments((current) =>
            current.map((entry) =>
              entry.id === shipment.id
                ? {
                    ...entry,
                    status: result.status,
                    pod: {
                      recipientName: input.recipientName,
                      evidenceReference: result.recipientConfirmedEvidenceReference,
                      confirmedAt: input.confirmedAt,
                      slaAssessment: result.slaAssessment,
                    },
                  }
                : entry,
            ),
          );
          // The backend advances the linked fulfillment in the same transaction.
          setFulfillments((current) =>
            current.map((entry) =>
              entry.id === shipment.fulfillmentId ? { ...entry, status: "DELIVERED" } : entry,
            ),
          );
        },
      ),
    );
    if (applied) form.reset();
  };

  const settle = async (event: SyntheticEvent<HTMLFormElement>, shipment: ShipmentRecord) => {
    event.preventDefault();
    if (!capabilities.canSettle) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const amountMinor = formInt(data, "amountMinor");
    const settledAt = formDateTime(data, "settledAt");
    if (amountMinor === undefined || amountMinor < 0 || settledAt === undefined) return;
    const applied = await perform(() =>
      run(
        (signal) =>
          logisticsApi.settle(
            shipment.id,
            { branchId, currencyCode: "KRW", amountMinor, settledAt },
            signal,
          ),
        (result) => {
          setShipments((current) =>
            current.map((entry) =>
              entry.id === shipment.id
                ? {
                    ...entry,
                    status: result.status,
                    settlement: { amountMinor: result.operationalCost.amountMinor, settledAt },
                  }
                : entry,
            ),
          );
          // The backend advances the linked fulfillment in the same transaction.
          setFulfillments((current) =>
            current.map((entry) =>
              entry.id === shipment.fulfillmentId ? { ...entry, status: "SETTLED" } : entry,
            ),
          );
        },
      ),
    );
    if (applied) form.reset();
  };

  if (!capabilities.canRead) {
    return (
      <section className="logistics" aria-label={text.title}>
        <div className="logistics__panel">
          <h1>{text.title}</h1>
          <p role="status">{text.denied}</p>
        </div>
      </section>
    );
  }

  const query = filter.trim().toLowerCase();
  const matches = (...fields: (string | undefined)[]) =>
    !query || fields.some((field) => field?.toLowerCase().includes(query));
  const visibleAsns = asns.filter((entry) =>
    matches(entry.sku, entry.warehouseCode, entry.externalReference, entry.id),
  );
  const visibleFulfillments = fulfillments.filter((entry) =>
    matches(entry.sku, entry.warehouseCode, entry.id),
  );
  const visibleShipments = shipments.filter((entry) =>
    matches(entry.carrierName, entry.vehicleReference, entry.id),
  );
  const selectedAsn =
    selected?.kind === "asn" ? asns.find((entry) => entry.id === selected.id) : undefined;
  const selectedFulfillment =
    selected?.kind === "fulfillment"
      ? fulfillments.find((entry) => entry.id === selected.id)
      : undefined;
  const selectedShipment =
    selected?.kind === "shipment" ? shipments.find((entry) => entry.id === selected.id) : undefined;
  const putawayCount = asns.filter((entry) => entry.status === "PUTAWAY").length;
  const settledCount = shipments.filter((entry) => entry.status === "SETTLED").length;

  return (
    <section className="logistics" aria-label={text.title} aria-busy={busy}>
      <div className="logistics__panel">
        <header className="logistics__bar">
          <h1>{text.title}</h1>
          <div className="logistics__stats" role="status">
            <span className="logistics__chip">{`${text.asn} ${String(asns.length)}`}</span>
            <span className="logistics__chip">{`${text.putaway} ${String(putawayCount)}`}</span>
            <span className="logistics__chip">{`${text.fulfillment} ${String(fulfillments.length)}`}</span>
            <span className="logistics__chip">{`${text.shipment} ${String(shipments.length)}`}</span>
            <span className="logistics__chip">{`${text.settle} ${String(settledCount)}`}</span>
          </div>
        </header>
        {error && (
          <div className="logistics__alert" role="alert">
            <span>{error}</span>
            <button type="button" onClick={retry}>{text.retry}</button>
          </div>
        )}
        <label className="logistics__filter" htmlFor={filterId}>
          {text.filter}
          <input
            id={filterId}
            type="search"
            value={filter}
            onChange={(event) => { setFilter(event.currentTarget.value); }}
          />
        </label>
        <h2>{text.inbound}</h2>
        <ul className="logistics__list" aria-label={text.asnQueue}>
          {visibleAsns.length ? (
            visibleAsns.map((entry) => (
              <li key={entry.id}>
                <button
                  className={
                    selected?.kind === "asn" && selected.id === entry.id
                      ? "logistics__item logistics__item--selected"
                      : "logistics__item"
                  }
                  type="button"
                  aria-pressed={selected?.kind === "asn" && selected.id === entry.id}
                  onClick={() => { setSelected({ kind: "asn", id: entry.id }); }}
                >
                  <span>{entry.sku}</span>
                  <span>{`${String(entry.receivedQuantity)}/${String(entry.expectedQuantity)}`}</span>
                  <span className={asnChip(entry.status)}>{asnStatusLabel(entry.status)}</span>
                </button>
              </li>
            ))
          ) : (
            <li role="status">{asns.length ? text.noMatch : text.asnEmpty}</li>
          )}
        </ul>
        {capabilities.canReceive && (
          <form className="logistics__form" aria-label={text.createAsn} onSubmit={(event) => void createAsn(event)}>
            <h3>{text.createAsn}</h3>
            <label htmlFor={warehouseId}>
              {text.warehouse}
              <input id={warehouseId} name="warehouseCode" maxLength={80} required />
            </label>
            <label htmlFor={referenceId}>
              {text.externalReference}
              <input id={referenceId} name="externalReference" maxLength={120} required />
            </label>
            <label htmlFor={skuId}>
              {text.sku}
              <input id={skuId} name="sku" maxLength={80} required />
            </label>
            <label htmlFor={expectedId}>
              {text.expectedQuantity}
              <input id={expectedId} name="expectedQuantity" type="number" min={1} step={1} required />
            </label>
            <button type="submit" disabled={busy}>{text.createAsn}</button>
          </form>
        )}
        <h2>{text.outbound}</h2>
        <ul className="logistics__list" aria-label={text.fulfillmentQueue}>
          {visibleFulfillments.length ? (
            visibleFulfillments.map((entry) => (
              <li key={entry.id}>
                <button
                  className={
                    selected?.kind === "fulfillment" && selected.id === entry.id
                      ? "logistics__item logistics__item--selected"
                      : "logistics__item"
                  }
                  type="button"
                  aria-pressed={selected?.kind === "fulfillment" && selected.id === entry.id}
                  onClick={() => { setSelected({ kind: "fulfillment", id: entry.id }); }}
                >
                  <span>{entry.sku}</span>
                  <span>{String(entry.requestedQuantity)}</span>
                  <span className={fulfillmentChip(entry.status)}>
                    {fulfillmentStatusLabel(entry.status)}
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li role="status">{fulfillments.length ? text.noMatch : text.fulfillmentEmpty}</li>
          )}
        </ul>
        {capabilities.canRelease && (
          <form className="logistics__form" aria-label={text.release} onSubmit={(event) => void release(event)}>
            <h3>{text.release}</h3>
            <label htmlFor={releaseWarehouseId}>
              {text.warehouse}
              <input id={releaseWarehouseId} name="warehouseCode" maxLength={80} required />
            </label>
            <label htmlFor={releaseSkuId}>
              {text.sku}
              <input id={releaseSkuId} name="sku" maxLength={80} required />
            </label>
            <label htmlFor={releaseQtyId}>
              {text.requestedQuantity}
              <input id={releaseQtyId} name="requestedQuantity" type="number" min={1} step={1} required />
            </label>
            <label htmlFor={releaseDueId}>
              {text.dueAt}
              <input id={releaseDueId} name="dueAt" type="datetime-local" required />
            </label>
            <button type="submit" disabled={busy}>{text.release}</button>
          </form>
        )}
        <ul className="logistics__list" aria-label={text.shipmentQueue}>
          {visibleShipments.length ? (
            visibleShipments.map((entry) => (
              <li key={entry.id}>
                <button
                  className={
                    selected?.kind === "shipment" && selected.id === entry.id
                      ? "logistics__item logistics__item--selected"
                      : "logistics__item"
                  }
                  type="button"
                  aria-pressed={selected?.kind === "shipment" && selected.id === entry.id}
                  onClick={() => { setSelected({ kind: "shipment", id: entry.id }); }}
                >
                  <span>{entry.carrierName}</span>
                  <span className={shipmentChip(entry.status)}>
                    {shipmentStatusLabel(entry.status)}
                  </span>
                  {entry.pod && (
                    <span className={slaChip(entry.pod.slaAssessment)}>
                      {text.sla[entry.pod.slaAssessment]}
                    </span>
                  )}
                </button>
              </li>
            ))
          ) : (
            <li role="status">{shipments.length ? text.noMatch : text.shipmentEmpty}</li>
          )}
        </ul>
      </div>
      <div className="logistics__panel" aria-live="polite" aria-label={text.detail}>
        {!selectedAsn && !selectedFulfillment && !selectedShipment && (
          <p role="status">{text.select}</p>
        )}
        {selectedAsn && (
          <article className="logistics__detail">
            <header>
              <h2>{`${text.asn} ${selectedAsn.sku}`}</h2>
              <span className={asnChip(selectedAsn.status)}>
                {asnStatusLabel(selectedAsn.status)}
              </span>
            </header>
            <dl className="logistics__fields">
              <dt>{text.warehouse}</dt>
              <dd>{selectedAsn.warehouseCode}</dd>
              <dt>{text.externalReference}</dt>
              <dd>{selectedAsn.externalReference}</dd>
              <dt>{text.expectedQuantity}</dt>
              <dd>{String(selectedAsn.expectedQuantity)}</dd>
              <dt>{text.receivedTotal}</dt>
              <dd>{String(selectedAsn.receivedQuantity)}</dd>
              <dt>{text.branch}</dt>
              <dd>{selectedAsn.branchId}</dd>
            </dl>
            <h3>{text.receipts}</h3>
            {selectedAsn.receipts.length ? (
              <ol className="logistics__history">
                {selectedAsn.receipts.map((receipt, index) => (
                  <li key={`${String(index)}-${String(receipt.quantity)}`}>
                    <span>{`${text.receivedQuantity} ${String(receipt.quantity)}`}</span>
                    {receipt.totalAfter !== undefined && (
                      <span>{`${text.receivedTotal} ${String(receipt.totalAfter)}`}</span>
                    )}
                    <span className={asnChip(receipt.status)}>{asnStatusLabel(receipt.status)}</span>
                    {receipt.replayed && (
                      <span className="logistics__chip logistics__chip--warn">{text.replayed}</span>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p role="status">{text.receiptsEmpty}</p>
            )}
            {capabilities.canReceive &&
              (selectedAsn.status === "EXPECTED" || selectedAsn.status === "PARTIAL_RECEIVED") && (
                <form
                  className="logistics__form"
                aria-label={text.receive}
                  onSubmit={(event) => void receive(event, selectedAsn)}
                >
                  <label htmlFor={receiveQtyId}>
                    {text.receivedQuantity}
                    <input id={receiveQtyId} name="receivedQuantity" type="number" min={1} step={1} required />
                  </label>
                  <button type="submit" disabled={busy}>{text.receive}</button>
                </form>
              )}
            {capabilities.canPutaway &&
              (selectedAsn.status === "RECEIVED" || selectedAsn.status === "PARTIAL_RECEIVED") && (
                <button type="button" disabled={busy} onClick={() => void putaway(selectedAsn)}>
                  {text.putaway}
                </button>
              )}
          </article>
        )}
        {selectedFulfillment && (
          <article className="logistics__detail">
            <header>
              <h2>{`${text.fulfillment} ${selectedFulfillment.sku}`}</h2>
              <span className={fulfillmentChip(selectedFulfillment.status)}>
                {fulfillmentStatusLabel(selectedFulfillment.status)}
              </span>
            </header>
            <dl className="logistics__fields">
              <dt>{text.warehouse}</dt>
              <dd>{selectedFulfillment.warehouseCode}</dd>
              <dt>{text.requestedQuantity}</dt>
              <dd>{String(selectedFulfillment.requestedQuantity)}</dd>
              <dt>{text.reservedQuantity}</dt>
              <dd>{String(selectedFulfillment.reservedQuantity)}</dd>
              {selectedFulfillment.pickedQuantity !== undefined && (
                <>
                  <dt>{text.pickedQuantity}</dt>
                  <dd>{String(selectedFulfillment.pickedQuantity)}</dd>
                </>
              )}
              <dt>{text.dueAt}</dt>
              <dd>{selectedFulfillment.dueAt}</dd>
              <dt>{text.branch}</dt>
              <dd>{selectedFulfillment.branchId}</dd>
            </dl>
            {selectedFulfillment.shipmentId !== undefined && (
              <button
                className="logistics__link"
                type="button"
                onClick={() => {
                  const target = selectedFulfillment.shipmentId;
                  if (target !== undefined) setSelected({ kind: "shipment", id: target });
                }}
              >
                {text.linkedShipment}
              </button>
            )}
            {capabilities.canPickPack && selectedFulfillment.status === "RELEASED" && (
              <form
                className="logistics__form"
                aria-label={text.pick}
                onSubmit={(event) => void pick(event, selectedFulfillment)}
              >
                <label htmlFor={pickQtyId}>
                  {text.pickedQuantity}
                  <input
                    id={pickQtyId}
                    name="pickedQuantity"
                    type="number"
                    min={0}
                    max={selectedFulfillment.reservedQuantity}
                    step={1}
                    required
                  />
                </label>
                <button type="submit" disabled={busy}>{text.pick}</button>
              </form>
            )}
            {capabilities.canPickPack &&
              (selectedFulfillment.status === "PICKED" ||
                selectedFulfillment.status === "SHORT_PICK") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void pack(selectedFulfillment)}
                >
                  {text.pack}
                </button>
              )}
            {capabilities.canDispatch && selectedFulfillment.status === "PACKED" && (
              <form
                className="logistics__form"
                aria-label={text.dispatch}
                onSubmit={(event) => void dispatch(event, selectedFulfillment)}
              >
                <label htmlFor={carrierId}>
                  {text.carrierName}
                  <input id={carrierId} name="carrierName" maxLength={120} required />
                </label>
                <label htmlFor={vehicleId}>
                  {text.vehicleReference}
                  <input id={vehicleId} name="vehicleReference" maxLength={120} required />
                </label>
                <button type="submit" disabled={busy}>{text.dispatch}</button>
              </form>
            )}
          </article>
        )}
        {selectedShipment && (
          <article className="logistics__detail">
            <header>
              <h2>{`${text.shipment} ${selectedShipment.carrierName}`}</h2>
              <span className={shipmentChip(selectedShipment.status)}>
                {shipmentStatusLabel(selectedShipment.status)}
              </span>
            </header>
            <dl className="logistics__fields">
              <dt>{text.carrierName}</dt>
              <dd>{selectedShipment.carrierName}</dd>
              <dt>{text.vehicleReference}</dt>
              <dd>{selectedShipment.vehicleReference}</dd>
              <dt>{text.branch}</dt>
              <dd>{selectedShipment.branchId}</dd>
            </dl>
            <button
              className="logistics__link"
              type="button"
              onClick={() => {
                setSelected({ kind: "fulfillment", id: selectedShipment.fulfillmentId });
              }}
            >
              {text.linkedFulfillment}
            </button>
            {selectedShipment.pod && (
              <>
                <h3>{text.pod}</h3>
                <dl className="logistics__fields">
                  <dt>{text.recipientName}</dt>
                  <dd>{selectedShipment.pod.recipientName}</dd>
                  <dt>{text.evidenceReference}</dt>
                  <dd>{selectedShipment.pod.evidenceReference}</dd>
                  <dt>{text.confirmedAt}</dt>
                  <dd>{selectedShipment.pod.confirmedAt}</dd>
                </dl>
                <span className={slaChip(selectedShipment.pod.slaAssessment)}>
                  {text.sla[selectedShipment.pod.slaAssessment]}
                </span>
              </>
            )}
            {capabilities.canPod && selectedShipment.status === "DISPATCHED" && (
              <form
                className="logistics__form"
                aria-label={text.pod}
                onSubmit={(event) => void pod(event, selectedShipment)}
              >
                <h3>{text.pod}</h3>
                <label htmlFor={recipientId}>
                  {text.recipientName}
                  <input id={recipientId} name="recipientName" maxLength={160} required />
                </label>
                <label htmlFor={evidenceId}>
                  {text.evidenceReference}
                  <input
                    id={evidenceId}
                    name="evidenceReference"
                    pattern="evidence://.+"
                    placeholder="evidence://"
                    required
                  />
                </label>
                <label htmlFor={confirmedId}>
                  {text.confirmedAt}
                  <input id={confirmedId} name="confirmedAt" type="datetime-local" required />
                </label>
                <button type="submit" disabled={busy}>{text.pod}</button>
              </form>
            )}
            {selectedShipment.settlement && (
              <>
                <h3>{text.settlement}</h3>
                <dl className="logistics__fields">
                  <dt>{text.amountMinor}</dt>
                  <dd>{String(selectedShipment.settlement.amountMinor)}</dd>
                  <dt>{text.settledAt}</dt>
                  <dd>{selectedShipment.settlement.settledAt}</dd>
                </dl>
              </>
            )}
            {capabilities.canSettle && selectedShipment.status === "DELIVERED" && (
              <form
                className="logistics__form"
                aria-label={text.settle}
                onSubmit={(event) => void settle(event, selectedShipment)}
              >
                <h3>{text.settle}</h3>
                <label htmlFor={amountId}>
                  {text.amountMinor}
                  <input id={amountId} name="amountMinor" type="number" min={0} step={1} required />
                </label>
                <label htmlFor={settledId}>
                  {text.settledAt}
                  <input id={settledId} name="settledAt" type="datetime-local" required />
                </label>
                <button type="submit" disabled={busy}>{text.settle}</button>
              </form>
            )}
          </article>
        )}
      </div>
    </section>
  );
}
