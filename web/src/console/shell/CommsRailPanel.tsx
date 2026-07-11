// The comms rail's expanded content — 메신저/메일/알림/공지, grouped from the same
// real sources the overview screen used to embed inline (round 4). Round 5
// hoists it to shell level so it is the SAME persistent panel on every screen
// (not just overview) per the design reference, with ConsoleShell owning the
// open/collapsed chrome around it (§ single landmark, unchanged from #459).
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { formatKoreanTime } from "../../lib/datetime";
import { StatusChip } from "../components";
import {
  railCategories,
  railGroups,
  type NotificationCountsSummary,
  type MailThreadSummary,
} from "../screens/overview/overviewModel";
import { overviewStrings, railCategoryStrings } from "../screens/overview/strings";
import {
  createCommsRailApi,
  type CommsRailApi,
} from "../screens/overview/overviewApi";
import type { NotificationSummary } from "../../api/types";

interface RailData {
  counts: NotificationCountsSummary;
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

  useEffect(() => {
    let live = true;
    Promise.all([client.loadNotificationCounts(), client.loadNotifications(), client.loadMailThreads()])
      .then(([counts, notifications, mailThreads]) => {
        if (!live) return;
        setData({ counts, notifications, mailThreads });
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

  if (state === "error") {
    return <p style={emptyStyle}>{S.error}</p>;
  }
  if (state === "loading" || !data) {
    return <p style={emptyStyle}>{S.loading}</p>;
  }

  const categories = railCategories(data.counts);
  const groups = railGroups(data.notifications, data.mailThreads, railCategoryStrings());

  return (
    <div style={rootStyle}>
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
          <div style={groupHeadStyle}>
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
                    <span style={notifTimeStyle}>{formatKoreanTime(item.createdAt)}</span>
                  </div>
                  <div style={notifTextStyle}>{item.text}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
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

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
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
