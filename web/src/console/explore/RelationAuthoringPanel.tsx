import { useMemo, useState, type CSSProperties, type SyntheticEvent } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";

export interface ObjectTarget {
  kind: string;
  id: string;
}

export interface ObjectGraphNode extends ObjectTarget {
  code: string | null;
  title: string | null;
  status: string | null;
  exists: boolean;
}

export interface ObjectLinkResponse {
  id: string;
  src_kind: string;
  src_id: string;
  dst_kind: string;
  dst_id: string;
  link_type: string;
  created_by: string | null;
  created_at: string;
}

export interface ObjectGraphResponse {
  nodes: ObjectGraphNode[];
  edges: ObjectLinkResponse[];
  truncated: boolean;
}

interface AuditListResponse {
  items?: unknown[];
}

const RELATION_AUTHORING_ACTIONS = {
  view: "object.view",
  linkCreate: "object.link.create",
  linkDelete: "object.link.delete",
} as const;

export interface RelationAuthoringPanelProps {
  target: ObjectTarget;
  bearerToken?: string;
  initialGraph?: ObjectGraphResponse;
  depth?: number;
  onGraphChange?: (graph: ObjectGraphResponse) => void;
}

const T = ko.console.explore.relations;
const DEFAULT_LINK_TYPE = "relates_to";

const panelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  color: "var(--ink)",
};

const formStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
  alignItems: "end",
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
};

const labelStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  color: "var(--faint)",
};

const inputStyle: CSSProperties = {
  minHeight: 34,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
};

const buttonStyle: CSSProperties = {
  minHeight: 34,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--accent-bd)",
  background: "var(--accent-bg)",
  color: "var(--accent-tx)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const removeButtonStyle: CSSProperties = {
  ...buttonStyle,
  minHeight: 28,
  borderColor: "var(--danger-bd)",
  background: "var(--danger-bg)",
  color: "var(--danger-tx)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-xs)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  color: "var(--steel)",
};

function requestHeaders(bearerToken: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Auth-Transport": "cookie",
  };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return headers;
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function graphUrl(target: ObjectTarget, depth: number): string {
  const params = new URLSearchParams({ depth: String(depth) });
  return `/api/objects/${encodeSegment(target.kind)}/${encodeSegment(target.id)}/graph?${params.toString()}`;
}

function farEnd(edge: ObjectLinkResponse, target: ObjectTarget): ObjectTarget {
  if (edge.src_kind === target.kind && edge.src_id === target.id) {
    return { kind: edge.dst_kind, id: edge.dst_id };
  }
  return { kind: edge.src_kind, id: edge.src_id };
}

function touchesTarget(edge: ObjectLinkResponse, target: ObjectTarget): boolean {
  return (
    (edge.src_kind === target.kind && edge.src_id === target.id) ||
    (edge.dst_kind === target.kind && edge.dst_id === target.id)
  );
}

async function parseJson<TBody>(response: Response): Promise<TBody> {
  return (await response.json()) as TBody;
}

async function fetchGraph(
  target: ObjectTarget,
  bearerToken: string | undefined,
  depth: number,
): Promise<ObjectGraphResponse> {
  const response = await fetch(graphUrl(target, depth), {
    headers: requestHeaders(bearerToken),
    credentials: "include",
  });
  if (!response.ok) throw new Error(T.errors.graphRefreshFailed);
  return parseJson<ObjectGraphResponse>(response);
}

async function refreshAudit(target: ObjectTarget, bearerToken: string | undefined): Promise<boolean> {
  const params = new URLSearchParams({ target_id: target.id, limit: "5" });
  const response = await fetch(`/api/audit?${params.toString()}`, {
    headers: requestHeaders(bearerToken),
    credentials: "include",
  });
  if (!response.ok) return false;
  const body = await parseJson<AuditListResponse>(response);
  return Array.isArray(body.items);
}

export function RelationAuthoringPanel({
  target,
  bearerToken,
  initialGraph,
  depth = 2,
  onGraphChange,
}: RelationAuthoringPanelProps) {
  const [graph, setGraph] = useState<ObjectGraphResponse>(
    initialGraph ?? { nodes: [], edges: [], truncated: false },
  );
  const [dstKind, setDstKind] = useState("approval_run");
  const [dstId, setDstId] = useState("");
  const [linkType, setLinkType] = useState(DEFAULT_LINK_TYPE);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);

  const targetEdges = useMemo(
    () => graph.edges.filter((edge) => touchesTarget(edge, target)),
    [graph.edges, target],
  );

  async function refreshAfterMutation(): Promise<void> {
    const [nextGraph, auditOk] = await Promise.all([
      fetchGraph(target, bearerToken, depth),
      refreshAudit(target, bearerToken).catch(() => false),
    ]);
    setGraph(nextGraph);
    onGraphChange?.(nextGraph);
    setMessage({ tone: auditOk ? "ok" : "warn", text: auditOk ? T.auditRefreshed : T.auditRefreshFailed });
  }

  async function addRelation(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedKind = dstKind.trim();
    const normalizedId = dstId.trim();
    const normalizedType = linkType.trim() || DEFAULT_LINK_TYPE;
    if (!normalizedKind || !normalizedId) {
      setMessage({ tone: "danger", text: T.errors.targetRequired });
      return;
    }
    setPending("add");
    setMessage(null);
    try {
      const response = await fetch("/api/v1/object-links", {
        method: "POST",
        headers: requestHeaders(bearerToken),
        credentials: "include",
        body: JSON.stringify({
          src_kind: target.kind,
          src_id: target.id,
          dst_kind: normalizedKind,
          dst_id: normalizedId,
          link_type: normalizedType,
        }),
      });
      if (!response.ok) throw new Error(T.errors.createFailed);
      await refreshAfterMutation();
      setDstId("");
      setLinkType(normalizedType);
    } catch {
      setMessage({ tone: "danger", text: T.errors.createFailed });
    } finally {
      setPending(null);
    }
  }

  async function removeRelation(edge: ObjectLinkResponse): Promise<void> {
    setPending(edge.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/object-links/${encodeSegment(edge.id)}`, {
        method: "DELETE",
        headers: requestHeaders(bearerToken),
        credentials: "include",
      });
      if (!response.ok && response.status !== 204) throw new Error(T.errors.removeFailed);
      await refreshAfterMutation();
    } catch {
      setMessage({ tone: "danger", text: T.errors.removeFailed });
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="relation-authoring-title" style={panelStyle}>
      <div style={headerStyle}>
        <h2 id="relation-authoring-title" style={titleStyle}>{T.title}</h2>
        <StatusChip tone={graph.truncated ? "warn" : "info"}>{T.count(targetEdges.length)}</StatusChip>
      </div>

      <PolicyGated action={RELATION_AUTHORING_ACTIONS.linkCreate} resource={{ kind: target.kind, id: target.id }}>
        <form aria-label={T.formLabel} onSubmit={(event) => { void addRelation(event); }} style={formStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{T.targetKind}</span>
            <input
              aria-label={T.targetKind}
              onChange={(event) => { setDstKind(event.target.value); }}
              style={inputStyle}
              value={dstKind}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{T.targetId}</span>
            <input
              aria-label={T.targetId}
              onChange={(event) => { setDstId(event.target.value); }}
              placeholder="AP-3121"
              style={inputStyle}
              value={dstId}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{T.linkType}</span>
            <input
              aria-label={T.linkType}
              onChange={(event) => { setLinkType(event.target.value); }}
              style={inputStyle}
              value={linkType}
            />
          </label>
          <button disabled={pending !== null} style={buttonStyle} type="submit">
            {pending === "add" ? T.adding : T.add}
          </button>
        </form>
      </PolicyGated>

      {targetEdges.length > 0 ? (
        <ul aria-label={T.listLabel} style={listStyle}>
          {targetEdges.map((edge) => {
            const far = farEnd(edge, target);
            const label = `${far.kind} ${far.id}`;
            return (
              <li key={edge.id} style={rowStyle}>
                <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "var(--sp-2)" }}>
                  <StatusChip tone="neutral">{edge.link_type}</StatusChip>
                  <span style={monoStyle}>{label}</span>
                </span>
                <PolicyGated action={RELATION_AUTHORING_ACTIONS.linkDelete} resource={{ kind: "object_link", id: edge.id }}>
                  <button
                    aria-label={T.removeAria(label)}
                    disabled={pending !== null}
                    onClick={() => { void removeRelation(edge); }}
                    style={removeButtonStyle}
                    type="button"
                  >
                    {pending === edge.id ? T.removing : T.remove}
                  </button>
                </PolicyGated>
              </li>
            );
          })}
        </ul>
      ) : (
        <p style={{ margin: 0, color: "var(--faint)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-body)" }}>
          {T.empty}
        </p>
      )}

      {message ? <StatusChip role={message.tone === "danger" ? "alert" : "status"} tone={message.tone}>{message.text}</StatusChip> : null}
    </section>
  );
}
