import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router-dom";

import { resolveRowTitle } from "../../../lib/rowTitle";
import { ko } from "../../../i18n/ko";
import { StatusChip } from "../../components";
import "../../tokens.css";
import { createOverviewApi, type OverviewApi } from "./overviewApi";
import { overviewStrings } from "./strings";
import { screenHeaderStyle, screenTitleStyle } from "../screenHeader";
import {
  actionLabel,
  filterQueue,
  kindLabel,
  kindRoute,
  overviewStats,
  queueChips,
  timelineEntries,
  type ActionInboxItem,
  type ActionInboxResponse,
  type QueueFilter,
} from "./overviewModel";

interface OverviewData {
  inbox: ActionInboxResponse;
}

type LoadState = "loading" | "ready" | "error";

export interface OverviewBodyProps {
  /** Bearer for the default api; ignored when `api` is supplied (tests). */
  accessToken?: string;
  api?: OverviewApi;
  now?: Date;
  /** Row/timeline drill; defaults to routing to the item's source screen. */
  onOpen?: (item: ActionInboxItem) => void;
}

export function OverviewBody({ accessToken, api, now, onOpen }: OverviewBodyProps) {
  const S = overviewStrings();
  const navigate = useNavigate();
  const client = useMemo(
    () => api ?? createOverviewApi(accessToken),
    [api, accessToken],
  );
  const today = useMemo(() => now ?? new Date(), [now]);

  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<OverviewData | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    client
      .loadInbox()
      .then((inbox) => {
        if (!live) return;
        setData({ inbox });
        setState("ready");
      })
      .catch(() => {
        if (!live) return;
        setState("error");
      });
    return () => {
      live = false;
    };
  }, [client, reloadKey]);

  const openItem = useCallback(
    (item: ActionInboxItem) => {
      if (onOpen) {
        onOpen(item);
        return;
      }
      void navigate(kindRoute(item.kind));
    },
    [onOpen, navigate],
  );

  const dateLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
      }).format(today),
    [today],
  );
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }),
    [],
  );
  const dowFmt = useMemo(
    () => new Intl.DateTimeFormat("ko-KR", { weekday: "narrow" }),
    [],
  );
  // The Mon–Sun week that contains `today`, giving the agenda a temporal ribbon
  // (real dates only — no per-day counts are fabricated).
  const weekDays = useMemo(() => {
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }, [today]);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (state === "error") {
    return (
      <div className="console" style={rootStyle}>
        <section style={panelStyle} role="alert">
          <p style={{ margin: 0, color: "var(--steel)" }}>{S.error}</p>
          <button
            type="button"
            data-window-control="true"
            style={buttonStyle}
            onClick={() => {
              setState("loading");
              setReloadKey((k) => k + 1);
            }}
          >
            {S.retry}
          </button>
        </section>
      </div>
    );
  }

  if (state === "loading" || !data) {
    return (
      <div className="console" style={rootStyle}>
        <header style={headerStyle}>
          <h1 style={titleStyle}>{S.title}</h1>
          <StatusChip role="status">{S.loading}</StatusChip>
        </header>
      </div>
    );
  }

  const items = data.inbox.items;
  const stats = overviewStats(items, S);
  const chips = queueChips(items, S);
  const rows = filterQueue(items, filter);
  const timeline = timelineEntries(items, today, timeFmt);

  return (
    <div className="console" style={rootStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{S.title}</h1>
        <span style={{ color: "var(--faint)", fontSize: "var(--text-sm)" }}>{dateLabel}</span>
      </header>

      {/* stat strip — every stat drills into the queue below (§4-11) */}
      <div style={stripStyle} role="group" aria-label={S.queueTitle}>
        {stats.map((stat) => {
          const active = filter === stat.filter;
          return (
            <button
              key={stat.key}
              type="button"
              data-window-control="true"
              aria-pressed={active}
              aria-label={ko.console.charts.drill(stat.label, String(stat.value))}
              style={statStyle(active)}
              onClick={() => {
                setFilter(stat.filter);
              }}
            >
              <span style={statLabelStyle}>{stat.label}</span>
              <span style={statValueStyle}>{stat.value}</span>
              {stat.sub ? (
                <StatusChip tone={stat.sub.tone}>{stat.sub.text}</StatusChip>
              ) : null}
            </button>
          );
        })}
      </div>

      <div style={gridStyle}>
        {/* 처리 대기 — work queue */}
        <section style={panelStyle} aria-label={S.queueTitle}>
          <div style={panelHeadStyle}>
            <h2 style={panelTitleStyle}>{S.queueTitle}</h2>
            <span style={countBadgeStyle}>{rows.length}</span>
          </div>
          <div style={chipRowStyle} role="group" aria-label={S.queueTitle}>
            {chips.map((chip) => {
              const active = filter === chip.filter;
              return (
                <button
                  key={chip.filter}
                  type="button"
                  data-window-control="true"
                  aria-pressed={active}
                  style={filterChipStyle(active)}
                  onClick={() => {
                    setFilter(chip.filter);
                  }}
                >
                  {chip.label} {chip.count}
                </button>
              );
            })}
          </div>
          {rows.length === 0 ? (
            <p style={emptyStyle}>{S.empty.queue}</p>
          ) : (
            <ul style={listStyle}>
              {rows.map((item) => {
                // §4-18: dispatch/work rows carry only a request_no as `title`
                // (see action_inbox.rs) — the shared resolver leads with a human
                // subject and demotes the code to the meta line, so a raw object
                // id never sits in the primary title slot. The most specific
                // human descriptor a code-only row has is its site (equipment
                // location); it beats a bare kind word (which would only echo the
                // type chip). Fall back to the kind label when there is no site.
                const resolved = resolveRowTitle(
                  item.title,
                  item.ref,
                  item.site ?? kindLabel(item.kind, S),
                );
                const siteInTitle = resolved.title === item.site;
                const meta = [
                  resolved.code,
                  siteInTitle ? undefined : item.site,
                  item.who,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                <li key={item.id} style={rowStyle}>
                  <StatusChip tone={item.done ? "ok" : "neutral"}>
                    {kindLabel(item.kind, S)}
                  </StatusChip>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={rowTitleStyle}>{resolved.title}</div>
                    {meta ? <div style={rowMetaStyle}>{meta}</div> : null}
                  </div>
                  {item.due ? (
                    <StatusChip tone={item.dueTone}>{timeFmt.format(new Date(item.due))}</StatusChip>
                  ) : null}
                  <button
                    type="button"
                    data-window-control="true"
                    style={buttonStyle}
                    onClick={() => {
                      openItem(item);
                    }}
                  >
                    {actionLabel(item.kind, S)}
                  </button>
                </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 오늘 — agenda for items due today: a week ribbon + per-item rows with a
            done marker, time, title and the responsible person (all real fields). */}
        <section style={panelStyle} aria-label={S.timelineTitle}>
          <div style={panelHeadStyle}>
            <h2 style={panelTitleStyle}>{S.timelineTitle}</h2>
            <span style={countBadgeStyle}>{timeline.length}</span>
          </div>
          <div style={weekStripStyle} aria-hidden="true">
            {weekDays.map((day) => {
              const active = sameDay(day, today);
              return (
                <span key={day.toISOString()} style={weekCellStyle(active)}>
                  <span style={weekDowStyle}>{dowFmt.format(day)}</span>
                  <span style={weekNumStyle(active)}>{day.getDate()}</span>
                </span>
              );
            })}
          </div>
          {timeline.length === 0 ? (
            <p style={emptyStyle}>{S.empty.timeline}</p>
          ) : (
            <ol style={{ ...listStyle, listStyle: "none" }}>
              {timeline.map(({ item, time }) => (
                <li key={item.id} style={timelineRowStyle}>
                  <span aria-hidden="true" style={checkboxStyle(item.done)}>
                    {item.done ? "✓" : ""}
                  </span>
                  <span style={timelineTimeStyle}>{time}</span>
                  <button
                    type="button"
                    data-window-control="true"
                    style={timelineTitleBtnStyle}
                    onClick={() => {
                      openItem(item);
                    }}
                  >
                    {resolveRowTitle(item.title, item.ref, item.site ?? kindLabel(item.kind, S)).title}
                  </button>
                  {item.who ? (
                    <StatusChip tone="neutral">{item.who}</StatusChip>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

// ── styles (console tokens only) ─────────────────────────────────────────────

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  fontFamily: "var(--font-sans)",
  color: "var(--ink)",
  minHeight: 0,
  overflow: "auto",
};

const headerStyle = screenHeaderStyle;

// §4-18: was a locally hand-rolled titleStyle carrying a nonexistent
// `var(--text-h)` token (typo for --text-h1) — now the shared grammar.
const titleStyle = screenTitleStyle;

const stripStyle: CSSProperties = {
  display: "flex",
  overflowX: "auto",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

function statStyle(active: boolean): CSSProperties {
  return {
    display: "grid",
    alignContent: "center",
    gap: "var(--sp-1)",
    // Grow to share the strip evenly so a 4-stat row fills the width instead of
    // leaving a phantom empty tile at the end (verdict R9).
    flex: "1 1 10rem",
    minWidth: "10rem",
    padding: "var(--sp-4) var(--sp-5)",
    borderRight: "1px solid var(--border-soft)",
    borderBottom: active ? "2px solid var(--ink)" : "2px solid transparent",
    background: active ? "var(--muted)" : "transparent",
    textAlign: "left",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const statLabelStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--faint)",
  letterSpacing: "var(--tracking-label)",
};

const statValueStyle: CSSProperties = {
  fontSize: "var(--text-value-lg)",
  fontWeight: "var(--fw-strong)",
  fontVariantNumeric: "tabular-nums",
  color: "var(--ink)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
  alignItems: "start",
};

const panelStyle: CSSProperties = {
  display: "grid",
  alignContent: "start",
  gap: "var(--sp-3)",
  padding: "var(--sp-card-y) var(--sp-6)",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  minWidth: 0,
};

const panelHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const countBadgeStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  color: "var(--faint)",
  fontVariantNumeric: "tabular-nums",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

function filterChipStyle(active: boolean): CSSProperties {
  return {
    minHeight: 30,
    padding: "0 var(--sp-3)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-chip)",
    background: active ? "var(--ink)" : "var(--surface)",
    color: active ? "var(--surface)" : "var(--steel)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--fw-medium)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-3)",
  padding: "var(--sp-3) 0",
  borderTop: "1px solid var(--border-soft)",
};

const rowTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--sp-2)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
  color: "var(--ink)",
  minWidth: 0,
};

const rowMetaStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--steel)",
};

const buttonStyle: CSSProperties = {
  flex: "none",
  minHeight: 32,
  padding: "0 var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
  cursor: "pointer",
};

const emptyStyle: CSSProperties = {
  margin: 0,
  padding: "var(--sp-4) 0",
  color: "var(--faint)",
  fontSize: "var(--text-sm)",
};

const timelineRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-3)",
  padding: "var(--sp-2) 0",
  borderTop: "1px solid var(--border-soft)",
};

const weekStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: "var(--sp-1)",
  paddingBottom: "var(--sp-2)",
};

function weekCellStyle(active: boolean): CSSProperties {
  return {
    display: "grid",
    justifyItems: "center",
    gap: 2,
    padding: "var(--sp-2) 0",
    borderRadius: "var(--radius-sm)",
    background: active ? "var(--muted)" : "transparent",
  };
}

const weekDowStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--faint)",
};

function weekNumStyle(active: boolean): CSSProperties {
  return {
    fontSize: "var(--text-sm)",
    fontVariantNumeric: "tabular-nums",
    fontWeight: active ? "var(--fw-strong)" : "var(--fw-body)",
    color: active ? "var(--ink)" : "var(--steel)",
  };
}

function checkboxStyle(done: boolean): CSSProperties {
  return {
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    borderRadius: 4,
    border: `1px solid ${done ? "var(--ok-tx)" : "var(--border)"}`,
    background: done ? "var(--ok-tx)" : "var(--surface)",
    color: "var(--surface)",
    fontSize: 11,
    lineHeight: 1,
  };
}

const timelineTimeStyle: CSSProperties = {
  flex: "none",
  width: "3.2rem",
  fontVariantNumeric: "tabular-nums",
  fontSize: "var(--text-sm)",
  color: "var(--steel)",
};

const timelineTitleBtnStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  textAlign: "left",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  cursor: "pointer",
  minWidth: 0,
};

