// The comms rail's expanded content — 메신저/메일/알림/공지, grouped from the same
// real sources the overview screen used to embed inline (round 4). Round 5
// hoists it to shell level so it is the SAME persistent panel on every screen
// (not just overview) per the design reference, with ConsoleShell owning the
// open/collapsed chrome around it (§ single landmark, unchanged from #459).
//
// Round 14 density lift: each row now carries a colored sender monogram, a bold
// two-line preview, a localized per-item category chip (알림), and a per-section
// unread badge; the 알림 header gains a 모두 읽음 action wired to the real
// read-all endpoint. The r13 localized chips (categoryLabel) and the rail error
// boundary (CommsRailFallback) are preserved.
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { formatKoreanTime } from "../../lib/datetime";
import { ko } from "../../i18n/ko";
import { categoryLabel } from "../../i18n/notificationCategories";
import { StatusChip } from "../components";
import {
  railAvatarTone,
  railGroups,
  railGroupUnread,
  railInitial,
  type MailThreadSummary,
  type RailAvatarTone,
  type RailGroup,
  type RailItem,
} from "../screens/overview/overviewModel";
import { overviewStrings, railCategoryStrings } from "../screens/overview/strings";
import {
  createCommsRailApi,
  type CommsRailApi,
} from "../screens/overview/overviewApi";
import type { NotificationSummary } from "../../api/types";

interface RailData {
  notifications: NotificationSummary[];
  mailThreads: MailThreadSummary[];
}

type LoadState = "loading" | "ready" | "error";

export interface CommsRailPanelProps {
  /** Bearer for the default api; ignored when `api` is supplied (tests). */
  accessToken?: string;
  api?: CommsRailApi;
}

export function CommsRailPanel({ accessToken, api }: CommsRailPanelProps) {
  const S = overviewStrings();
  const client = useMemo(() => api ?? createCommsRailApi(accessToken), [api, accessToken]);
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<RailData | null>(null);
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([client.loadNotifications(), client.loadMailThreads()])
      .then(([notifications, mailThreads]) => {
        if (!live) return;
        setData({ notifications, mailThreads });
        setState("ready");
      })
      .catch(() => {
        if (!live) return;
        setState("error");
      });
    return () => {
      live = false;
    };
  }, [client]);

  // 모두 읽음: server read-all clears every notification-sourced group
  // (메신저/알림/공지). Optimistic — flip the local rows and drop the category
  // chips so the badges clear instantly; a failed call reconciles on the next
  // load rather than blocking the UI. Mail is a separate source, untouched.
  async function handleMarkAllRead() {
    if (!data || marking) return;
    setMarking(true);
    try {
      await client.markAllNotificationsRead();
      setData((prev) =>
        prev
          ? {
              ...prev,
              notifications: prev.notifications.map((n) =>
                n.unread ? { ...n, unread: false, read_at: n.read_at ?? new Date().toISOString() } : n,
              ),
            }
          : prev,
      );
    } catch {
      // best-effort; next poll/load restores the true state
    } finally {
      setMarking(false);
    }
  }

  if (state === "error") {
    return <p style={emptyStyle}>{S.error}</p>;
  }
  if (state === "loading" || !data) {
    return <p style={emptyStyle}>{S.loading}</p>;
  }

  const groups = railGroups(data.notifications, data.mailThreads, railCategoryStrings());

  return (
    <div style={rootStyle}>
      {groups.map((group) => (
        <RailSection
          key={group.key}
          group={group}
          emptyLabel={S.empty.rail}
          unreadLabel={S.rail.unread}
          onMarkAllRead={
            group.key === "notification"
              ? () => {
                  void handleMarkAllRead();
                }
              : undefined
          }
          marking={marking}
        />
      ))}
    </div>
  );
}

function RailSection({
  group,
  emptyLabel,
  unreadLabel,
  onMarkAllRead,
  marking,
}: {
  group: RailGroup;
  emptyLabel: string;
  unreadLabel: (n: number) => string;
  onMarkAllRead?: () => void;
  marking: boolean;
}) {
  const unread = railGroupUnread(group.items);
  return (
    <div style={railGroupStyle}>
      <div style={groupHeadStyle}>
        <h3 style={railGroupTitleStyle}>{group.title}</h3>
        {unread > 0 ? (
          <StatusChip tone="danger" ariaLabel={unreadLabel(unread)}>
            {unread}
          </StatusChip>
        ) : group.items.length > 0 ? (
          <span style={countBadgeStyle}>{group.items.length}</span>
        ) : null}
        {onMarkAllRead && unread > 0 ? (
          <button
            type="button"
            onClick={() => {
              onMarkAllRead();
            }}
            disabled={marking}
            className="cshell-hoverable cshell-focusable"
            style={markAllStyle}
          >
            {ko.shell.commsRail.markAllRead}
          </button>
        ) : null}
      </div>
      {group.items.length === 0 ? (
        <p style={emptyStyle}>{emptyLabel}</p>
      ) : (
        <ul style={listStyle}>
          {group.items.map((item) => (
            <RailRow key={item.id} item={item} showChip={group.key === "notification"} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RailRow({ item, showChip }: { item: RailItem; showChip: boolean }) {
  return (
    <li style={notifRowStyle} data-unread={item.unread || undefined}>
      <Avatar text={item.text} />
      <div style={rowBodyStyle}>
        <div style={notifHeadStyle}>
          {showChip ? (
            <StatusChip tone={item.unread ? "accent" : "neutral"}>
              {categoryLabel(item.category)}
            </StatusChip>
          ) : (
            <span />
          )}
          <span style={notifTimeStyle}>{formatKoreanTime(item.createdAt)}</span>
        </div>
        <div style={notifTextStyle}>{item.text}</div>
      </div>
      {item.unread ? (
        <span aria-label={ko.shell.commsRail.unread} style={unreadDotStyle} />
      ) : null}
    </li>
  );
}

const AVATAR_VARS: Record<RailAvatarTone, [string, string, string]> = {
  purple: ["var(--purple-bg)", "var(--purple-bd)", "var(--purple-tx)"],
  info: ["var(--info-bg)", "var(--info-bd)", "var(--info-tx)"],
  ok: ["var(--ok-bg)", "var(--ok-bd)", "var(--ok-tx)"],
  danger: ["var(--danger-bg)", "var(--danger-bd)", "var(--danger-tx)"],
  accent: ["var(--accent-bg)", "var(--accent-bd)", "var(--accent-tx)"],
};

function Avatar({ text }: { text: string }) {
  const [bg, bd, tx] = AVATAR_VARS[railAvatarTone(text)];
  return (
    <span
      aria-hidden="true"
      style={{
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        borderRadius: "var(--radius-pill)",
        background: bg,
        border: `1px solid ${bd}`,
        color: tx,
        fontSize: "var(--text-sm)",
        fontWeight: "var(--fw-strong)",
        lineHeight: 1,
      }}
    >
      {railInitial(text)}
    </span>
  );
}

/** Boundary fallback: a render crash in the rail degrades to the same quiet
 * "couldn't load" reason the fetch-error path shows, so a rail failure never
 * escapes to the route boundary and takes down the whole console shell. */
export function CommsRailFallback() {
  return <p style={emptyStyle}>{overviewStrings().error}</p>;
}

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-3) var(--sp-4)",
  overflow: "auto",
  minHeight: 0,
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const emptyStyle: CSSProperties = {
  margin: 0,
  padding: "var(--sp-2) var(--sp-4)",
  color: "var(--faint)",
  fontSize: "var(--text-sm)",
};

const railGroupStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  paddingTop: "var(--sp-2)",
  borderTop: "1px solid var(--border-soft)",
};

const groupHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const railGroupTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  color: "var(--steel)",
};

const countBadgeStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  color: "var(--faint)",
  fontVariantNumeric: "tabular-nums",
};

const markAllStyle: CSSProperties = {
  marginLeft: "auto",
  border: "none",
  background: "transparent",
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
  padding: "2px 6px",
  borderRadius: 6,
  cursor: "pointer",
};

const notifRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--sp-2)",
  padding: "var(--sp-2) 0",
  borderTop: "1px solid var(--border-soft)",
};

const rowBodyStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  display: "grid",
  gap: 2,
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
  fontWeight: "var(--fw-medium)",
  color: "var(--ink)",
  lineHeight: 1.4,
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const unreadDotStyle: CSSProperties = {
  flex: "none",
  marginTop: 5,
  width: 7,
  height: 7,
  borderRadius: "var(--radius-pill)",
  background: "var(--danger-solid)",
};
