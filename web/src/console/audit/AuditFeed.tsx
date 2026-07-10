/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import "../tokens.css";

const T = ko.console.audit;
const DEFAULT_ENDPOINT = "/api/audit";
const DEFAULT_LIMIT = 50;

type StatusChipTone = NonNullable<Parameters<typeof StatusChip>[0]["tone"]>;
type ReadState = "loading" | "ready" | "error";
type FieldVariant = "text" | "mono" | "chip";

export interface AuditRecord {
  id: string;
  actor: string | null;
  action: string;
  target_type: string;
  target_id: string;
  branch_id: string | null;
  before_snap: unknown;
  after_snap: unknown;
  trace_id: string;
  span_id: string;
  occurred_at: string;
}

export interface AuditEntryFieldConfig {
  key: string;
  label: string;
  variant: FieldVariant;
  value: (record: AuditRecord) => string;
  tone?: StatusChipTone | ((record: AuditRecord) => StatusChipTone);
}

export interface AuditDetailFieldConfig {
  key: string;
  label: string;
  value: (record: AuditRecord) => string;
  span?: "normal" | "wide";
}

export interface AuditFeedConfig {
  entryFields: AuditEntryFieldConfig[];
  detailFields: AuditDetailFieldConfig[];
}

export interface AuditFeedProps {
  bearerToken?: string;
  endpoint?: string;
  limit?: number;
  config?: AuditFeedConfig;
}

interface AuditDayGroup {
  key: string;
  label: string;
  rows: AuditRecord[];
}

const rootStyle: CSSProperties = {
  minHeight: "100%",
  display: "grid",
  alignContent: "start",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const titleGroupStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-h1)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const toolbarStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(180px, 360px) auto",
  alignItems: "end",
  gap: "var(--sp-3)",
};

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const inputStyle: CSSProperties = {
  minHeight: 34,
  minWidth: 0,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
};

const feedStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
};

const daySectionStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
};

const dayButtonStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
  minHeight: 38,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  boxShadow: "var(--shadow)",
  cursor: "pointer",
};

const dayTitleStyle: CSSProperties = {
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const entryStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const entryHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr)) auto",
  gap: "var(--sp-3)",
  alignItems: "center",
};

const valueStackStyle: CSSProperties = {
  display: "grid",
  minWidth: 0,
  gap: "var(--sp-1)",
};

const labelStyle: CSSProperties = {
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
};

const textValueStyle: CSSProperties = {
  minWidth: 0,
  overflowWrap: "anywhere",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

const monoValueStyle: CSSProperties = {
  ...textValueStyle,
  fontFamily: "var(--font-mono)",
  color: "var(--steel)",
};

const buttonStyle: CSSProperties = {
  minHeight: 30,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const detailsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "var(--sp-3)",
  paddingTop: "var(--sp-3)",
  borderTop: "1px solid var(--border-soft)",
};

const detailCellStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  minWidth: 0,
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
};

const detailLabelStyle: CSSProperties = {
  margin: 0,
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const detailValueStyle: CSSProperties = {
  margin: 0,
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
  color: "var(--steel)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-body)",
};

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function auditRecordFromUnknown(value: unknown): AuditRecord | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const id = record.id;
  const action = record.action;
  const targetType = record.target_type;
  const targetId = record.target_id;
  const traceId = record.trace_id;
  const spanId = record.span_id;
  const occurredAt = record.occurred_at;
  if (
    typeof id !== "string" ||
    typeof action !== "string" ||
    typeof targetType !== "string" ||
    typeof targetId !== "string" ||
    typeof traceId !== "string" ||
    typeof spanId !== "string" ||
    typeof occurredAt !== "string"
  ) {
    return undefined;
  }
  return {
    id,
    actor: optionalString(record.actor),
    action,
    target_type: targetType,
    target_id: targetId,
    branch_id: optionalString(record.branch_id),
    before_snap: record.before_snap ?? record.before_snapshot ?? null,
    after_snap: record.after_snap ?? record.after_snapshot ?? null,
    trace_id: traceId,
    span_id: spanId,
    occurred_at: occurredAt,
  };
}

function auditRecordsFromPayload(payload: unknown): AuditRecord[] {
  const page = objectRecord(payload);
  const items = Array.isArray(page?.items) ? page.items : [];
  return items.flatMap((item) => {
    const record = auditRecordFromUnknown(item);
    return record ? [record] : [];
  });
}

function requestHeaders(bearerToken: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Auth-Transport": "cookie",
  };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return headers;
}

async function fetchAuditRecords({
  bearerToken,
  endpoint,
  limit,
  signal,
}: {
  bearerToken?: string;
  endpoint: string;
  limit: number;
  signal: AbortSignal;
}): Promise<AuditRecord[]> {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(endpoint, origin);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", "0");
  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: requestHeaders(bearerToken),
    signal,
  });
  if (!response.ok) throw new Error(`audit feed failed: ${String(response.status)}`);
  return auditRecordsFromPayload(await response.json());
}

function parseTimestamp(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateKey(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayDescriptor(value: string): { key: string; label: string } {
  const date = parseTimestamp(value);
  if (!date) return { key: "unknown", label: T.day.unknown };
  const key = dateKey(date);
  const now = new Date();
  if (key === dateKey(now)) return { key, label: T.day.today };
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dateKey(yesterday)) return { key, label: T.day.yesterday };
  return { key, label: T.day.absolute(date) };
}

function timestampLabel(value: string): string {
  const date = parseTimestamp(value);
  return date ? T.datetime(date) : value;
}

function displayActor(actor: string | null): string {
  return actor && actor.trim().length > 0 ? actor : T.values.systemActor;
}

function displayOptional(value: string | null): string {
  return value && value.trim().length > 0 ? value : T.values.none;
}

function stringifyDetail(value: unknown): string {
  if (value === null || value === undefined) return T.values.none;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return T.values.unreadable;
  }
}

function actionTone(record: AuditRecord): StatusChipTone {
  const action = record.action.toLowerCase();
  if (/forbid|deny|reject|delete|remove|fail/.test(action)) return "danger";
  if (/warn|update|change|return|revoke/.test(action)) return "warn";
  if (/approve|finalize|create|confirm|success/.test(action)) return "ok";
  if (/read|view|list|search/.test(action)) return "info";
  return "accent";
}

export const defaultAuditFeedConfig: AuditFeedConfig = {
  entryFields: [
    {
      key: "actor",
      label: T.fields.actor,
      variant: "mono",
      value: (record) => displayActor(record.actor),
    },
    {
      key: "target",
      label: T.fields.targetId,
      variant: "mono",
      value: (record) => record.target_id,
    },
    {
      key: "timestamp",
      label: T.fields.timestamp,
      variant: "text",
      value: (record) => timestampLabel(record.occurred_at),
    },
    {
      key: "action",
      label: T.fields.actionType,
      variant: "chip",
      tone: actionTone,
      value: (record) => record.action,
    },
  ],
  detailFields: [
    {
      key: "trace",
      label: T.fields.traceId,
      value: (record) => record.trace_id,
      span: "wide",
    },
    {
      key: "span",
      label: T.fields.spanId,
      value: (record) => record.span_id,
    },
    {
      key: "targetType",
      label: T.fields.targetType,
      value: (record) => record.target_type,
    },
    {
      key: "branch",
      label: T.fields.branchId,
      value: (record) => displayOptional(record.branch_id),
    },
    {
      key: "before",
      label: T.fields.before,
      value: (record) => stringifyDetail(record.before_snap),
      span: "wide",
    },
    {
      key: "after",
      label: T.fields.after,
      value: (record) => stringifyDetail(record.after_snap),
      span: "wide",
    },
  ],
};

function groupAuditRecords(records: AuditRecord[]): AuditDayGroup[] {
  const groupMap = new Map<string, AuditDayGroup>();
  for (const record of records) {
    const day = dayDescriptor(record.occurred_at);
    const existing = groupMap.get(day.key);
    if (existing) {
      existing.rows.push(record);
    } else {
      groupMap.set(day.key, { key: day.key, label: day.label, rows: [record] });
    }
  }
  return Array.from(groupMap.values());
}

function fieldTone(field: AuditEntryFieldConfig, record: AuditRecord): StatusChipTone {
  if (!field.tone) return "neutral";
  return typeof field.tone === "function" ? field.tone(record) : field.tone;
}

function FieldValue({ field, record }: { field: AuditEntryFieldConfig; record: AuditRecord }) {
  const value = field.value(record);
  if (field.variant === "chip") {
    return <StatusChip tone={fieldTone(field, record)}>{value}</StatusChip>;
  }
  return <span style={field.variant === "mono" ? monoValueStyle : textValueStyle}>{value}</span>;
}

function AuditEntry({
  config,
  isOpen,
  onToggle,
  record,
}: {
  config: AuditFeedConfig;
  isOpen: boolean;
  onToggle: () => void;
  record: AuditRecord;
}) {
  return (
    <li style={entryStyle}>
      <div style={entryHeaderStyle}>
        {config.entryFields.map((field) => (
          <span key={field.key} style={valueStackStyle}>
            <span style={labelStyle}>{field.label}</span>
            <FieldValue field={field} record={record} />
          </span>
        ))}
        <button
          aria-expanded={isOpen}
          aria-label={isOpen ? T.actions.collapseEntry(record.target_id) : T.actions.expandEntry(record.target_id)}
          onClick={onToggle}
          style={buttonStyle}
          type="button"
        >
          {isOpen ? T.actions.collapse : T.actions.expand}
        </button>
      </div>

      {isOpen ? (
        <dl style={detailsStyle}>
          {config.detailFields.map((field) => (
            <div
              key={field.key}
              style={{
                ...detailCellStyle,
                gridColumn: field.span === "wide" ? "1 / -1" : undefined,
              }}
            >
              <dt style={detailLabelStyle}>{field.label}</dt>
              <dd style={detailValueStyle}>{field.value(record)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

function AuditDaySection({
  config,
  collapsed,
  group,
  onToggleDay,
  openIds,
  onToggleEntry,
}: {
  config: AuditFeedConfig;
  collapsed: boolean;
  group: AuditDayGroup;
  onToggleDay: () => void;
  openIds: ReadonlySet<string>;
  onToggleEntry: (id: string) => void;
}) {
  return (
    <section aria-labelledby={`audit-day-${group.key}`} style={daySectionStyle}>
      <button
        aria-expanded={!collapsed}
        aria-label={T.actions.toggleDay(group.label)}
        onClick={onToggleDay}
        style={dayButtonStyle}
        type="button"
      >
        <span id={`audit-day-${group.key}`} style={dayTitleStyle}>{group.label}</span>
        <span style={chipRowStyle}>
          <StatusChip tone="info">{T.count(group.rows.length)}</StatusChip>
          <StatusChip tone="neutral">{collapsed ? T.status.collapsed : T.status.expanded}</StatusChip>
        </span>
      </button>
      {collapsed ? null : (
        <ol style={listStyle}>
          {group.rows.map((record) => (
            <AuditEntry
              key={record.id}
              config={config}
              isOpen={openIds.has(record.id)}
              onToggle={() => {
                onToggleEntry(record.id);
              }}
              record={record}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function statusChip(readState: ReadState, total: number): ReactNode {
  if (readState === "loading") return <StatusChip tone="info">{T.status.loading}</StatusChip>;
  if (readState === "error") return <StatusChip role="alert" tone="danger">{T.status.error}</StatusChip>;
  return <StatusChip tone={total > 0 ? "ok" : "neutral"}>{T.count(total)}</StatusChip>;
}

export function AuditFeed({
  bearerToken,
  endpoint = DEFAULT_ENDPOINT,
  limit = DEFAULT_LIMIT,
  config = defaultAuditFeedConfig,
}: AuditFeedProps) {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [traceQuery, setTraceQuery] = useState("");
  const [collapsedDays, setCollapsedDays] = useState<ReadonlySet<string>>(() => new Set());
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (active) setReadState("loading");
    });
    void fetchAuditRecords({ bearerToken, endpoint, limit, signal: controller.signal })
      .then((nextRecords) => {
        if (!active) return;
        setRecords(nextRecords);
        setReadState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRecords([]);
        setReadState("error");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [bearerToken, endpoint, limit]);

  const filteredRecords = useMemo(() => {
    const query = traceQuery.trim().toLowerCase();
    if (query.length === 0) return records;
    return records.filter((record) => record.trace_id.toLowerCase().includes(query));
  }, [records, traceQuery]);

  const groups = useMemo(() => groupAuditRecords(filteredRecords), [filteredRecords]);

  function toggleDay(key: string): void {
    setCollapsedDays((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleEntry(id: string): void {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section aria-labelledby="audit-feed-title" className="console" style={rootStyle}>
      <header style={headerStyle}>
        <div style={titleGroupStyle}>
          <h1 id="audit-feed-title" style={titleStyle}>{T.title}</h1>
          <span style={chipRowStyle}>
            {statusChip(readState, filteredRecords.length)}
            <StatusChip tone="accent">{T.live}</StatusChip>
          </span>
        </div>
      </header>

      <div style={toolbarStyle}>
        <label style={fieldLabelStyle}>
          {T.search.label}
          <input
            aria-label={T.search.label}
            onChange={(event) => {
              setTraceQuery(event.target.value);
            }}
            placeholder={T.search.placeholder}
            style={inputStyle}
            value={traceQuery}
          />
        </label>
        <span style={chipRowStyle}>
          <StatusChip tone={traceQuery.trim().length > 0 ? "info" : "neutral"}>
            {traceQuery.trim().length > 0 ? T.search.filtered : T.search.all}
          </StatusChip>
        </span>
      </div>

      {readState === "error" ? null : groups.length === 0 ? (
        <span style={chipRowStyle}>
          <StatusChip tone="neutral">{readState === "loading" ? T.status.loading : T.status.empty}</StatusChip>
        </span>
      ) : (
        <div style={feedStyle}>
          {groups.map((group) => (
            <AuditDaySection
              key={group.key}
              collapsed={collapsedDays.has(group.key)}
              config={config}
              group={group}
              onToggleDay={() => {
                toggleDay(group.key);
              }}
              onToggleEntry={toggleEntry}
              openIds={openIds}
            />
          ))}
        </div>
      )}
    </section>
  );
}
