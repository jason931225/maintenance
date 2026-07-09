import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { ko } from "../../i18n/ko";
import type { ConsoleApiClient } from "../../api/client";
import { KIND_META, TONE, kindFromCode, type Tone } from "../composer/objectKinds";
import { PolicyGated } from "../policy/PolicyGated";
import {
  IMPLEMENTED_FIELDS,
  type ModuleAction,
  type ModuleCell,
  type ModuleConfig,
  type ModuleLane,
  type ModuleLink,
} from "./config";

export type ModuleLoadState = "idle" | "loading" | "error";

export interface ModuleScreenProps<Row> {
  config: ModuleConfig<Row>;
  rows: Row[];
  loadState: ModuleLoadState;
  /** Present in the live harness; omitted in the static fidelity demo (actions
   * still render, but a click without an api is a no-op). */
  api?: ConsoleApiClient;
  /** Retry the load (error state CTA). */
  onRetry?: () => void;
  /** A detail link chip was clicked (object code) — routed to object nav. */
  onOpenObject?: (code: string) => void;
  /** Success toast after a row action's real mutation. */
  onToast?: (message: string) => void;
  /** Pre-open a row's detail (static fidelity demo / tests). */
  initialOpenId?: string;
  /** Header primary action (compose/create) handler. The button renders only
   * when this is supplied AND policy permits — so an unwired compose is never a
   * dead affordance (the compose flow lands in a later slice). */
  onPrimaryAction?: (key: string) => void;
}

/* ────────────────────────────── styles ────────────────────────────── */

const screenStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  height: "100%",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-3)",
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
  whiteSpace: "nowrap",
};

const searchStyle: CSSProperties = {
  minWidth: 0,
  flex: "0 1 16rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  padding: "var(--sp-1) var(--sp-2)",
  fontSize: "var(--text-sm)",
  color: "var(--ink)",
};

const primaryBtnStyle: CSSProperties = {
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--signal)",
  background: "var(--signal)",
  color: "#fff",
  padding: "var(--sp-1) var(--sp-3)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function toneChipStyle(tone: Tone): CSSProperties {
  const t = TONE(tone);
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "0 var(--sp-2)",
    height: "1.5em",
    borderRadius: "var(--radius-chip)",
    border: `1px solid ${t.bd}`,
    background: t.bg,
    color: t.tx,
    fontSize: "var(--text-xs)",
    fontWeight: "var(--fw-medium)",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };
}

/* ────────────────────────── cell / chip render ────────────────────────── */

function Cell({ cell }: { cell: ModuleCell }) {
  if (cell.tone) {
    return <span style={toneChipStyle(cell.tone)}>{cell.text}</span>;
  }
  return (
    <span
      style={{
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontFamily: cell.mono ? "var(--font-mono)" : "inherit",
        fontSize: "var(--text-sm)",
      }}
    >
      {cell.text}
    </span>
  );
}

/** A detail link chip reuses the object-kind tone (§4-18 one chip shape). */
function LinkChip({ link, onOpen }: { link: ModuleLink; onOpen?: (code: string) => void }) {
  const kind = kindFromCode(link.code);
  const tone: Tone = kind ? KIND_META[kind].tone : "neutral";
  const label = link.label?.trim() || link.code;
  const kindLabel = kind ? KIND_META[kind].label : "";
  return (
    <button
      type="button"
      style={{ ...toneChipStyle(tone), cursor: onOpen ? "pointer" : "default", gap: "var(--sp-1)" }}
      aria-label={`${kindLabel} ${link.code} ${label}`.trim()}
      data-object-code={link.code}
      onClick={onOpen ? () => { onOpen(link.code); } : undefined}
    >
      {label}
    </button>
  );
}

/* ─────────────────────────────── stat bar ─────────────────────────────── */

function StatBar<Row>({ config, rows }: { config: ModuleConfig<Row>; rows: Row[] }) {
  const stats = config.statbar(rows);
  if (stats.length === 0) return null;
  return (
    <div
      data-fidelity="module-statbar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-4)",
        padding: "var(--sp-2) var(--sp-4)",
        borderBottom: "1px solid var(--border-soft)",
        overflowX: "auto",
      }}
    >
      {stats.map((s) => (
        <div key={s.key} style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-1)", whiteSpace: "nowrap" }}>
          <span
            style={{
              fontSize: "var(--text-micro)",
              fontWeight: "var(--fw-strong)",
              letterSpacing: "var(--tracking-label)",
              textTransform: "uppercase",
              color: "var(--faint)",
            }}
          >
            {s.label}
          </span>
          <span style={{ fontSize: "var(--text-value)", fontWeight: "var(--fw-strong)", color: s.tone ? TONE(s.tone).tx : "var(--ink)" }}>
            {/* DESIGN §4.7-1 "0은 숨김/—": a zero count reads as an em dash, never "0". */}
            {s.value === "0" ? "—" : s.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────── progress bar ───────────────────────────── */

function ProgBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const tone: Tone = total > 0 && done >= total ? "ok" : "warn";
  const t = TONE(tone);
  return (
    <div
      data-fidelity="module-prog"
      style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", padding: "var(--sp-2) var(--sp-4)", borderBottom: "1px solid var(--border-soft)" }}
    >
      <span style={{ fontSize: "var(--text-micro)", fontWeight: "var(--fw-strong)", letterSpacing: "var(--tracking-label)", textTransform: "uppercase", color: "var(--faint)" }}>
        {ko.console.module.prog.label}
      </span>
      <div style={{ position: "relative", flex: 1, height: 6, borderRadius: "var(--radius-pill)", background: "var(--muted)", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, width: `${String(pct)}%`, background: t.tx }} />
      </div>
      <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--fw-medium)", color: t.tx, whiteSpace: "nowrap" }}>
        {done} / {total}
      </span>
    </div>
  );
}

/* ─────────────────────────────── list table ───────────────────────────── */

const ROW_HEIGHT = 40;
// DESIGN §4.7-1 "8px 틱" — column resize snaps to this grid (readme.md:25).
const COLUMN_TICK = 8;

function useColumnWidths<Row>(config: ModuleConfig<Row>) {
  const defaults = useMemo(() => {
    const d: Record<string, number> = {};
    for (const c of config.columns) d[c.key] = c.width;
    return d;
  }, [config]);
  // Initialized once; the caller keys ListTable by config.key, so a config
  // change remounts and re-seeds these defaults (no reset effect needed).
  const [widths, setWidths] = useState(defaults);

  const dragCleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    dragCleanup.current?.();
  }, []);

  const startDrag = (key: string, min: number) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[key];
    const onMove = (ev: globalThis.MouseEvent) => {
      // DESIGN §4.7-1: column drag snaps to 8px ticks, floored at the
      // per-column legibility minimum.
      const snapped = Math.round((startW + (ev.clientX - startX)) / COLUMN_TICK) * COLUMN_TICK;
      setWidths((prev) => ({ ...prev, [key]: Math.max(min, snapped) }));
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragCleanup.current === cleanup) dragCleanup.current = null;
    };
    const onUp = () => { cleanup(); };
    dragCleanup.current?.();
    dragCleanup.current = cleanup;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const resetCol = (key: string) => () => { setWidths((prev) => ({ ...prev, [key]: defaults[key] })); };

  return { widths, startDrag, resetCol };
}

interface ListTableProps<Row> {
  config: ModuleConfig<Row>;
  rows: Row[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onKeyNav: (e: KeyboardEvent<HTMLDivElement>) => void;
}

function ListTable<Row>({ config, rows, selectedId, onSelect, onOpen, onKeyNav }: ListTableProps<Row>) {
  const { widths, startDrag, resetCol } = useColumnWidths(config);
  // Shared column track: header and every row use the IDENTICAL template, plus
  // a trailing flexible filler track so the grid fills the width.
  const template = config.columns.map((c) => `${String(widths[c.key])}px`).join(" ") + " minmax(0, 1fr)";
  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: template,
    gap: "var(--sp-2)",
    alignItems: "center",
    padding: "0 var(--sp-4)",
    height: ROW_HEIGHT,
    borderTop: "1px solid var(--border-soft)",
  };

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* sticky shared-track header with per-column resize handles */}
      <div
        role="row"
        style={{
          ...rowStyle,
          height: "auto",
          padding: "var(--sp-2) var(--sp-4)",
          borderTop: "none",
          borderBottom: "1px solid var(--border-soft)",
          background: "var(--canvas)",
          fontSize: "var(--text-micro)",
          fontWeight: "var(--fw-strong)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--faint)",
        }}
      >
        {config.columns.map((c) => (
          <span key={c.key} role="columnheader" style={{ position: "relative", minWidth: 0, textAlign: c.align === "end" ? "right" : "left" }}>
            {c.header}
            <span
              onMouseDown={startDrag(c.key, c.minWidth ?? 48)}
              onDoubleClick={resetCol(c.key)}
              title={ko.console.module.list.columnResize}
              aria-hidden="true"
              style={{ position: "absolute", right: -9, top: -6, bottom: -6, width: 9, cursor: "col-resize", zIndex: 3, borderRadius: 3 }}
            />
          </span>
        ))}
        <span />
      </div>

      {/* scroll region — J/K/Enter grammar, overscroll-contained, bottom fade */}
      <div
        role="grid"
        tabIndex={0}
        aria-label={`${config.title} ${ko.console.module.list.label}`}
        data-fidelity="module-list"
        onKeyDown={onKeyNav}
        style={{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain", outline: "none" }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: "var(--sp-5) var(--sp-4)", color: "var(--steel)", fontSize: "var(--text-sm)" }}>
            {ko.console.module.list.empty}
          </div>
        ) : (
          rows.map((row) => {
            const id = config.rowId(row);
            const selected = id === selectedId;
            return (
              <div
                key={id}
                role="row"
                aria-selected={selected}
                data-row-id={id}
                onClick={() => { onSelect(id); onOpen(id); }}
                style={{
                  ...rowStyle,
                  cursor: "pointer",
                  background: selected ? "var(--muted)" : "transparent",
                }}
              >
                {config.columns.map((c) => (
                  <span key={c.key} role="gridcell" style={{ minWidth: 0, textAlign: c.align === "end" ? "right" : "left", display: "flex", justifyContent: c.align === "end" ? "flex-end" : "flex-start" }}>
                    <Cell cell={c.cell(row)} />
                  </span>
                ))}
                <span />
              </div>
            );
          })
        )}
        {/* end-of-list padding so the fade never clips the last row */}
        <div style={{ height: "var(--sp-5)" }} />
      </div>
      {/* bottom fade (inline — no pseudo-elements available) */}
      <div aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 24, pointerEvents: "none", background: "linear-gradient(to top, var(--canvas), transparent)" }} />
    </div>
  );
}

/* ──────────────────────────────── kanban ──────────────────────────────── */

interface KanbanProps<Row> {
  config: ModuleConfig<Row>;
  lanes: ModuleLane[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onKeyNav: (e: KeyboardEvent<HTMLDivElement>) => void;
}

function Kanban<Row>({ config, lanes, selectedId, onSelect, onOpen, onKeyNav }: KanbanProps<Row>) {
  return (
    <div
      role="grid"
      tabIndex={0}
      aria-label={`${config.title} ${ko.console.module.board.label}`}
      data-fidelity="module-lanes"
      onKeyDown={onKeyNav}
      style={{ flex: 1, minHeight: 0, display: "flex", gap: "var(--sp-3)", padding: "var(--sp-4)", overflow: "auto", overscrollBehavior: "contain", outline: "none" }}
    >
      {lanes.map((lane) => {
        const t = TONE(lane.tone ?? "neutral");
        return (
          <div key={lane.id} role="row" style={{ flex: "0 0 15rem", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", padding: "var(--sp-1) var(--sp-2)", marginBottom: "var(--sp-2)", borderBottom: `2px solid ${t.tx}` }}>
              <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--fw-strong)" }}>{lane.label}</span>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--steel)" }}>{lane.cards.length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", overflow: "auto", minHeight: 0 }}>
              {lane.cards.map((card) => {
                const selected = card.id === selectedId;
                return (
                  <div
                    key={card.id}
                    role="gridcell"
                    aria-selected={selected}
                    data-row-id={card.id}
                    onClick={() => { onSelect(card.id); onOpen(card.id); }}
                    style={{
                      cursor: "pointer",
                      borderRadius: "var(--radius-card)",
                      border: `1px solid ${selected ? "var(--signal)" : "var(--border-soft)"}`,
                      background: "var(--surface)",
                      padding: "var(--sp-2)",
                    }}
                  >
                    <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--fw-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.title}</div>
                    {card.sub ? <div style={{ fontSize: "var(--text-xs)", color: "var(--steel)", marginTop: 2 }}>{card.sub}</div> : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────── detail panel ─────────────────────────── */

interface DetailPanelProps<Row> {
  config: ModuleConfig<Row>;
  row: Row;
  api?: ConsoleApiClient;
  onClose: () => void;
  onOpenObject?: (code: string) => void;
  onToast?: (message: string) => void;
}

function DetailPanel<Row>({ config, row, api, onClose, onOpenObject, onToast }: DetailPanelProps<Row>) {
  const [busy, setBusy] = useState<string | null>(null);
  const kv = config.detail.kv(row);
  const links = config.detail.links(row);
  const actions = config.detail.actions(row);

  const runAction = (action: ModuleAction<Row>) => {
    if (!api || busy) return;
    setBusy(action.key);
    void (async () => {
      try {
        const message = await action.run(row, api);
        onToast?.(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message.trim() : "";
        onToast?.(detail ? `${ko.console.module.action.failed}: ${detail}` : ko.console.module.action.failed);
      } finally {
        setBusy(null);
      }
    })();
  };

  return (
    <aside
      data-fidelity="module-detail"
      aria-label={config.rowTitle(row)}
      style={{ flex: "0 0 22rem", display: "flex", flexDirection: "column", minHeight: 0, borderLeft: "1px solid var(--border-soft)", background: "var(--surface)" }}
    >
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-2)", padding: "var(--sp-3) var(--sp-4)", borderBottom: "1px solid var(--border-soft)" }}>
        <h3 style={{ margin: 0, fontSize: "var(--text-card-title)", fontWeight: "var(--fw-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {config.rowTitle(row)}
        </h3>
        <button type="button" onClick={onClose} aria-label={ko.console.module.detail.close} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--steel)", fontSize: "var(--text-body)" }}>
          ×
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--sp-2) var(--sp-3)" }}>
          {kv.map((entry) => (
            <div key={entry.key} style={{ display: "contents" }}>
              <dt style={{ fontSize: "var(--text-xs)", color: "var(--faint)", whiteSpace: "nowrap" }}>{entry.label}</dt>
              <dd style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--ink)" }}>{entry.value}</dd>
            </div>
          ))}
        </dl>

        {links.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
            <span style={{ fontSize: "var(--text-micro)", fontWeight: "var(--fw-strong)", letterSpacing: "var(--tracking-label)", textTransform: "uppercase", color: "var(--faint)" }}>
              {ko.console.module.detail.links}
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
              {links.map((link) => (
                <LinkChip key={link.code} link={link} onOpen={onOpenObject} />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {actions.length > 0 ? (
        <footer style={{ display: "flex", gap: "var(--sp-2)", padding: "var(--sp-3) var(--sp-4)", borderTop: "1px solid var(--border-soft)" }}>
          {actions.map((action) => (
            <PolicyGated key={action.key} action={action.policy}>
              <button
                type="button"
                onClick={() => { runAction(action); }}
                disabled={busy !== null}
                style={{ ...primaryBtnStyle, ...(action.tone ? { background: TONE(action.tone).tx, borderColor: TONE(action.tone).tx } : {}), opacity: busy !== null ? 0.6 : 1 }}
              >
                {action.label}
              </button>
            </PolicyGated>
          ))}
        </footer>
      ) : null}
    </aside>
  );
}

/* ──────────────────────────────── screen ──────────────────────────────── */

/**
 * The single generic module screen. Every module is this component + a
 * ModuleConfig; there is no per-module fork (DESIGN §4-18). Body is a table by
 * default, a kanban when `config.field.kind === "lanes"`; a `prog` field adds a
 * completion bar. `stock`/`tl`/`ctl` are declared in the config contract but
 * throw a dev-loud error until their slice ships (no silent stubs).
 */
export function ModuleScreen<Row>({ config, rows, loadState, api, onRetry, onOpenObject, onToast, initialOpenId, onPrimaryAction }: ModuleScreenProps<Row>) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialOpenId ?? null);
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);

  const field = config.field;
  if (field && !IMPLEMENTED_FIELDS.has(field.kind)) {
    // Dev-loud: the config contract allows this field kind, but its renderer is
    // not built yet. Fail visibly rather than shipping a silent stub.
    throw new Error(
      `ModuleScreen: field "${field.kind}" is declared in the config contract but not yet implemented (module "${config.key}"). Implemented: ${[...IMPLEMENTED_FIELDS].join(", ")}.`,
    );
  }

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (needle ? rows.filter((row) => config.search(row).includes(needle)) : rows),
    [rows, needle, config],
  );

  const lanes = useMemo(() => (field?.kind === "lanes" ? field.lanes(filtered) : null), [field, filtered]);

  // Flattened nav order — table order, or lane-by-lane for a kanban body.
  const navIds = useMemo(() => {
    if (lanes) {
      return lanes.flatMap((lane) => lane.cards.map((c) => c.id));
    }
    return filtered.map((row) => config.rowId(row));
  }, [lanes, filtered, config]);

  // A stale selection/open id (row filtered out by search) is harmless: the
  // keynav index lookup returns -1 and restarts, and a missing openId resolves
  // to `undefined` below — so no state cleanup effect is needed.
  const rowById = useMemo(() => {
    const m = new Map<string, Row>();
    for (const row of rows) m.set(config.rowId(row), row);
    return m;
  }, [rows, config]);

  const onKeyNav = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const key = e.key;
      if (key === "j" || key === "J" || key === "k" || key === "K") {
        if (navIds.length === 0) return;
        const cur = selectedId ? navIds.indexOf(selectedId) : -1;
        const next = key === "j" || key === "J" ? Math.min(cur + 1, navIds.length - 1) : Math.max(cur - 1, 0);
        setSelectedId(navIds[cur === -1 ? 0 : next]);
        e.preventDefault();
      } else if (key === "Enter") {
        if (selectedId) {
          setOpenId(selectedId);
          e.preventDefault();
        }
      }
    },
    [navIds, selectedId],
  );

  const openRow = openId ? rowById.get(openId) : undefined;
  const progress = field?.kind === "prog" ? field.progress(filtered) : null;
  const primaryActionKey = config.primaryAction?.key ?? "";

  return (
    <div className="console" data-console-root data-module={config.key} style={screenStyle}>
      <header style={headerStyle}>
        <h2 style={titleStyle}>{config.title}</h2>
        <div style={{ flex: 1 }} />
        <input
          type="search"
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          aria-label={ko.console.search.label}
          placeholder={ko.console.search.placeholder}
          style={searchStyle}
        />
        {config.primaryAction && onPrimaryAction ? (
          <PolicyGated action={config.primaryAction.policy}>
            <button
              type="button"
              style={primaryBtnStyle}
              data-testid="module-primary-action"
              onClick={() => { onPrimaryAction(primaryActionKey); }}
            >
              {config.primaryAction.label}
            </button>
          </PolicyGated>
        ) : null}
      </header>

      <StatBar config={config} rows={filtered} />
      {progress ? <ProgBar done={progress.done} total={progress.total} /> : null}

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {loadState === "loading" ? (
          <div style={{ padding: "var(--sp-5) var(--sp-4)", color: "var(--steel)", fontSize: "var(--text-sm)" }}>{ko.console.module.list.loading}</div>
        ) : loadState === "error" ? (
          <div style={{ padding: "var(--sp-5) var(--sp-4)", display: "flex", gap: "var(--sp-3)", alignItems: "center", color: "var(--danger-tx)", fontSize: "var(--text-sm)" }}>
            {ko.console.module.list.error}
            {onRetry ? (
              <button type="button" onClick={onRetry} style={{ ...primaryBtnStyle, background: "transparent", color: "var(--signal)", borderColor: "var(--signal)" }}>
                {ko.console.module.list.retry}
              </button>
            ) : null}
          </div>
        ) : lanes ? (
          <Kanban key={config.key} config={config} lanes={lanes} selectedId={selectedId} onSelect={setSelectedId} onOpen={setOpenId} onKeyNav={onKeyNav} />
        ) : (
          <ListTable key={config.key} config={config} rows={filtered} selectedId={selectedId} onSelect={setSelectedId} onOpen={setOpenId} onKeyNav={onKeyNav} />
        )}

        {openRow ? (
          <DetailPanel
            key={`${config.key}:${config.rowId(openRow)}`}
            config={config}
            row={openRow}
            api={api}
            onClose={() => { setOpenId(null); }}
            onOpenObject={onOpenObject}
            onToast={onToast}
          />
        ) : null}
      </div>
    </div>
  );
}
