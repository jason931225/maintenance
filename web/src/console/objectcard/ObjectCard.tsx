import { useState, type CSSProperties, type ReactNode } from "react";

import { ko } from "../../i18n/ko";
import { safeLabel } from "../../lib/utils";
import type { ConsoleApiClient } from "../../api/client";
import { PolicyGated, usePolicyGate } from "../policy";
import { slugLabel, slugTone } from "./kinds";
import {
  useObjectCard,
  OBJECT_CARD_ACTIONS,
  type AuditEntry,
  type ObjectCardState,
  type ObjectLinkResponse,
} from "./useObjectCard";

export interface ObjectCardProps {
  target: { kind: string; id: string };
  api: ConsoleApiClient;
  /** Bearer token for the app-level `/api/audit` timeline read (layer 2). */
  bearerToken?: string;
  /** Navigate to a related object (explore re-center / open). */
  onOpenObject?: (target: { kind: string; id: string }) => void;
}

const t = ko.console.objectCard;

// --- shared shapes (§4-18: one chip, one kv, drawn once) --------------------

const card: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  maxWidth: 420,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  boxShadow: "var(--shadow)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
};

const layerLabel: CSSProperties = {
  fontSize: "var(--text-micro)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
  color: "var(--faint)",
  textTransform: "uppercase",
};

const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  color: "var(--steel)",
};

function KindChip({ kind }: { kind: string }) {
  const tone = slugTone(kind);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0 var(--sp-2)",
        height: "1.5em",
        borderRadius: "var(--radius-chip)",
        border: `1px solid ${tone.bd}`,
        background: tone.bg,
        color: tone.tx,
        fontSize: "var(--text-xs)",
        fontWeight: "var(--fw-medium)",
        lineHeight: 1,
      }}
    >
      {slugLabel(kind)}
    </span>
  );
}

function Layer({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        padding: "var(--sp-3) var(--sp-4)",
        borderTop: "1px solid var(--border-soft)",
      }}
    >
      <span style={layerLabel}>{label}</span>
      {children}
    </section>
  );
}

function KvRow({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: "var(--sp-3)", alignItems: "baseline" }}>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--faint)" }}>{k}</span>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink)", minWidth: 0, wordBreak: "break-word" }}>
        {children}
      </span>
    </div>
  );
}

// --- layer 2: lifecycle chip + audit timeline -------------------------------

function LifecycleChip({ state, legalHold }: { state: string; legalHold: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 var(--sp-2)",
          height: "1.5em",
          borderRadius: "var(--radius-pill)",
          border: "1px solid var(--accent-bd)",
          background: "var(--accent-bg)",
          color: "var(--accent-tx)",
          fontSize: "var(--text-xs)",
          fontWeight: "var(--fw-strong)",
          lineHeight: 1,
        }}
      >
        {state}
      </span>
      {legalHold ? (
        <span
          style={{
            padding: "0 var(--sp-2)",
            height: "1.5em",
            display: "inline-flex",
            alignItems: "center",
            borderRadius: "var(--radius-pill)",
            border: "1px solid var(--danger-bd)",
            background: "var(--danger-bg)",
            color: "var(--danger-tx)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--fw-medium)",
            lineHeight: 1,
          }}
        >
          {t.lifecycle.legalHold}
        </span>
      ) : null}
    </span>
  );
}

function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <span style={{ fontSize: "var(--text-xs)", color: "var(--faint)" }}>{t.audit.empty}</span>;
  }
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      {entries.map((e) => (
        <li key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)", alignItems: "baseline" }}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--ink)", ...mono }}>{e.action}</span>
          <time
            dateTime={e.occurred_at}
            style={{ fontSize: "var(--text-micro)", color: "var(--faint)", whiteSpace: "nowrap" }}
          >
            {e.occurred_at.slice(0, 10)}
          </time>
        </li>
      ))}
    </ol>
  );
}

// --- layer 3: relations ------------------------------------------------------

function RelationChip({
  edge,
  farKind,
  farId,
  target,
  onOpen,
  onRemove,
}: {
  edge: ObjectLinkResponse;
  farKind: string;
  farId: string;
  target: { kind: string; id: string };
  onOpen?: (t: { kind: string; id: string }) => void;
  onRemove: (linkId: string) => void;
}) {
  const gate = usePolicyGate();
  const canOpen = gate.can(OBJECT_CARD_ACTIONS.view, { kind: farKind, id: farId });
  const label = `${slugLabel(farKind)} ${farId}`;
  const inner = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-1)" }} title={safeLabel(edge.link_type)}>
      <KindChip kind={farKind} />
      <span style={mono}>{farId}</span>
    </span>
  );
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-1)",
        padding: "var(--sp-1) var(--sp-2)",
        borderRadius: "var(--radius-chip)",
        border: "1px solid var(--border)",
        background: "var(--muted)",
      }}
    >
      {canOpen && onOpen ? (
        <button
          type="button"
          onClick={() => {
            onOpen({ kind: farKind, id: farId });
          }}
          aria-label={t.relation.open.replace("{label}", label)}
          style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: "inherit" }}
        >
          {inner}
        </button>
      ) : (
        inner
      )}
      <PolicyGated action={OBJECT_CARD_ACTIONS.linkDelete} resource={target}>
        <button
          type="button"
          onClick={() => {
            onRemove(edge.id);
          }}
          aria-label={t.relation.remove.replace("{label}", label)}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            color: "var(--faint)",
            fontSize: "var(--text-sm)",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </PolicyGated>
    </span>
  );
}

function RelationGroup({
  label,
  edges,
  farEnd,
  target,
  onOpen,
  onRemove,
}: {
  label: string;
  edges: ObjectLinkResponse[];
  farEnd: (edge: ObjectLinkResponse) => { kind: string; id: string };
  target: { kind: string; id: string };
  onOpen?: (t: { kind: string; id: string }) => void;
  onRemove: (linkId: string) => void;
}) {
  if (edges.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <span style={{ fontSize: "var(--text-micro)", color: "var(--faint)" }}>{label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
        {edges.map((edge) => {
          const far = farEnd(edge);
          return (
            <RelationChip
              key={edge.id}
              edge={edge}
              farKind={far.kind}
              farId={far.id}
              target={target}
              onOpen={onOpen}
              onRemove={onRemove}
            />
          );
        })}
      </div>
    </div>
  );
}

function AddRelation({ onAdd }: { onAdd: (code: string) => Promise<boolean> }) {
  const [code, setCode] = useState("");
  const [rejected, setRejected] = useState(false);
  const submit = async () => {
    const value = code.trim();
    if (!value) return;
    const ok = await onAdd(value);
    if (ok) {
      setCode("");
      setRejected(false);
    } else {
      // Deny-by-omission: an unlinkable code leaves the input as-is; mark the
      // field invalid rather than fabricating a link.
      setRejected(true);
    }
  };
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
      <span style={{ fontSize: "var(--text-micro)", color: "var(--faint)" }}>{t.relation.addLabel}</span>
      <input
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setRejected(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        aria-invalid={rejected}
        placeholder={t.relation.addPlaceholder}
        style={{
          flex: 1,
          minWidth: 0,
          padding: "var(--sp-1) var(--sp-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--ink)",
          background: "var(--canvas)",
          border: `1px solid ${rejected ? "var(--danger-bd)" : "var(--border)"}`,
          borderRadius: "var(--radius-sm)",
        }}
      />
      <button
        type="button"
        onClick={() => {
          void submit();
        }}
        style={{
          padding: "var(--sp-1) var(--sp-3)",
          fontSize: "var(--text-xs)",
          fontWeight: "var(--fw-medium)",
          color: "var(--surface)",
          background: "var(--signal)",
          border: "1px solid var(--signal-deep)",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
        }}
      >
        {t.relation.add}
      </button>
    </label>
  );
}

/**
 * The console's ONE object card (charter P0.6, §4-18: one component, three
 * layers, no per-domain fork). Rides the shared object substrate:
 *   layer 1 의미  — attributes from GET /api/objects/{kind}/{id} (resolveObject);
 *   layer 2 동작  — lifecycle chip (GET /api/v1/lifecycles/...) + audit timeline
 *                   (GET /api/audit?target_id=...);
 *   layer 3 역학  — relations from GET /api/v1/object-links (both ends) with
 *                   real add (POST, bare-code) / remove (DELETE) mutations.
 * Deny-by-omission: an object that does not resolve renders NOTHING; each layer
 * degrades independently when its own read is denied. Every affordance routes
 * through the shared policy gate (PolicyGated / usePolicyGate).
 *
 * ponytail: layer 3 renders only the concrete object-link relations that exist
 * on the backend today. The automation/policy/series (SR-/AN-) dynamics chips
 * from the digest need BE-AUTO/BE-LC; per the charter no decorative ribbons
 * ship ahead of that backend — they join here once those charters land.
 */
export function ObjectCard({ target, api, bearerToken, onOpenObject }: ObjectCardProps) {
  const { state, addRelation, removeRelation } = useObjectCard(api, bearerToken, target);
  return (
    <ObjectCardView
      state={state}
      target={target}
      onOpenObject={onOpenObject}
      onAddRelation={addRelation}
      onRemoveRelation={(id) => {
        void removeRelation(id);
      }}
    />
  );
}

export interface ObjectCardViewProps {
  state: ObjectCardState;
  target: { kind: string; id: string };
  onOpenObject?: (target: { kind: string; id: string }) => void;
  onAddRelation: (code: string) => Promise<boolean>;
  onRemoveRelation: (linkId: string) => void;
}

/**
 * Pure presentational card (§4-18: the one shape). `ObjectCard` wires the data
 * hook to it; the fidelity demo and pure-render tests feed it static state so a
 * screenshot/assertion is deterministic (no backend, no async settle).
 */
export function ObjectCardView({
  state,
  target,
  onOpenObject,
  onAddRelation,
  onRemoveRelation,
}: ObjectCardViewProps) {
  // Deny-by-omission / not-yet-loaded: no card.
  if (state.status !== "resolved" || !state.head) return null;
  const { head, lifecycle, audit, links } = state;

  const hasBehavior = lifecycle !== null || audit !== null;

  return (
    <article className="console" data-console-root data-objectcard style={card}>
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", padding: "var(--sp-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          <KindChip kind={head.kind} />
          {head.code ? <span style={mono}>{head.code}</span> : null}
        </div>
        <h2 style={{ margin: 0, fontSize: "var(--text-card-title)", fontWeight: "var(--fw-strong)", color: "var(--ink)" }}>
          {safeLabel(head.title, head.code ?? head.id)}
        </h2>
      </header>

      {/* Layer 1 — 의미 */}
      <Layer label={t.layer.meaning}>
        <KvRow k={t.field.kind}>{slugLabel(head.kind)}</KvRow>
        {head.code ? (
          <KvRow k={t.field.code}>
            <span style={mono}>{head.code}</span>
          </KvRow>
        ) : null}
        {head.status ? <KvRow k={t.field.status}>{head.status}</KvRow> : null}
      </Layer>

      {/* Layer 2 — 동작 (lifecycle + audit) */}
      {hasBehavior ? (
        <Layer label={t.layer.behavior}>
          {lifecycle ? <LifecycleChip state={lifecycle.currentState} legalHold={lifecycle.legalHold} /> : null}
          {audit ? <AuditTimeline entries={audit} /> : null}
        </Layer>
      ) : null}

      {/* Layer 3 — 역학 (relations) */}
      <Layer label={t.layer.dynamics}>
        {links.outgoing.length === 0 && links.incoming.length === 0 ? (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--faint)" }}>{t.relation.empty}</span>
        ) : (
          <>
            <RelationGroup
              label={t.relation.outgoing}
              edges={links.outgoing}
              farEnd={(edge) => ({ kind: edge.dst_kind, id: edge.dst_id })}
              target={target}
              onOpen={onOpenObject}
              onRemove={onRemoveRelation}
            />
            <RelationGroup
              label={t.relation.incoming}
              edges={links.incoming}
              farEnd={(edge) => ({ kind: edge.src_kind, id: edge.src_id })}
              target={target}
              onOpen={onOpenObject}
              onRemove={onRemoveRelation}
            />
          </>
        )}
        <PolicyGated action={OBJECT_CARD_ACTIONS.linkCreate} resource={target}>
          <AddRelation onAdd={onAddRelation} />
        </PolicyGated>
      </Layer>
    </article>
  );
}
