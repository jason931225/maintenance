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
// A missing lifecycle row renders "—". A denied or failed lifecycle read is
// explicit and retryable; it is never mislabeled as an absent retention rule.
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import type { ConsoleApiClient } from "../../../api/client";

import { useAuth } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { StatusChip } from "../../components";
import {
  listEvidenceObjects,
  type EvidenceObjectDetail,
  type EvidenceSourceKind,
} from "../../evidence";

// 유형 chip color per source type — a distinct token per kind so 계약/증거/
// 업무일지/공지/접수-class records read apart at a glance (verdict r13), instead
// of one flat purple chip on every row. Colors carry no status meaning here;
// they are a categorical legend drawn from the shared chip palette.
type ChipTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "purple";
const SOURCE_TONE: Record<EvidenceSourceKind, ChipTone> = {
  work_order_evidence_media: "ok", // 작업 증빙 (증거)
  record_archive: "info", // 기록물 보관함 (계약·기록)
  inbox_doc: "accent", // 접수 문서
  mail_attachment: "purple", // 메일 첨부
  ingest_job: "warn", // 수집 작업
  external_document: "neutral", // 외부 문서
};
import { documentsKoManifest as T } from "./koManifest";
import { screenHeaderStyle, screenTitleStyle } from "../screenHeader";

// ko.console.documents.actions.{export, register, registerUnavailable} are
// now real (wired in ko.ts, serial wire round 4). English fallbacks below
// only guard a future ko.ts regression.
function actionStrings(): { export: string; register: string; registerUnavailable: string } {
  const documents = ko.console.documents as unknown as { actions?: Record<string, unknown> };
  const actions = documents.actions;
  const pick = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
  return {
    export: pick(actions?.export, "Export"),
    register: pick(actions?.register, "Register a record"),
    registerUnavailable: pick(
      actions?.registerUnavailable,
      "Record registration has no create endpoint yet.",
    ),
  };
}

// Real, honest export — a client-side CSV of the rows actually on screen
// (never a fabricated bulk export the backend doesn't offer). Native
// Blob/URL, no library (§ ponytail: native platform feature over a dep).
function toCsv(rows: EvidenceObjectDetail[], resolveOwner: (id: string) => string): string {
  const header = [T.columns.code, T.columns.title, T.columns.type, T.columns.owner, T.columns.registeredAt];
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = rows.map((row) =>
    [row.code, row.title, row.source?.title ?? ko.console.evidence.title, resolveOwner(row.custodian), row.registeredAt]
      .map((v) => escape(v))
      .join(","),
  );
  return [header.map(escape).join(","), ...lines].join("\r\n");
}

type TypeTab = "ALL" | "APPROVAL" | "NOTICE" | "WORKLOG" | "CONTRACT" | "INTAKE" | "EVIDENCE";

// Only EVIDENCE has a real backing list today (see file header).
const BACKED_TABS = new Set<TypeTab>(["ALL", "EVIDENCE"]);
const TAB_ORDER: TypeTab[] = ["ALL", "APPROVAL", "NOTICE", "WORKLOG", "CONTRACT", "INTAKE", "EVIDENCE"];

type StatFilter = "ALL" | "THIS_MONTH" | "EXPIRING";
const EXPIRING_WINDOW_DAYS = 90;

type ListState = "loading" | "ready" | "error";
type RetentionEntry =
  | { state: "ready"; retentionUntil: string | null }
  | { state: "unavailable"; retentionUntil: null };

/** Bounds per-row lifecycle reads when the real evidence register spans pages. */
export const RETENTION_READ_CONCURRENCY = 6;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Evidence retention read was aborted", "AbortError");
}

/**
 * Enriches every rendered record with an explicit lifecycle state. The endpoint
 * is per object, so use a fixed worker pool rather than unbounded Promise.all;
 * every non-abort failure becomes a visible unavailable state, never a silent
 * omitted map entry.
 */
export async function readEvidenceRetentions(
  api: ConsoleApiClient,
  rows: EvidenceObjectDetail[],
  signal: AbortSignal,
): Promise<Map<string, RetentionEntry>> {
  const entries = new Map<string, RetentionEntry>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      const row = rows[index];
      if (!row) return;
      try {
        const { data, response } = await api.GET("/api/v1/lifecycles/{objectType}/{objectId}", {
          params: { path: { objectType: "evidence_object", objectId: row.id } },
          signal,
        });
        throwIfAborted(signal);
        entries.set(row.id, data
          ? { state: "ready", retentionUntil: data.retentionUntil ?? null }
          : { state: response.status === 404 ? "ready" : "unavailable", retentionUntil: null });
      } catch {
        throwIfAborted(signal);
        entries.set(row.id, { state: "unavailable", retentionUntil: null });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(RETENTION_READ_CONCURRENCY, rows.length) }, worker));
  throwIfAborted(signal);
  return entries;
}

const rootStyle: CSSProperties = { display: "grid", gap: "var(--sp-4)", color: "var(--ink)", fontFamily: "var(--font-sans)" };
const headerStyle = screenHeaderStyle;
const titleStyle = screenTitleStyle;
const headerActionsStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" };
const actionButtonStyle: CSSProperties = {
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
const primaryActionButtonStyle: CSSProperties = {
  ...actionButtonStyle,
  border: "1px solid var(--signal)",
  background: "var(--signal)",
};
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
const searchInputStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  flex: "0 1 260px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-sm)",
};
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
// Aggregate footer row (verdict r13 "evidence lower region sparse") — a real
// rollup of the stat strip above, not filler: fills the table's bottom
// instead of leaving a blank card once the row count is short.
const tfootRowStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
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
  const A = actionStrings();
  const [rows, setRows] = useState<EvidenceObjectDetail[]>([]);
  const [listState, setListState] = useState<ListState>("loading");
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [retention, setRetention] = useState<Map<string, RetentionEntry>>(new Map());
  const [tab, setTab] = useState<TypeTab>("ALL");
  const [statFilter, setStatFilter] = useState<StatFilter>("ALL");
  const [search, setSearch] = useState("");
  const [registerNotice, setRegisterNotice] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);
  const [retentionAttempt, setRetentionAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setListState("loading");
    void listEvidenceObjects(api, 200, controller.signal)
      .then((items) => {
        if (!current || controller.signal.aborted) return;
        setRows(items);
        setListState("ready");
      })
      .catch(() => {
        if (!current || controller.signal.aborted) return;
        setListState("error");
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [api, listAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void api
      .GET("/api/v1/users", { signal: controller.signal })
      .then((res) => {
        if (!current || controller.signal.aborted || !res.data) return;
        setUsers(new Map(res.data.items.map((u) => [u.id, u.display_name])));
      })
      .catch(() => undefined);
    return () => {
      current = false;
      controller.abort();
    };
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setRetention(new Map());
    void readEvidenceRetentions(api, rows, controller.signal)
      .then((entries) => {
        if (!current || controller.signal.aborted) return;
        setRetention(entries);
      })
      .catch(() => {
        if (!current || controller.signal.aborted) return;
        setRetention(new Map(rows.map((row) => [row.id, { state: "unavailable", retentionUntil: null }])));
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [api, retentionAttempt, rows]);

  const resolveOwner = (id: string): string => users.get(id) ?? id;

  // 코드·제목·작성자 search label composed from existing column i18n keys
  // (§check-ui-strings bans Hangul literals in lane files — reuse, don't add).
  const searchLabel = `${T.columns.code}·${T.columns.title}·${T.columns.owner}`;

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
    const needle = search.trim().toLocaleLowerCase("ko-KR");
    if (needle.length > 0) {
      visible = visible.filter((row) =>
        [row.code, row.title, users.get(row.custodian) ?? row.custodian]
          .join(" ")
          .toLocaleLowerCase("ko-KR")
          .includes(needle),
      );
    }
    return visible;
  }, [rows, tab, statFilter, retention, search, users]);

  function toggleStat(next: StatFilter) {
    setStatFilter((current) => (current === next ? "ALL" : next));
  }

  // Real export: a CSV of the rows on screen right now — never a fabricated
  // bulk-export the backend doesn't offer (§4-25-⑥).
  function exportVisibleRows() {
    const blob = new Blob([toCsv(visibleRows, resolveOwner)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "documents.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="console" aria-label={T.title} style={rootStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{T.title}</h1>
        <div style={headerActionsStyle}>
          <button type="button" style={actionButtonStyle} onClick={exportVisibleRows}>
            {A.export}
          </button>
          <button
            type="button"
            style={primaryActionButtonStyle}
            onClick={() => {
              setRegisterNotice(true);
            }}
          >
            {A.register}
          </button>
        </div>
      </header>
      {registerNotice ? (
        <StatusChip role="status" tone="warn">
          {A.registerUnavailable}
        </StatusChip>
      ) : null}

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

      <div style={{ ...barStyle, justifyContent: "space-between" }}>
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
        <input
          type="search"
          value={search}
          aria-label={searchLabel}
          placeholder={searchLabel}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
          }}
          style={searchInputStyle}
        />
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
              setListAttempt((attempt) => attempt + 1);
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
                const retentionContent = !entry
                  ? T.retention.pending
                  : entry.state === "unavailable"
                    ? <span style={barStyle}>
                        <StatusChip tone="danger">{T.loadFailed}</StatusChip>
                        <button
                          type="button"
                          style={retryButtonStyle}
                          onClick={() => {
                            setRetentionAttempt((attempt) => attempt + 1);
                          }}
                        >
                          {T.retry}
                        </button>
                      </span>
                    : entry.retentionUntil
                      ? formatDate(entry.retentionUntil)
                      : T.retention.unset;
                return (
                  <tr key={row.id} data-row-id={row.id}>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{row.code}</td>
                    <td style={tdStyle}>{row.title}</td>
                    <td style={tdStyle}>
                      {/* r12: real per-row 유형 (source.title, mapped from the
                          object's actual source_type — record_archive/inbox_doc/
                          mail_attachment/ingest_job/work_order_evidence_media/
                          external_document) instead of a hardcoded "증거" chip on
                          every row — the field already existed on EvidenceObjectDetail
                          (evidenceApi.mapSource) and was simply unused here. */}
                      <StatusChip tone={row.source ? SOURCE_TONE[row.source.kind] : "purple"}>
                        {row.source?.title ?? ko.console.evidence.title}
                      </StatusChip>
                    </td>
                    <td style={tdStyle}>{resolveOwner(row.custodian)}</td>
                    <td style={tdStyle}>{formatDate(row.registeredAt)}</td>
                    <td style={tdStyle}>{retentionContent}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6} style={tfootRowStyle}>
                  {T.stats.total} {stats.total} · {T.stats.registeredThisMonth} {stats.registeredThisMonth} ·{" "}
                  {T.stats.retentionExpiring} {stats.expiring}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
