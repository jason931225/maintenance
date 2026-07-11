import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router-dom";

import { ko } from "../../../i18n/ko";
import { StatusChip } from "../../components";
import "../../tokens.css";
import { createOverviewApi, type OverviewApi } from "./overviewApi";
import { overviewStrings, railCategoryStrings } from "./strings";
import { screenHeaderStyle, screenTitleStyle } from "../screenHeader";
import {
  actionLabel,
  filterQueue,
  kindLabel,
  kindRoute,
  overviewStats,
  queueChips,
  railCategories,
  railGroups,
  timelineEntries,
  type ActionInboxItem,
  type ActionInboxResponse,
  type MailThreadSummary,
  type NotificationCountsSummary,
  type QueueFilter,
} from "./overviewModel";
import type { NotificationSummary } from "../../../api/types";

interface OverviewData {
  inbox: ActionInboxResponse;
  counts: NotificationCountsSummary;
  notifications: NotificationSummary[];
  mailThreads: MailThreadSummary[];
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
    Promise.all([
      client.loadInbox(),
      client.loadNotificationCounts(),
      client.loadNotifications(),
      client.loadMailThreads(),
    ])
      .then(([inbox, counts, notifications, mailThreads]) => {
        if (!live) return;
        setData({ inbox, counts, notifications, mailThreads });
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
  const categories = railCategories(data.counts);
  const groups = railGroups(data.notifications, data.mailThreads, railCategoryStrings());

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
              {rows.map((item) => (
                <li key={item.id} style={rowStyle}>
                  <StatusChip tone={item.done ? "ok" : "neutral"}>
                    {kindLabel(item.kind, S)}
                  </StatusChip>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={rowTitleStyle}>
                      {item.title}
                      <span style={refStyle}>{item.ref}</span>
                    </div>
                    <div style={rowMetaStyle}>
                      {[item.site, item.who].filter(Boolean).join(" · ")}
                    </div>
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
              ))}
            </ul>
          )}
        </section>

        {/* 오늘 — timeline of items due today */}
        <section style={panelStyle} aria-label={S.timelineTitle}>
          <div style={panelHeadStyle}>
            <h2 style={panelTitleStyle}>{S.timelineTitle}</h2>
            <span style={countBadgeStyle}>{timeline.length}</span>
          </div>
          {timeline.length === 0 ? (
            <p style={emptyStyle}>{S.empty.timeline}</p>
          ) : (
            <ol style={{ ...listStyle, listStyle: "none" }}>
              {timeline.map(({ item, time }) => (
                <li key={item.id} style={timelineRowStyle}>
                  <span style={timelineTimeStyle}>{time}</span>
                  <button
                    type="button"
                    data-window-control="true"
                    style={timelineTitleBtnStyle}
                    onClick={() => {
                      openItem(item);
                    }}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* 커뮤니케이션 — comms rail, split into 메신저/메일/알림/공지 panels
            (verdict R3 density). Every panel renders open by default — there
            is no collapse control to default, so "default-expanded" is
            satisfied by construction rather than a toggle nobody asked for. */}
        <aside style={panelStyle} aria-label={S.railTitle}>
          <div style={panelHeadStyle}>
            <h2 style={panelTitleStyle}>{S.railTitle}</h2>
            <span style={countBadgeStyle}>{data.counts.total_unread}</span>
          </div>
          {categories.length > 0 ? (
            <div style={chipRowStyle}>
              {categories.map((c) => (
                <StatusChip key={c.category} tone="info">
                  {c.category} {c.unread}
                </StatusChip>
              ))}
            </div>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} style={railGroupStyle}>
              <div style={panelHeadStyle}>
                <h3 style={railGroupTitleStyle}>{group.title}</h3>
                <span style={countBadgeStyle}>{group.items.length}</span>
              </div>
              {group.items.length === 0 ? (
                <p style={emptyStyle}>{S.empty.rail}</p>
              ) : (
                <ul style={listStyle}>
                  {group.items.map((item) => (
                    <li key={item.id} style={notifRowStyle} data-unread={item.unread || undefined}>
                      <div style={notifHeadStyle}>
                        <StatusChip tone={item.unread ? "accent" : "neutral"}>{group.title}</StatusChip>
                        <span style={notifTimeStyle}>{timeFmt.format(new Date(item.createdAt))}</span>
                      </div>
                      <div style={notifTextStyle}>{item.text}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </aside>
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
  gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)",
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

const refStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--faint)",
  fontFamily: "var(--font-mono)",
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
  alignItems: "baseline",
  gap: "var(--sp-3)",
  padding: "var(--sp-2) 0",
  borderTop: "1px solid var(--border-soft)",
};

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

const railGroupStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  paddingTop: "var(--sp-2)",
  borderTop: "1px solid var(--border-soft)",
};

const railGroupTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  color: "var(--steel)",
};

const notifRowStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  padding: "var(--sp-2) 0",
  borderTop: "1px solid var(--border-soft)",
};

const notifHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const notifTimeStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--faint)",
  fontVariantNumeric: "tabular-nums",
};

const notifTextStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--steel)",
};
