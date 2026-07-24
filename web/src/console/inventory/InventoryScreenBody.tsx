import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { useAuth } from "../../context/auth";
import { inventoryKo as T } from "../../i18n/inventory";
import { StatusChip } from "../components";
import { screenHeaderStyle, screenTitleStyle } from "../screens/screenHeader";
import {
  consumeInventoryItem,
  getInventoryItem,
  isAccessDenied,
  listInventoryConsumptions,
  listInventoryItems,
  listOpenWorkOrders,
  listInventoryMovements,
  receiveInventoryItem,
  getInventoryMrp,
  listCycleCounts,
  openCycleCount,
  getCycleCount,
  upsertCycleLine,
  submitCycleCount,
  decideCycleCount,
  cancelCycleCount,
  milliUnits,
  nonNegativeMilliUnits,
  type CycleCountDetail,
  type InventoryMovement,
  type InventoryConsumptionEvent,
  type InventoryItem,
  type WorkOrderSummary,
} from "./inventoryApi";
import type { ConsoleApiClient } from "../../api/client";

type LoadState = "loading" | "ready" | "error" | "denied";
type DetailState = "idle" | "loading" | "ready" | "error" | "denied";
type CycleCountReason = Exclude<
  CycleCountDetail["lines"][number]["reason"],
  null
>;

const cycleCountReasons = [
  "DAMAGE",
  "LOSS",
  "MISCOUNT",
  "FOUND",
  "OTHER",
] as const satisfies readonly CycleCountReason[];

function cycleCountReason(value: string): CycleCountReason | "" {
  return cycleCountReasons.includes(value as CycleCountReason)
    ? (value as CycleCountReason)
    : "";
}

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};
const controlsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
  alignItems: "end",
};
const inputStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  flex: "1 1 16rem",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
};
const buttonStyle: CSSProperties = {
  minHeight: 44,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};
const panelStyle: CSSProperties = {
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  overflow: "hidden",
};
const errorStyle: CSSProperties = {
  padding: "var(--sp-4)",
  border: "1px solid var(--danger-bd)",
  borderRadius: "var(--radius-md)",
  color: "var(--danger-tx)",
  background: "var(--danger-bg)",
};
const thStyle: CSSProperties = {
  padding: "var(--sp-3)",
  textAlign: "left",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  borderBottom: "1px solid var(--border-soft)",
  whiteSpace: "nowrap",
};
const tdStyle: CSSProperties = {
  padding: "var(--sp-3)",
  borderBottom: "1px solid var(--border-soft)",
  fontSize: "var(--text-sm)",
  verticalAlign: "middle",
};
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 });
const won = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});
const dateTime = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
});

function quantity(milli: number, unit: string): string {
  return `${number.format(milli / 1_000)} ${unit}`;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTime.format(parsed);
}

function statusTone(item: InventoryItem): "ok" | "warn" | "danger" | "neutral" {
  if (item.low_stock) return "danger";
  if (item.status.toLowerCase().includes("hold")) return "warn";
  return "ok";
}

function sourceLabel(event: InventoryConsumptionEvent): string {
  return event.source.kind === "work_order"
    ? T.sourceWorkOrder(event.source.work_order_id)
    : T.sourceDispatch(event.source.dispatch_id);
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      style={{ margin: 0, padding: "var(--sp-5)", color: "var(--steel)" }}
    >
      {children}
    </p>
  );
}

export function InventoryScreenBody() {
  const { api, session } = useAuth();
  return (
    <InventoryScreenContent
      key={session?.client_session_incarnation ?? "inventory-anonymous"}
      api={api}
    />
  );
}

export function InventoryScreenContent({ api }: { api: ConsoleApiClient }) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [lowStock, setLowStock] = useState(false);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [listState, setListState] = useState<LoadState>("loading");
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InventoryItem | null>(null);
  const [events, setEvents] = useState<InventoryConsumptionEvent[]>([]);
  const [detailState, setDetailState] = useState<DetailState>("idle");
  const [detailRetry, setDetailRetry] = useState(0);
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const selectionEpoch = useRef(0);
  const [selectionToken, setSelectionToken] = useState(0);

  function advanceSelectionEpoch() {
    selectionEpoch.current += 1;
    setSelectionToken(selectionEpoch.current);
  }

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++listEpoch.current;
    void listInventoryItems(api, { q: query, lowStock }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || epoch !== listEpoch.current) return;
        setItems(page.items);
        setTotal(page.total);
        setListState("ready");
        setSelectedId((current) =>
          page.items.some((item) => item.id === current) ? current : null,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || epoch !== listEpoch.current) return;
        setItems([]);
        setTotal(0);
        selectionEpoch.current += 1;
        setSelectionToken(selectionEpoch.current);
        setSelectedId(null);
        setDetail(null);
        setEvents([]);
        setDetailState("idle");
        setListState(isAccessDenied(error) ? "denied" : "error");
      });
    return () => {
      controller.abort();
    };
  }, [api, lowStock, query, retry]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    const epoch = ++detailEpoch.current;
    const selectedAtStart = selectionEpoch.current;
    void Promise.all([
      getInventoryItem(api, selectedId, controller.signal),
      listInventoryConsumptions(api, selectedId, controller.signal),
    ])
      .then(([nextDetail, nextEvents]) => {
        if (
          controller.signal.aborted ||
          epoch !== detailEpoch.current ||
          selectedAtStart !== selectionEpoch.current
        )
          return;
        setDetail(nextDetail);
        setEvents(nextEvents);
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          epoch !== detailEpoch.current ||
          selectedAtStart !== selectionEpoch.current
        )
          return;
        setDetail(null);
        setEvents([]);
        setDetailState(isAccessDenied(error) ? "denied" : "error");
      });
    return () => {
      controller.abort();
    };
  }, [api, detailRetry, selectedId]);

  function selectItem(itemId: string) {
    advanceSelectionEpoch();
    setSelectedId(itemId);
    setDetail(null);
    setEvents([]);
    setDetailState("loading");
  }

  function submitSearch(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setListState("loading");
    setQuery(queryInput.trim());
  }

  function changeLowStock(checked: boolean) {
    setListState("loading");
    setLowStock(checked);
  }

  function refreshList() {
    setListState("loading");
    setRetry((value) => value + 1);
  }

  function retryDetail() {
    setDetailState("loading");
    setDetailRetry((value) => value + 1);
  }

  const lowCount = useMemo(
    () => items.filter((item) => item.low_stock).length,
    [items],
  );

  return (
    <main style={rootStyle} aria-label={T.ariaMain}>
      <header style={screenHeaderStyle}>
        <div>
          <p
            style={{
              margin: 0,
              color: "var(--steel)",
              fontSize: "var(--text-sm)",
            }}
          >
            {T.eyebrow}
          </p>
          <h1 style={screenTitleStyle}>{T.title}</h1>
          <p style={{ margin: "var(--sp-1) 0 0", color: "var(--steel)" }}>
            {T.description}
          </p>
        </div>
        <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          <StatusChip tone={lowCount > 0 ? "danger" : "ok"}>
            {T.lowStock(lowCount)}
          </StatusChip>
          <StatusChip tone="neutral">{T.total(total)}</StatusChip>
        </div>
      </header>

      <form style={controlsStyle} onSubmit={submitSearch}>
        <label
          style={{ display: "grid", gap: "var(--sp-1)", flex: "1 1 16rem" }}
        >
          <span
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--fw-strong)",
            }}
          >
            {T.searchLabel}
          </span>
          <input
            value={queryInput}
            onChange={(event) => {
              setQueryInput(event.target.value);
            }}
            style={inputStyle}
            type="search"
            placeholder={T.searchPlaceholder}
            aria-label={T.searchAria}
          />
        </label>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: 44,
            gap: "var(--sp-2)",
            fontSize: "var(--text-sm)",
          }}
        >
          <input
            type="checkbox"
            checked={lowStock}
            onChange={(event) => {
              changeLowStock(event.target.checked);
            }}
          />{" "}
          {T.lowStockOnly}
        </label>
        <button type="submit" style={primaryButtonStyle}>
          {T.search}
        </button>
        <button type="button" style={buttonStyle} onClick={refreshList}>
          {T.refresh}
        </button>
      </form>

      {listState === "denied" ? (
        <div role="alert" style={errorStyle}>
          {T.listDenied}
        </div>
      ) : null}
      {listState === "error" ? (
        <div role="alert" style={errorStyle}>
          {T.listFailed}
        </div>
      ) : null}
      <section
        style={panelStyle}
        aria-busy={listState === "loading"}
        aria-label={T.listAria}
      >
        {listState === "loading" ? (
          <EmptyState>{T.listLoading}</EmptyState>
        ) : null}
        {listState === "ready" && items.length === 0 ? (
          <EmptyState>{T.listEmpty}</EmptyState>
        ) : null}
        {listState === "ready" && items.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>{T.columnItem}</th>
                  <th style={thStyle}>{T.columnLocation}</th>
                  <th style={thStyle}>{T.columnQuantity}</th>
                  <th style={thStyle}>{T.columnStatus}</th>
                  <th style={thStyle}>
                    <span className="sr-only">{T.details}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} aria-selected={selectedId === item.id}>
                    <td style={tdStyle}>
                      <strong>{item.display_name}</strong>
                      <br />
                      <span style={{ color: "var(--steel)" }}>
                        {item.iv_code}
                        {item.sku ? ` · ${item.sku}` : ""}
                      </span>
                    </td>
                    <td style={tdStyle}>{item.stock_location.label}</td>
                    <td style={tdStyle}>
                      {quantity(item.quantity_on_hand_milli, item.unit_code)} /{" "}
                      {quantity(item.safety_stock_milli, item.unit_code)}
                    </td>
                    <td style={tdStyle}>
                      <StatusChip tone={statusTone(item)}>
                        {item.low_stock ? T.lowStockStatus : item.status}
                      </StatusChip>
                    </td>
                    <td style={tdStyle}>
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => {
                          selectItem(item.id);
                        }}
                        aria-label={T.openDetailsAria(item.iv_code)}
                      >
                        {T.details}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selectedId ? (
        <InventoryDetail
          key={selectedId}
          api={api}
          item={detail}
          events={events}
          state={detailState}
          selectionEpoch={selectionToken}
          onRetry={retryDetail}
          onConsumed={(result, consumedSelectionEpoch) => {
            if (
              consumedSelectionEpoch !== selectionEpoch.current ||
              result.item.id !== selectedId
            )
              return;
            setDetail(result.item);
            setEvents((current) => [result.event, ...current]);
            setItems((current) =>
              current.map((item) =>
                item.id === result.item.id ? result.item : item,
              ),
            );
          }}
        />
      ) : (
        <EmptyState>{T.selectItemHint}</EmptyState>
      )}
    </main>
  );
}

function InventoryDetail({
  api,
  item,
  events,
  state,
  selectionEpoch,
  onRetry,
  onConsumed,
}: {
  api: ConsoleApiClient;
  item: InventoryItem | null;
  events: InventoryConsumptionEvent[];
  state: DetailState;
  selectionEpoch: number;
  onRetry: () => void;
  onConsumed: (
    result: Awaited<ReturnType<typeof consumeInventoryItem>>,
    selectionEpoch: number,
  ) => void;
}) {
  const [showConsume, setShowConsume] = useState(false);
  if (state === "loading")
    return (
      <section style={panelStyle} aria-busy="true">
        <EmptyState>{T.detailLoading}</EmptyState>
      </section>
    );
  if (state === "denied")
    return (
      <div role="alert" style={errorStyle}>
        {T.detailDenied}
      </div>
    );
  if (state === "error" || !item)
    return (
      <div role="alert" style={errorStyle}>
        {T.detailFailed}{" "}
        <button type="button" style={buttonStyle} onClick={onRetry}>
          {T.retry}
        </button>
      </div>
    );
  return (
    <section style={panelStyle} aria-label={T.itemDetailAria(item.iv_code)}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "var(--sp-3)",
          flexWrap: "wrap",
          padding: "var(--sp-4)",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: "var(--text-lg)" }}>
            {item.display_name}
          </h2>
          <p style={{ margin: "var(--sp-1) 0 0", color: "var(--steel)" }}>
            {item.iv_code} · {item.stock_location.label}
            {item.description ? ` · ${item.description}` : ""}
          </p>
        </div>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => {
            setShowConsume((open) => !open);
          }}
        >
          {showConsume ? T.closeConsumption : T.openConsumption}
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
          gap: "var(--sp-3)",
          padding: "var(--sp-4)",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <DetailMetric
          label={T.metricOnHand}
          value={quantity(item.quantity_on_hand_milli, item.unit_code)}
        />
        <DetailMetric
          label={T.metricSafety}
          value={quantity(item.safety_stock_milli, item.unit_code)}
        />
        <DetailMetric
          label={T.metricCost}
          value={
            item.unit_cost_won == null
              ? T.noCost
              : won.format(item.unit_cost_won)
          }
        />
        <DetailMetric
          label={T.metricStatus}
          value={item.low_stock ? T.lowStockStatus : item.status}
        />
      </div>
      {showConsume ? (
        <ConsumptionForm
          api={api}
          item={item}
          onSuccess={(result) => {
            onConsumed(result, selectionEpoch);
            setShowConsume(false);
          }}
        />
      ) : null}
      <InventoryOperations
        key={`${item.branch_id}:${item.id}`}
        api={api}
        item={item}
      />
      <div style={{ padding: "var(--sp-4)" }}>
        <h3 style={{ margin: "0 0 var(--sp-3)", fontSize: "var(--text-base)" }}>
          {T.traceTitle}
        </h3>
        {events.length === 0 ? (
          <EmptyState>{T.traceEmpty}</EmptyState>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>{T.columnTime}</th>
                  <th style={thStyle}>{T.columnSource}</th>
                  <th style={thStyle}>{T.columnConsumption}</th>
                  <th style={thStyle}>{T.columnAfter}</th>
                  <th style={thStyle}>{T.columnMemo}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td style={tdStyle}>{formatTime(event.occurred_at)}</td>
                    <td style={tdStyle}>{sourceLabel(event)}</td>
                    <td style={tdStyle}>
                      {quantity(event.quantity_consumed_milli, item.unit_code)}
                    </td>
                    <td style={tdStyle}>
                      {quantity(event.quantity_after_milli, item.unit_code)}
                    </td>
                    <td style={tdStyle}>{event.memo ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function InventoryOperations({
  api,
  item,
}: {
  api: ConsoleApiClient;
  item: InventoryItem;
}) {
  const [movements, setMovements] = useState<InventoryMovement[] | null>(null);
  const [mrp, setMrp] = useState<
    Awaited<ReturnType<typeof getInventoryMrp>> | null
  >(null);
  const [counts, setCounts] = useState<CycleCountDetail["count"][]>([]);
  const [count, setCount] = useState<CycleCountDetail | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [amount, setAmount] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState<CycleCountReason | "">("");
  const [memo, setMemo] = useState("");
  const loadEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const countSelectionEpoch = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const receiptAttempt = useRef<{ payload: string; key: string } | null>(null);
  const approvalAttempt = useRef<{ payload: string; key: string } | null>(
    null,
  );

  async function load() {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const epoch = ++loadEpoch.current;
    setMessage(null);
    try {
      const [nextMovements, nextMrp, nextCounts] = await Promise.all([
        listInventoryMovements(api, item.id, controller.signal),
        getInventoryMrp(api, item.branch_id, controller.signal),
        listCycleCounts(api, item.branch_id, controller.signal),
      ]);
      if (!controller.signal.aborted && epoch === loadEpoch.current) {
        setMovements(nextMovements);
        setMrp(nextMrp);
        setCounts(nextCounts);
      }
    } catch (error) {
      if (!controller.signal.aborted && epoch === loadEpoch.current) {
        setMessage(
          isAccessDenied(error) ? T.operationsDenied : T.operationsFailed,
        );
      }
    } finally {
      if (readController.current === controller) {
        readController.current = null;
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    readController.current = controller;
    const epoch = ++loadEpoch.current;
    void Promise.all([
      listInventoryMovements(api, item.id, controller.signal),
      getInventoryMrp(api, item.branch_id, controller.signal),
      listCycleCounts(api, item.branch_id, controller.signal),
    ])
      .then(([nextMovements, nextMrp, nextCounts]) => {
        if (!controller.signal.aborted && epoch === loadEpoch.current) {
          setMovements(nextMovements);
          setMrp(nextMrp);
          setCounts(nextCounts);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && epoch === loadEpoch.current) {
          setMessage(
            isAccessDenied(error) ? T.operationsDenied : T.operationsFailed,
          );
        }
      });
    return () => {
      controller.abort();
      loadEpoch.current += 1;
      mutationEpoch.current += 1;
      countSelectionEpoch.current += 1;
      if (readController.current === controller) {
        readController.current = null;
      }
    };
  }, [api, item.branch_id, item.id]);

  async function receipt() {
    const milli = milliUnits(amount);
    if (milli == null) {
      setMessage(T.receiptQuantityInvalid);
      return;
    }
    const generation = mutationEpoch.current;
    const payload = JSON.stringify([item.id, milli, sourceRef.trim()]);
    if (receiptAttempt.current?.payload !== payload) {
      receiptAttempt.current = { payload, key: crypto.randomUUID() };
    }
    setBusy(true);
    try {
      await receiveInventoryItem(api, item.id, {
        quantity_received_milli: milli,
        source_ref: sourceRef.trim() || undefined,
        idempotency_key: receiptAttempt.current.key,
      });
      if (generation !== mutationEpoch.current) return;
      receiptAttempt.current = null;
      setShowReceipt(false);
      setAmount("");
      setSourceRef("");
      await load();
    } catch (error) {
      if (generation === mutationEpoch.current) {
        setMessage(
          isAccessDenied(error) ? T.receiptDenied : T.receiptFailed,
        );
      }
    } finally {
      if (generation === mutationEpoch.current) setBusy(false);
    }
  }

  async function openCount() {
    const generation = mutationEpoch.current;
    const countGeneration = ++countSelectionEpoch.current;
    setBusy(true);
    try {
      const next = await openCycleCount(
        api,
        item.branch_id,
        item.stock_location.id,
      );
      if (
        generation !== mutationEpoch.current ||
        countGeneration !== countSelectionEpoch.current
      )
        return;
      setCount(next);
      await load();
    } catch (error) {
      if (
        generation === mutationEpoch.current &&
        countGeneration === countSelectionEpoch.current
      ) {
        setMessage(
          isAccessDenied(error) ? T.cycleCountOpenDenied : T.cycleCountOpenFailed,
        );
      }
    } finally {
      if (generation === mutationEpoch.current) setBusy(false);
    }
  }

  async function saveLine() {
    if (!count) return;
    const milli = nonNegativeMilliUnits(counted);
    if (milli == null) {
      setMessage(T.cycleCountQuantityInvalid);
      return;
    }
    const snapshot = count.lines.find((entry) => entry.item_id === item.id);
    const systemQuantity =
      snapshot?.system_quantity_milli ?? item.quantity_on_hand_milli;
    if (
      milli !== systemQuantity &&
      reason.length === 0
    ) {
      setMessage(T.cycleCountReasonRequired);
      return;
    }
    const generation = mutationEpoch.current;
    const countGeneration = ++countSelectionEpoch.current;
    setBusy(true);
    try {
      const next = await upsertCycleLine(api, count.count.id, {
        expected_version: count.count.version,
        item_id: item.id,
        counted_quantity_milli: milli,
        reason: reason || undefined,
        note: memo.trim() || undefined,
      });
      if (
        generation !== mutationEpoch.current ||
        countGeneration !== countSelectionEpoch.current
      )
        return;
      setCount(next);
    } catch (error) {
      if (
        generation === mutationEpoch.current &&
        countGeneration === countSelectionEpoch.current
      ) {
        setMessage(
          isAccessDenied(error) ? T.cycleCountLineDenied : T.cycleCountLineFailed,
        );
      }
    } finally {
      if (generation === mutationEpoch.current) setBusy(false);
    }
  }

  async function transition(
    action: "submit" | "approve" | "reject" | "cancel",
  ) {
    if (!count) return;
    const generation = mutationEpoch.current;
    const countGeneration = ++countSelectionEpoch.current;
    const approvalPayload =
      action === "approve"
        ? JSON.stringify([
            count.count.id,
            count.count.version,
            "APPROVE",
            memo.trim(),
          ])
        : null;
    if (
      approvalPayload &&
      approvalAttempt.current?.payload !== approvalPayload
    ) {
      approvalAttempt.current = {
        payload: approvalPayload,
        key: crypto.randomUUID(),
      };
    }
    setBusy(true);
    try {
      const next =
        action === "submit"
          ? await submitCycleCount(
              api,
              count.count.id,
              count.count.version,
            )
          : action === "cancel"
            ? await cancelCycleCount(
                api,
                count.count.id,
                count.count.version,
              )
            : await decideCycleCount(api, count.count.id, {
                expected_version: count.count.version,
                decision: action === "approve" ? "APPROVE" : "REJECT",
                memo: memo.trim() || undefined,
                idempotency_key:
                  action === "approve"
                    ? approvalAttempt.current?.key
                    : undefined,
              });
      if (
        generation !== mutationEpoch.current ||
        countGeneration !== countSelectionEpoch.current
      )
        return;
      if (
        approvalPayload &&
        approvalAttempt.current?.payload === approvalPayload
      ) {
        approvalAttempt.current = null;
      }
      setCount(next);
      await load();
    } catch (error) {
      if (
        generation === mutationEpoch.current &&
        countGeneration === countSelectionEpoch.current
      ) {
        setMessage(
          isAccessDenied(error)
            ? T.cycleCountTransitionDenied
            : T.cycleCountTransitionFailed,
        );
      }
    } finally {
      if (generation === mutationEpoch.current) setBusy(false);
    }
  }

  async function selectCount(countId: string) {
    const generation = mutationEpoch.current;
    const selection = ++countSelectionEpoch.current;
    try {
      const detail = await getCycleCount(api, countId);
      if (
        generation === mutationEpoch.current &&
        selection === countSelectionEpoch.current
      ) {
        setCount(detail);
      }
    } catch {
      if (
        generation === mutationEpoch.current &&
        selection === countSelectionEpoch.current
      ) {
        setMessage(T.cycleCountDetailFailed);
      }
    }
  }

  return (
    <section
      style={{
        padding: "var(--sp-4)",
        borderBottom: "1px solid var(--border-soft)",
        display: "grid",
        gap: "var(--sp-3)",
      }}
      aria-label={T.operationsAria}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "var(--sp-2)",
          flexWrap: "wrap",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "var(--text-base)" }}>
          {T.operationsTitle}
        </h3>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void load();
          }}
        >
          {T.refreshOperations}
        </button>
      </div>
      {message ? (
        <div role="alert" style={errorStyle}>
          {message}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sp-2)",
        }}
      >
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => {
            setShowReceipt((value) => !value);
          }}
        >
          {showReceipt ? T.closeReceipt : T.openReceipt}
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void openCount();
          }}
          disabled={busy}
        >
          {T.openLocationCycleCount}
        </button>
        {counts.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              void selectCount(entry.id);
            }}
            style={buttonStyle}
          >
            {entry.cc_code} · {entry.status}
          </button>
        ))}
      </div>
      {showReceipt ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void receipt();
          }}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(12rem,1fr))",
            gap: "var(--sp-2)",
          }}
          aria-label={T.receiptAria}
        >
          <label>
            {T.receiptQuantity(item.unit_code)}
            <input
              required
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              style={inputStyle}
              inputMode="decimal"
            />
          </label>
          <label>
            {T.sourceDocumentOptional}
            <input
              value={sourceRef}
              onChange={(event) => {
                setSourceRef(event.target.value);
              }}
              style={inputStyle}
              placeholder="PO-118"
            />
          </label>
          <button type="submit" style={primaryButtonStyle} disabled={busy}>
            {busy ? T.savingReceipt : T.saveReceipt}
          </button>
        </form>
      ) : null}
      {count ? (
        <div
          style={{
            borderTop: "1px solid var(--border-soft)",
            paddingTop: "var(--sp-3)",
            display: "grid",
            gap: "var(--sp-2)",
          }}
        >
          <strong>
            {T.cycleCountSummary(
              count.count.cc_code,
              count.count.status,
              count.count.version,
            )}
          </strong>
          <p style={{ margin: 0, color: "var(--steel)" }}>
            {T.cycleCountGovernance(count.count.opened_by)}
          </p>
          {count.count.status === "DRAFT" ? (
            <>
              <label>
                {T.cycleCountQuantity(item.unit_code)}
                <input
                  value={counted}
                  onChange={(event) => {
                    setCounted(event.target.value);
                  }}
                  style={inputStyle}
                  inputMode="decimal"
                />
              </label>
              <label>
                {T.cycleCountReason}
                <select
                  value={reason}
                  onChange={(event) => {
                    setReason(cycleCountReason(event.target.value));
                  }}
                  style={inputStyle}
                >
                  <option value="">{T.select}</option>
                  {cycleCountReasons.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  void saveLine();
                }}
                disabled={busy}
              >
                {T.saveCycleCountLine}
              </button>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => {
                  void transition("submit");
                }}
                disabled={busy || count.lines.length === 0}
              >
                {T.submitCycleCount}
              </button>
            </>
          ) : null}
          {count.count.status === "SUBMITTED" ? (
            <>
              <label>
                {T.decisionMemo}
                <input
                  value={memo}
                  onChange={(event) => {
                    setMemo(event.target.value);
                  }}
                  style={inputStyle}
                />
              </label>
              <div
                style={{
                  display: "flex",
                  gap: "var(--sp-2)",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => {
                    void transition("approve");
                  }}
                  disabled={busy}
                >
                  {T.approveBySeparateReviewer}
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => {
                    void transition("reject");
                  }}
                  disabled={busy}
                >
                  {T.rejectCycleCount}
                </button>
              </div>
            </>
          ) : null}
          {["DRAFT", "SUBMITTED"].includes(count.count.status) ? (
            <button
              type="button"
              style={buttonStyle}
              onClick={() => {
                void transition("cancel");
              }}
              disabled={busy}
            >
              {T.cancelCycleCount}
            </button>
          ) : null}
        </div>
      ) : null}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <caption style={{ textAlign: "left", padding: "var(--sp-2) 0" }}>
            {T.movementLedger}
          </caption>
          <thead>
            <tr>
              <th style={thStyle}>{T.movementColumnTime}</th>
              <th style={thStyle}>{T.movementColumnKind}</th>
              <th style={thStyle}>{T.movementColumnDelta}</th>
              <th style={thStyle}>{T.movementColumnAfter}</th>
            </tr>
          </thead>
          <tbody>
            {movements?.map((movement) => (
              <tr key={movement.id}>
                <td style={tdStyle}>{formatTime(movement.occurred_at)}</td>
                <td style={tdStyle}>{movement.kind}</td>
                <td style={tdStyle}>
                  {quantity(
                    movement.quantity_delta_milli,
                    item.unit_code,
                  )}
                </td>
                <td style={tdStyle}>
                  {quantity(
                    movement.quantity_after_milli,
                    item.unit_code,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <caption style={{ textAlign: "left", padding: "var(--sp-2) 0" }}>
            {T.mrpRecommendation}
          </caption>
          <thead>
            <tr>
              <th style={thStyle}>{T.mrpColumnItem}</th>
              <th style={thStyle}>{T.mrpColumnMonthlyUsage}</th>
              <th style={thStyle}>{T.mrpColumnInboundReserved}</th>
              <th style={thStyle}>{T.mrpColumnRecommendation}</th>
            </tr>
          </thead>
          <tbody>
            {mrp?.map((line) => (
              <tr key={line.item_id}>
                <td style={tdStyle}>
                  {line.iv_code} · {line.display_name}
                </td>
                <td style={tdStyle}>
                  {quantity(line.monthly_usage_milli, line.unit_code)}
                </td>
                <td style={tdStyle}>
                  {quantity(line.inbound_expected_milli, line.unit_code)} /{" "}
                  {quantity(line.reserved_outbound_milli, line.unit_code)}
                </td>
                <td style={tdStyle}>
                  {line.short
                    ? quantity(line.proposed_order_milli, line.unit_code)
                    : T.noOrderNecessary}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: "var(--steel)", fontSize: "var(--text-xs)" }}>
        {label}
      </div>
      <strong style={{ display: "block", marginTop: "var(--sp-1)" }}>
        {value}
      </strong>
    </div>
  );
}

function ConsumptionForm({
  api,
  item,
  onSuccess,
}: {
  api: ConsoleApiClient;
  item: InventoryItem;
  onSuccess: (result: Awaited<ReturnType<typeof consumeInventoryItem>>) => void;
}) {
  const [orders, setOrders] = useState<WorkOrderSummary[]>([]);
  const [ordersState, setOrdersState] = useState<LoadState>("loading");
  const [workOrderId, setWorkOrderId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listOpenWorkOrders(api, item.branch_id, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setOrders(next);
          setOrdersState("ready");
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setOrdersState(isAccessDenied(error) ? "denied" : "error");
      });
    return () => {
      controller.abort();
    };
  }, [api, item.branch_id]);
  async function submit() {
    const milli = milliUnits(amount);
    if (!workOrderId || milli == null) {
      setMessage(T.invalidConsumption);
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      onSuccess(
        await consumeInventoryItem(api, item.id, {
          source: { kind: "work_order", work_order_id: workOrderId },
          quantity_consumed_milli: milli,
          memo: memo.trim() || undefined,
          idempotency_key: crypto.randomUUID(),
        }),
      );
    } catch (error) {
      setMessage(
        isAccessDenied(error) ? T.consumptionDenied : T.consumptionFailed,
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{
        display: "grid",
        gap: "var(--sp-3)",
        padding: "var(--sp-4)",
        background: "var(--muted)",
        borderBottom: "1px solid var(--border-soft)",
      }}
      aria-label={T.openConsumption}
    >
      <h3 style={{ margin: 0, fontSize: "var(--text-base)" }}>
        {T.openConsumption}
      </h3>
      <p
        style={{ margin: 0, color: "var(--steel)", fontSize: "var(--text-sm)" }}
      >
        {T.consumptionDescription}
      </p>
      {ordersState === "loading" ? (
        <span role="status">{T.workOrderLoading}</span>
      ) : null}
      {ordersState === "denied" ? (
        <div role="alert" style={errorStyle}>
          {T.workOrderDenied}
        </div>
      ) : null}
      {ordersState === "error" ? (
        <div role="alert" style={errorStyle}>
          {T.workOrderFailed}
        </div>
      ) : null}
      {ordersState === "ready" ? (
        <>
          <label style={{ display: "grid", gap: "var(--sp-1)" }}>
            <span>{T.workOrderLabel}</span>
            <select
              required
              value={workOrderId}
              onChange={(event) => {
                setWorkOrderId(event.target.value);
              }}
              style={inputStyle}
            >
              <option value="">{T.workOrderSelect}</option>
              {orders.map((order) => (
                <option key={order.id} value={order.id}>
                  {order.request_no} · {order.status} · {order.priority}
                </option>
              ))}
            </select>
          </label>
          {orders.length === 0 ? (
            <div role="status">{T.workOrderEmpty}</div>
          ) : null}
          <label style={{ display: "grid", gap: "var(--sp-1)" }}>
            <span>{T.quantityLabel(item.unit_code)}</span>
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              style={inputStyle}
              placeholder={T.quantityPlaceholder}
            />
          </label>
          <label style={{ display: "grid", gap: "var(--sp-1)" }}>
            <span>{T.memoLabel}</span>
            <input
              value={memo}
              onChange={(event) => {
                setMemo(event.target.value);
              }}
              style={inputStyle}
              maxLength={500}
            />
          </label>
          <div>
            {message ? (
              <p role="alert" style={{ color: "var(--danger-tx)" }}>
                {message}
              </p>
            ) : null}
            <button
              type="submit"
              style={primaryButtonStyle}
              disabled={submitting || orders.length === 0}
            >
              {submitting ? T.savingConsumption : T.saveConsumption}
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}
