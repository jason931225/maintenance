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
      <InventoryOperations api={api} item={item} />
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

function InventoryOperations({ api, item }: { api: ConsoleApiClient; item: InventoryItem }) {
  const [movements, setMovements] = useState<InventoryMovement[] | null>(null);
  const [mrp, setMrp] = useState<Awaited<ReturnType<typeof getInventoryMrp>> | null>(null);
  const [counts, setCounts] = useState<CycleCountDetail["count"][]>([]);
  const [count, setCount] = useState<CycleCountDetail | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const loadEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const receiptAttempt = useRef<{ payload: string; key: string } | null>(null);
  const [amount, setAmount] = useState(""); const [sourceRef, setSourceRef] = useState(""); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [counted, setCounted] = useState(""); const [reason, setReason] = useState(""); const [memo, setMemo] = useState("");
  useEffect(() => {
    mutationEpoch.current += 1;
    setCount(null);
  }, [item.branch_id, item.id]);
  const load = async () => {
    const controller = new AbortController();
    const epoch = ++loadEpoch.current;
    setMessage(null);
    try { const [nextMovements, nextMrp, nextCounts] = await Promise.all([listInventoryMovements(api, item.id, controller.signal), getInventoryMrp(api, item.branch_id, controller.signal), listCycleCounts(api, item.branch_id, controller.signal)]); if (!controller.signal.aborted && epoch === loadEpoch.current) { setMovements(nextMovements); setMrp(nextMrp); setCounts(nextCounts); } }
    catch (error) { if (!controller.signal.aborted && epoch === loadEpoch.current) setMessage(isAccessDenied(error) ? "이 지점의 재고 운영 정보를 조회할 권한이 없습니다." : "재고 운영 정보를 안전하게 확인하지 못했습니다."); }
    return controller;
  };
  useEffect(() => { const controller = new AbortController(); const epoch = ++loadEpoch.current; void Promise.all([listInventoryMovements(api, item.id, controller.signal), getInventoryMrp(api, item.branch_id, controller.signal), listCycleCounts(api, item.branch_id, controller.signal)]).then(([nextMovements, nextMrp, nextCounts]) => { if (!controller.signal.aborted && epoch === loadEpoch.current) { setMovements(nextMovements); setMrp(nextMrp); setCounts(nextCounts); } }).catch((error: unknown) => { if (!controller.signal.aborted && epoch === loadEpoch.current) setMessage(isAccessDenied(error) ? "이 지점의 재고 운영 정보를 조회할 권한이 없습니다." : "재고 운영 정보를 안전하게 확인하지 못했습니다."); }); return () => controller.abort(); }, [api, item.id, item.branch_id]);
  async function receipt() { const milli = milliUnits(amount); if (milli == null) { setMessage("입고 수량은 0보다 큰 셋째 자리 단위여야 합니다."); return; } const generation = mutationEpoch.current; const payload = JSON.stringify([item.id, milli, sourceRef.trim()]); if (receiptAttempt.current?.payload !== payload) receiptAttempt.current = { payload, key: crypto.randomUUID() }; setBusy(true); try { await receiveInventoryItem(api, item.id, { quantity_received_milli: milli, source_ref: sourceRef.trim() || undefined, idempotency_key: receiptAttempt.current.key }); if (generation !== mutationEpoch.current) return; receiptAttempt.current = null; setShowReceipt(false); setAmount(""); setSourceRef(""); await load(); } catch (error) { if (generation === mutationEpoch.current) setMessage(isAccessDenied(error) ? "입고 권한이 없습니다." : "입고가 저장되지 않았습니다. 같은 내용으로 다시 제출하면 중복을 방지합니다."); } finally { if (generation === mutationEpoch.current) setBusy(false); } }
  async function openCount() { const generation = mutationEpoch.current; setBusy(true); try { const next = await openCycleCount(api, item.branch_id, item.stock_location.id); if (generation !== mutationEpoch.current) return; setCount(next); await load(); } catch (error) { if (generation === mutationEpoch.current) setMessage(isAccessDenied(error) ? "실사 개설 권한이 없습니다." : "실사 개설에 실패했습니다."); } finally { if (generation === mutationEpoch.current) setBusy(false); } }
  async function line() { if (!count) return; const milli = nonNegativeMilliUnits(counted); if (milli == null) { setMessage("실사 수량은 0 이상 정수/소수 셋째 자리로 입력하세요."); return; } const snapshot = count.lines.find((entry) => entry.item_id === item.id); if (snapshot && milli !== snapshot.system_quantity_milli && !reason) { setMessage("시스템 수량과 다른 실사는 차이 사유가 필요합니다."); return; } const generation = mutationEpoch.current; setBusy(true); try { const next = await upsertCycleLine(api, count.count.id, { item_id: item.id, counted_quantity_milli: milli, reason: reason || undefined, note: memo.trim() || undefined }); if (generation !== mutationEpoch.current) return; setCount(next); } catch (error) { if (generation === mutationEpoch.current) setMessage(isAccessDenied(error) ? "실사 라인을 변경할 권한이 없습니다." : "실사 라인이 저장되지 않았습니다. 최신 상태를 다시 확인하세요."); } finally { if (generation === mutationEpoch.current) setBusy(false); } }
  async function transition(action: "submit" | "approve" | "reject" | "cancel") { if (!count) return; const generation = mutationEpoch.current; setBusy(true); try { const next = action === "submit" ? await submitCycleCount(api, count.count.id, count.count.version) : action === "cancel" ? await cancelCycleCount(api, count.count.id) : await decideCycleCount(api, count.count.id, { expected_version: count.count.version, decision: action === "approve" ? "APPROVE" : "REJECT", memo: memo.trim() || undefined, idempotency_key: action === "approve" ? crypto.randomUUID() : undefined }); if (generation !== mutationEpoch.current) return; setCount(next); await load(); } catch (error) { if (generation === mutationEpoch.current) setMessage(isAccessDenied(error) ? "이 전환을 수행할 권한이 없습니다." : "동시 변경 또는 정책 검증으로 전환이 거부되었습니다. 최신 실사를 다시 확인하세요."); } finally { if (generation === mutationEpoch.current) setBusy(false); } }
  return <section style={{ padding: "var(--sp-4)", borderBottom: "1px solid var(--border-soft)", display: "grid", gap: "var(--sp-3)" }} aria-label="재고 운영">
    <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-2)", flexWrap: "wrap" }}><h3 style={{ margin: 0, fontSize: "var(--text-base)" }}>입고 · 이동 · 실사 · MRP</h3><button type="button" style={buttonStyle} onClick={() => void load()}>운영 정보 새로고침</button></div>
    {message ? <div role="alert" style={errorStyle}>{message}</div> : null}
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}><button type="button" style={primaryButtonStyle} onClick={() => setShowReceipt((value) => !value)}>{showReceipt ? "입고 닫기" : "입고 기록"}</button><button type="button" style={buttonStyle} onClick={() => void openCount()} disabled={busy}>이 위치 실사 개설</button>{counts.map((entry) => <button key={entry.id} type="button" style={buttonStyle} onClick={() => void getCycleCount(api, entry.id).then(setCount).catch(() => setMessage("실사 상세를 불러오지 못했습니다."))}>{entry.cc_code} · {entry.status}</button>)}</div>
    {showReceipt ? <form onSubmit={(event) => { event.preventDefault(); void receipt(); }} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(12rem,1fr))", gap: "var(--sp-2)" }} aria-label="재고 입고 기록"><label>입고 수량 ({item.unit_code})<input required value={amount} onChange={(event) => setAmount(event.target.value)} style={inputStyle} inputMode="decimal" /></label><label>원천 문서 (선택)<input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} style={inputStyle} placeholder="PO-118" /></label><button type="submit" style={primaryButtonStyle} disabled={busy}>{busy ? "저장 중" : "입고 저장"}</button></form> : null}
    {count ? <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: "var(--sp-3)", display: "grid", gap: "var(--sp-2)" }}><strong>{count.count.cc_code} · {count.count.status} · 버전 {count.count.version}</strong><p style={{ margin: 0, color: "var(--steel)" }}>개설자 {count.count.opened_by}. 제출자와 결정자는 분리되어야 하며, 승인 시 조정 원장이 생성됩니다.</p>{count.count.status === "DRAFT" ? <><label>실사 수량 ({item.unit_code})<input value={counted} onChange={(event) => setCounted(event.target.value)} style={inputStyle} inputMode="decimal" /></label><label>차이 사유 (차이가 있을 때 필수)<select value={reason} onChange={(event) => setReason(event.target.value)} style={inputStyle}><option value="">선택</option>{["DAMAGE","LOSS","MISCOUNT","FOUND","OTHER"].map((value) => <option key={value}>{value}</option>)}</select></label><button type="button" style={buttonStyle} onClick={() => void line()} disabled={busy}>실사 라인 저장</button><button type="button" style={primaryButtonStyle} onClick={() => void transition("submit")} disabled={busy || count.lines.length === 0}>실사 제출</button></> : null}<label>결정 메모{count.count.status === "SUBMITTED" ? <input value={memo} onChange={(event) => setMemo(event.target.value)} style={inputStyle} /> : null}</label>{count.count.status === "SUBMITTED" ? <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}><button type="button" style={primaryButtonStyle} onClick={() => void transition("approve")} disabled={busy}>별도 검토자 승인</button><button type="button" style={buttonStyle} onClick={() => void transition("reject")} disabled={busy}>반려</button></div> : null}{["DRAFT", "SUBMITTED"].includes(count.count.status) ? <button type="button" style={buttonStyle} onClick={() => void transition("cancel")} disabled={busy}>실사 취소</button> : null}</div> : null}
    <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><caption style={{ textAlign: "left", padding: "var(--sp-2) 0" }}>통합 이동 원장</caption><thead><tr><th style={thStyle}>시각</th><th style={thStyle}>유형</th><th style={thStyle}>증감</th><th style={thStyle}>변경 후</th></tr></thead><tbody>{movements?.map((movement) => <tr key={movement.id}><td style={tdStyle}>{formatTime(movement.occurred_at)}</td><td style={tdStyle}>{movement.kind}</td><td style={tdStyle}>{quantity(movement.quantity_delta_milli, item.unit_code)}</td><td style={tdStyle}>{quantity(movement.quantity_after_milli, item.unit_code)}</td></tr>)}</tbody></table></div>
    <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><caption style={{ textAlign: "left", padding: "var(--sp-2) 0" }}>결정론적 MRP 권고</caption><thead><tr><th style={thStyle}>품목</th><th style={thStyle}>월 사용량</th><th style={thStyle}>입고 예정 / 예약</th><th style={thStyle}>권고</th></tr></thead><tbody>{mrp?.map((line) => <tr key={line.item_id}><td style={tdStyle}>{line.iv_code} · {line.display_name}</td><td style={tdStyle}>{quantity(line.monthly_usage_milli, line.unit_code)}</td><td style={tdStyle}>{quantity(line.inbound_expected_milli, line.unit_code)} / {quantity(line.reserved_outbound_milli, line.unit_code)}</td><td style={tdStyle}>{line.short ? quantity(line.proposed_order_milli, line.unit_code) : "발주 불필요"}</td></tr>)}</tbody></table></div>
  </section>;
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
