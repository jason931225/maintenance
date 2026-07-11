// 문서·기록물 screen (nav "docs") — composition only.
//
// The only backend-real document domain today is 증거 (console/evidence/*,
// GET /api/v1/evidence/objects — real-wired, custody fabrication already
// removed upstream). 결재/공지/업무일지/계약/접수 have no list API anywhere in
// the generated client yet: rather than fabricate rows for them (§4-25-⑥),
// their tabs render the real 유형 filter chip plus a blocked-until-backend
// chip and an empty table — an honest, extensible shell a future backend lane
// wires real data into without any UI rework.
//
// 보존 (retention) is real: GET /api/v1/lifecycles/evidence_object/{id}
// (console/lifecycle's useLifecycle hook, called here per-row since a table
// needs N rows, not the single-object shape the hook offers) → retentionUntil.
// A 404 (no lifecycle row yet) or a denied/failed call renders "—", never a
// fabricated duration.
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useAuth } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { StatusChip } from "../../components";
import { listEvidenceObjects, type EvidenceObjectDetail } from "../../evidence";
import { documentsKoManifest as T } from "./koManifest";

type TypeTab = "ALL" | "APPROVAL" | "NOTICE" | "WORKLOG" | "CONTRACT" | "INTAKE" | "EVIDENCE";

// Only EVIDENCE has a real backing list today (see file header).
const BACKED_TABS = new Set<TypeTab>(["ALL", "EVIDENCE"]);
const TAB_ORDER: TypeTab[] = ["ALL", "APPROVAL", "NOTICE", "WORKLOG", "CONTRACT", "INTAKE", "EVIDENCE"];

type StatFilter = "ALL" | "THIS_MONTH" | "EXPIRING";
const EXPIRING_WINDOW_DAYS = 90;

type ListState = "loading" | "ready" | "error";
type RetentionEntry = { retentionUntil: string | null };

const rootStyle: CSSProperties = { display: "grid", gap: "var(--sp-4)", color: "var(--ink)", fontFamily: "var(--font-sans)" };
const headerStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-3)", flexWrap: "wrap" };
const titleStyle: CSSProperties = { margin: 0, fontSize: "var(--text-h1)", fontWeight: "var(--fw-strong)" };
const barStyle: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--sp-2)" };
const statButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};
const statButtonActiveStyle: CSSProperties = { ...statButtonStyle, border: "1px solid var(--accent-bd)", background: "var(--accent-bg)" };
const tabButtonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-pill)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};
const tabButtonActiveStyle: CSSProperties = { ...tabButtonStyle, border: "1px solid var(--signal)", background: "var(--signal)" };
const tableWrapStyle: CSSProperties = { overflowX: "auto", border: "1px solid var(--border-soft)", borderRadius: "var(--radius)" };
const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse" };
const thStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  textAlign: "left",
  whiteSpace: "nowrap",
};
const tdStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
};
const errorPaneStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-4)",
  border: "1px solid var(--danger-bd)",
  borderRadius: "var(--radius-card)",
  background: "var(--danger-bg)",
  color: "var(--danger-tx)",
};
const retryButtonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const dateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short" });

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function inCurrentMonth(iso: string): boolean {
  return iso.slice(0, 7) === new Date().toISOString().slice(0, 7);
}

function isExpiringSoon(retentionUntil: string): boolean {
  const until = new Date(retentionUntil).getTime();
  if (Number.isNaN(until)) return false;
  const now = Date.now();
  const windowMs = EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return until >= now && until - now <= windowMs;
}

export function EvidenceScreenBody() {
  const { api } = useAuth();
  const [rows, setRows] = useState<EvidenceObjectDetail[]>([]);
  const [listState, setListState] = useState<ListState>("loading");
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [retention, setRetention] = useState<Map<string, RetentionEntry>>(new Map());
  const [tab, setTab] = useState<TypeTab>("ALL");
  const [statFilter, setStatFilter] = useState<StatFilter>("ALL");

  useEffect(() => {
    let active = true;
    async function load() {
      setListState("loading");
      try {
        const items = await listEvidenceObjects(api);
        if (!active) return;
        setRows(items);
        setListState("ready");
      } catch {
        if (active) setListState("error");
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    void api
      .GET("/api/v1/users")
      .then((res) => {
        if (!res.data) return;
        setUsers(new Map(res.data.items.map((u) => [u.id, u.display_name])));
      })
      .catch(() => undefined);
  }, [api]);

  // Best-effort, per-row retention lookup — a missing/denied/errored lifecycle
  // read degrades to "no retention on record" (§ file header), never fabricated.
  useEffect(() => {
    let active = true;
    void Promise.all(
      rows.map(async (row) => {
        try {
          const { data, response } = await api.GET("/api/v1/lifecycles/{objectType}/{objectId}", {
            params: { path: { objectType: "evidence_object", objectId: row.id } },
          });
          if (data) return [row.id, { retentionUntil: data.retentionUntil ?? null }] as const;
          if (response.status === 404) return [row.id, { retentionUntil: null }] as const;
          return undefined;
        } catch {
          return undefined;
        }
      }),
    ).then((entries) => {
      if (!active) return;
      const next = new Map<string, RetentionEntry>();
      for (const entry of entries) {
        if (entry) next.set(entry[0], entry[1]);
      }
      setRetention(next);
    });
    return () => {
      active = false;
    };
  }, [api, rows]);

  const resolveOwner = (id: string): string => users.get(id) ?? id;

  const stats = useMemo(() => {
    const registeredThisMonth = rows.filter((row) => inCurrentMonth(row.registeredAt)).length;
    const expiring = rows.filter((row) => {
      const entry = retention.get(row.id);
      return entry?.retentionUntil != null && isExpiringSoon(entry.retentionUntil);
    }).length;
    return { total: rows.length, registeredThisMonth, expiring };
  }, [rows, retention]);

  const visibleRows = useMemo(() => {
    if (!BACKED_TABS.has(tab)) return [];
    let visible = rows;
    if (statFilter === "THIS_MONTH") visible = visible.filter((row) => inCurrentMonth(row.registeredAt));
    if (statFilter === "EXPIRING") {
      visible = visible.filter((row) => {
        const entry = retention.get(row.id);
        return entry?.retentionUntil != null && isExpiringSoon(entry.retentionUntil);
      });
    }
    return visible;
  }, [rows, tab, statFilter, retention]);

  function toggleStat(next: StatFilter) {
    setStatFilter((current) => (current === next ? "ALL" : next));
  }

  return (
    <section className="console" aria-label={T.title} style={rootStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{T.title}</h1>
      </header>

      <div role="group" aria-label={T.title} style={barStyle}>
        <button
          type="button"
          aria-pressed={statFilter === "ALL"}
          style={statFilter === "ALL" ? statButtonActiveStyle : statButtonStyle}
          onClick={() => {
            setStatFilter("ALL");
          }}
        >
          <span>{T.stats.total}</span>
          <StatusChip tone="neutral">{stats.total}</StatusChip>
        </button>
        <button
          type="button"
          aria-pressed={statFilter === "THIS_MONTH"}
          style={statFilter === "THIS_MONTH" ? statButtonActiveStyle : statButtonStyle}
          onClick={() => {
            toggleStat("THIS_MONTH");
          }}
        >
          <span>{T.stats.registeredThisMonth}</span>
          <StatusChip tone="info">{stats.registeredThisMonth}</StatusChip>
        </button>
        <button
          type="button"
          aria-pressed={statFilter === "EXPIRING"}
          style={statFilter === "EXPIRING" ? statButtonActiveStyle : statButtonStyle}
          onClick={() => {
            toggleStat("EXPIRING");
          }}
        >
          <span>{T.stats.retentionExpiring}</span>
          <StatusChip tone={stats.expiring > 0 ? "warn" : "neutral"}>{stats.expiring}</StatusChip>
        </button>
      </div>

      <div role="tablist" aria-label={T.columns.type} style={barStyle}>
        {TAB_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            style={tab === key ? tabButtonActiveStyle : tabButtonStyle}
            onClick={() => {
              setTab(key);
            }}
          >
            {T.types[key]}
          </button>
        ))}
      </div>

      {listState === "loading" && rows.length === 0 ? (
        <StatusChip role="status" tone="info">{T.loading}</StatusChip>
      ) : listState === "error" ? (
        <div role="alert" style={errorPaneStyle}>
          <p>{T.loadFailed}</p>
          <button
            type="button"
            style={retryButtonStyle}
            onClick={() => {
              setListState("loading");
              void listEvidenceObjects(api)
                .then((items) => {
                  setRows(items);
                  setListState("ready");
                })
                .catch(() => {
                  setListState("error");
                });
            }}
          >
            {T.retry}
          </button>
        </div>
      ) : !BACKED_TABS.has(tab) ? (
        <StatusChip tone="warn">{T.blockedType}</StatusChip>
      ) : visibleRows.length === 0 ? (
        <StatusChip tone="neutral">{T.empty}</StatusChip>
      ) : (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>{T.columns.code}</th>
                <th scope="col" style={thStyle}>{T.columns.title}</th>
                <th scope="col" style={thStyle}>{T.columns.type}</th>
                <th scope="col" style={thStyle}>{T.columns.owner}</th>
                <th scope="col" style={thStyle}>{T.columns.registeredAt}</th>
                <th scope="col" style={thStyle}>{T.columns.retention}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const entry = retention.get(row.id);
                const retentionText = !entry
                  ? T.retention.pending
                  : entry.retentionUntil
                    ? formatDate(entry.retentionUntil)
                    : T.retention.unset;
                return (
                  <tr key={row.id} data-row-id={row.id}>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{row.code}</td>
                    <td style={tdStyle}>{row.title}</td>
                    <td style={tdStyle}>
                      <StatusChip tone="purple">{ko.console.evidence.title}</StatusChip>
                    </td>
                    <td style={tdStyle}>{resolveOwner(row.custodian)}</td>
                    <td style={tdStyle}>{formatDate(row.registeredAt)}</td>
                    <td style={tdStyle}>{retentionText}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
