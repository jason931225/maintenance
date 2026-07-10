/* eslint-disable react-refresh/only-export-components */
import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { objectCardDynStrings } from "./strings";
import { PolicyGated, usePolicyGate } from "../policy";
import {
  objDrag,
  parseObjectRefText,
  useObjectDrop,
  type WindowEntry,
} from "../window";
import "../tokens.css";
import {
  OBJECT_CARD_ACTIONS,
  type LinkCardinality,
  type ObjectCardAction,
  type ObjectCardActingChip,
  type ObjectCardApproval,
  type ObjectCardDescriptor,
  type ObjectCardHandlers,
  type ObjectCardLifecycleStep,
  type ObjectCardProperty,
  type ObjectCardRelation,
  type ObjectCardRevision,
  type ObjectLifecycleState,
  type StatusTone,
} from "./types";

const T = ko.console.objectcard;

const lifecycleTone: Record<ObjectLifecycleState, StatusTone> = {
  draft: "neutral",
  active: "ok",
  locked: "warn",
  archived: "info",
  disposed: "danger",
};

const actingTone: Record<ObjectCardActingChip["kind"], StatusTone> = {
  automation: "accent",
  policy: "purple",
  series: "info",
};

const approvalTone: Record<ObjectCardApproval["decision"], StatusTone> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
};

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-5)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
};

const headerTopStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-h1)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const monoStyle: CSSProperties = {
  color: "var(--faint)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
  alignItems: "center",
};

const layerStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
};

const layerHeadingStyle: CSSProperties = {
  margin: 0,
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const propertyRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "var(--sp-2)",
  padding: "var(--sp-2) 0",
  borderBottom: "1px solid var(--border-soft)",
};

const propertyNameStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

const propertyValueStyle: CSSProperties = {
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
  textAlign: "right",
  wordBreak: "break-word",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const relationRowStyle: CSSProperties = {
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

const stepperStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const timelineListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const timelineItemStyle: CSSProperties = {
  position: "relative",
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  paddingInlineStart: "calc(var(--sp-6) + var(--sp-2))",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
};

const timelineDotStyle: CSSProperties = {
  position: "absolute",
  insetBlockStart: "var(--sp-4)",
  insetInlineStart: "var(--sp-4)",
  width: 10,
  height: 10,
  borderRadius: "var(--radius-pill)",
  border: "2px solid var(--timeline-dot-bd)",
  background: "var(--timeline-dot-bg)",
};

const metaStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-medium)",
};

const buttonStyle: CSSProperties = {
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

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--signal)",
  background: "var(--signal)",
  color: "var(--ink)",
};

const removeButtonStyle: CSSProperties = {
  ...buttonStyle,
  minHeight: 44,
  padding: "0 var(--sp-3)",
  borderColor: "var(--danger-bd)",
  background: "var(--danger-bg)",
  color: "var(--danger-tx)",
  fontSize: "var(--text-xs)",
};

const inputStyle: CSSProperties = {
  minHeight: 44,
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

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const dropZoneStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-4)",
  border: "1px dashed var(--canvas-grid-bd)",
  borderRadius: "var(--radius-md)",
  background: "var(--canvas-grid-bg)",
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-medium)",
  textAlign: "center",
};

const bannerStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-4)",
  border: "1px solid var(--warn-bd)",
  borderRadius: "var(--radius-md)",
  background: "var(--warn-bg)",
  color: "var(--warn-tx)",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 60,
  padding: "var(--sp-2) var(--sp-3)",
  resize: "vertical",
};

const actingChipButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  minWidth: 44,
  padding: "0 var(--sp-1)",
  border: "none",
  background: "transparent",
  cursor: "pointer",
};

function Section({
  title,
  count,
  children,
  labelledById,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  labelledById: string;
}) {
  return (
    <section aria-labelledby={labelledById} style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <h3 id={labelledById} style={sectionTitleStyle}>
          {title}
        </h3>
        {count !== undefined ? <StatusChip tone="neutral">{T.count(count)}</StatusChip> : null}
      </div>
      {children}
    </section>
  );
}

// ── Semantic layer ────────────────────────────────────────────────────────

function PropertyList({ properties }: { properties: ObjectCardProperty[] }) {
  const gate = usePolicyGate();
  // Deny-by-omission: a property in the property-policy set renders only when the
  // subject may read it (arch §5b); a server-nulled value is likewise omitted.
  const visible = properties.filter((property) => {
    if (property.value === null) return false;
    if (property.inPropertyPolicy) {
      return gate.can(OBJECT_CARD_ACTIONS.propertyRead, { kind: "property", id: property.key });
    }
    return true;
  });
  if (visible.length === 0) return null;
  return (
    <Section title={T.sections.properties} count={visible.length} labelledById="object-card-properties">
      <div style={listStyle}>
        {visible.map((property) => (
          <div key={property.key} style={propertyRowStyle}>
            <span style={propertyNameStyle}>
              {property.title}
              <StatusChip tone="neutral" ariaLabel={T.typeBadge(property.type)}>
                {property.type}
              </StatusChip>
            </span>
            <span style={propertyValueStyle}>{property.value}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function cardinalityLabel(cardinality: LinkCardinality): string {
  return T.relations.cardinality[cardinality];
}

function RelationList({
  relations,
  onRemove,
}: {
  relations: ObjectCardRelation[];
  onRemove?: (linkId: string) => void;
}) {
  if (relations.length === 0) return null;
  return (
    <ul aria-label={T.sections.relations} style={listStyle}>
      {relations.map((relation) => {
        const farLabel = `${relation.code} ${relation.title}`;
        return (
          <li key={relation.linkId} style={relationRowStyle}>
            <span
              {...objDrag(relation.code, relation.title)}
              title={ko.console.window.dragRefOf(relation.title)}
              style={chipRowStyle}
            >
              <StatusChip
                tone="neutral"
                ariaLabel={T.relations.directionAria[relation.direction]}
              >
                {T.relations.direction[relation.direction]}
              </StatusChip>
              <StatusChip tone="info">{relation.linkType}</StatusChip>
              <StatusChip tone="accent">{cardinalityLabel(relation.cardinality)}</StatusChip>
              <span style={monoStyle}>{relation.code}</span>
              <span style={{ color: "var(--ink)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-strong)" }}>
                {relation.title}
              </span>
            </span>
            <PolicyGated
              action={OBJECT_CARD_ACTIONS.linkDelete}
              resource={{ kind: "object_link", id: relation.linkId }}
            >
              <button
                type="button"
                aria-label={T.relations.removeAria(farLabel)}
                data-window-control="true"
                onClick={() => onRemove?.(relation.linkId)}
                style={removeButtonStyle}
              >
                {T.relations.remove}
              </button>
            </PolicyGated>
          </li>
        );
      })}
    </ul>
  );
}

function RelationDraw({
  objectId,
  onAdd,
  onResolveCode,
}: {
  objectId: string;
  onAdd: (draft: { code: string; title: string; linkType: string }) => void;
  /** GET /ontology/resolve?code= — real title before drawing (no fabricated titles). */
  onResolveCode?: (code: string) => Promise<{ title: string } | null>;
}) {
  const DYN = objectCardDynStrings();
  const [code, setCode] = useState("");
  const [linkType, setLinkType] = useState("relates_to");
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  async function commit(rawCode: string): Promise<void> {
    const ref = parseObjectRefText(rawCode);
    if (!ref) {
      setError(T.relations.invalidCode);
      return;
    }
    setError(null);
    if (!onResolveCode) {
      // No resolve seam wired — fall back to the parsed/dropped title as-is.
      onAdd({ code: ref.code, title: ref.title, linkType: linkType.trim() || "relates_to" });
      setCode("");
      return;
    }
    setResolving(true);
    try {
      const resolved = await onResolveCode(ref.code);
      if (!resolved) {
        setError(DYN.relations.codeNotFound);
        return;
      }
      onAdd({ code: ref.code, title: resolved.title, linkType: linkType.trim() || "relates_to" });
      setCode("");
    } catch {
      setError(DYN.relations.resolveFailed);
    } finally {
      setResolving(false);
    }
  }

  // Reuse window/objDrag drop grammar: dropping an object chip draws the edge.
  const drop = useObjectDrop({ onRef: (ref) => { void commit(ref.code); } });

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void commit(code);
  }

  return (
    <PolicyGated action={OBJECT_CARD_ACTIONS.linkCreate} resource={{ kind: "object", id: objectId }}>
      <div style={{ display: "grid", gap: "var(--sp-3)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto", gap: "var(--sp-2)", alignItems: "end" }}>
          <label style={fieldStyle}>
            {T.relations.codeLabel}
            <input
              aria-label={T.relations.codeLabel}
              value={code}
              placeholder={T.relations.codePlaceholder}
              onChange={(event) => { setCode(event.target.value); }}
              onKeyDown={onKeyDown}
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            {T.relations.linkTypeLabel}
            <input
              aria-label={T.relations.linkTypeLabel}
              value={linkType}
              onChange={(event) => { setLinkType(event.target.value); }}
              style={inputStyle}
            />
          </label>
          <button
            type="button"
            data-window-control="true"
            disabled={resolving}
            onClick={() => { void commit(code); }}
            style={primaryButtonStyle}
          >
            {resolving ? DYN.relations.resolving : T.relations.add}
          </button>
        </div>
        <div {...drop} style={dropZoneStyle}>
          {T.relations.dropHint}
        </div>
        {error ? (
          <StatusChip tone="danger" role="alert">
            {error}
          </StatusChip>
        ) : null}
      </div>
    </PolicyGated>
  );
}

// ── Kinetic layer ─────────────────────────────────────────────────────────

function LifecycleStepper({ steps }: { steps: ObjectCardLifecycleStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol aria-label={T.sections.lifecycle} style={{ ...stepperStyle, margin: 0, padding: 0, listStyle: "none" }}>
      {steps.map((step) => (
        <li key={step.state} aria-current={step.current ? "step" : undefined}>
          <StatusChip
            tone={step.current || step.reached ? lifecycleTone[step.state] : "neutral"}
            ariaLabel={T.lifecycleAria(T.lifecycle[step.state])}
          >
            {T.lifecycle[step.state]}
          </StatusChip>
        </li>
      ))}
    </ol>
  );
}

function HistoryTimeline({ history }: { history: ObjectCardRevision[] }) {
  if (history.length === 0) return null;
  return (
    <ol aria-label={T.sections.history} style={timelineListStyle}>
      {history.map((revision) => (
        <li key={revision.version} style={timelineItemStyle}>
          <span aria-hidden="true" style={timelineDotStyle} />
          <div style={metaStyle}>
            <StatusChip tone="info">{T.version(revision.version)}</StatusChip>
            <StatusChip
              tone={revision.hashVerified ? "ok" : "danger"}
              role={revision.hashVerified ? "status" : "alert"}
            >
              {revision.hashVerified ? T.history.hashVerified : T.history.hashUnverified}
            </StatusChip>
            {revision.action ? <StatusChip tone="neutral">{revision.action}</StatusChip> : null}
            <span>{T.history.entry(revision.at, revision.actor)}</span>
          </div>
          {revision.reason ? (
            <p style={{ margin: 0, color: "var(--steel)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-medium)" }}>
              {revision.reason}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function ApprovalLine({ approvals }: { approvals: ObjectCardApproval[] }) {
  if (approvals.length === 0) return null;
  return (
    <ul aria-label={T.sections.approvals} style={listStyle}>
      {approvals.map((approval) => (
        <li key={approval.id} style={relationRowStyle}>
          <span style={chipRowStyle}>
            <StatusChip tone="neutral">{approval.kind}</StatusChip>
            <span style={{ color: "var(--ink)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-medium)" }}>
              {T.approval.line(approval.requestedBy, approval.approver)}
            </span>
          </span>
          <StatusChip
            tone={approvalTone[approval.decision]}
            role={approval.decision === "rejected" ? "alert" : "status"}
          >
            {T.approval[approval.decision]}
          </StatusChip>
        </li>
      ))}
    </ul>
  );
}

// ── Dynamic layer ─────────────────────────────────────────────────────────

function ActingChips({
  acting,
  onNavigate,
}: {
  acting: ObjectCardActingChip[];
  /** Click = navigate to the automation/policy this chip names. */
  onNavigate?: (chip: ObjectCardActingChip) => void;
}) {
  const DYN = objectCardDynStrings();
  if (acting.length === 0) return null;
  return (
    <div aria-label={T.sections.acting} style={chipRowStyle}>
      {acting.map((chip) => (
        <button
          key={chip.id}
          type="button"
          data-window-control="true"
          aria-label={DYN.acting.navigateAria(chip.label, T.acting[chip.kind])}
          disabled={!onNavigate}
          onClick={() => { onNavigate?.(chip); }}
          style={actingChipButtonStyle}
        >
          <StatusChip tone={actingTone[chip.kind]} ariaLabel={T.acting[chip.kind]}>
            {chip.label}
          </StatusChip>
        </button>
      ))}
    </div>
  );
}

function ActionBar({
  objectId,
  actions,
  onAction,
}: {
  objectId: string;
  actions: ObjectCardAction[];
  onAction?: (action: ObjectCardAction, ctx: { reason?: string }) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div style={chipRowStyle}>
      {actions.map((action) => (
        <PolicyGated
          key={action.key}
          action={OBJECT_CARD_ACTIONS.actionExecute}
          resource={{ kind: "object_action", id: `${objectId}:${action.key}` }}
        >
          <button
            type="button"
            aria-label={T.actionAria(action.title)}
            data-window-control="true"
            onClick={() => onAction?.(action, {})}
            style={action.tone === "danger" ? removeButtonStyle : buttonStyle}
          >
            {action.title}
          </button>
        </PolicyGated>
      ))}
    </div>
  );
}

// ── §20 override / direct-edit path ──────────────────────────────────────

function EditBar({
  lifecycleState,
  objectId,
  onEdit,
}: {
  lifecycleState: ObjectLifecycleState;
  objectId: string;
  onEdit?: (ctx: { mode: "direct" | "override"; reason?: string }) => void;
}) {
  const isDraft = lifecycleState === "draft";
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    if (isDraft) {
      onEdit?.({ mode: "direct" });
      setOpen(false);
      return;
    }
    if (reason.trim().length === 0) {
      setError(T.edit.reasonRequired);
      return;
    }
    setError(null);
    onEdit?.({ mode: "override", reason: reason.trim() });
    setOpen(false);
    setReason("");
  }

  return (
    <PolicyGated action={OBJECT_CARD_ACTIONS.edit} resource={{ kind: "object", id: objectId }}>
      <div style={{ display: "grid", gap: "var(--sp-3)" }}>
        <button
          type="button"
          data-window-control="true"
          aria-expanded={open}
          onClick={() => { setOpen((current) => !current); }}
          style={buttonStyle}
        >
          {isDraft ? T.edit.direct : T.edit.override}
        </button>
        {open ? (
          isDraft ? (
            <div style={{ display: "grid", gap: "var(--sp-2)" }}>
              <StatusChip tone="info">{T.edit.directNote}</StatusChip>
              <div style={chipRowStyle}>
                <button type="button" data-window-control="true" onClick={submit} style={primaryButtonStyle}>
                  {T.edit.apply}
                </button>
                <button type="button" data-window-control="true" onClick={() => { setOpen(false); }} style={buttonStyle}>
                  {T.edit.cancel}
                </button>
              </div>
            </div>
          ) : (
            <div role="group" aria-label={T.edit.override} style={bannerStyle}>
              <StatusChip tone="warn">{T.edit.fourEyes}</StatusChip>
              <label style={fieldStyle}>
                {T.edit.reasonLabel}
                <textarea
                  aria-label={T.edit.reasonLabel}
                  value={reason}
                  placeholder={T.edit.reasonPlaceholder}
                  onChange={(event) => { setReason(event.target.value); }}
                  style={textareaStyle}
                />
              </label>
              {error ? (
                <StatusChip tone="danger" role="alert">
                  {error}
                </StatusChip>
              ) : null}
              <div style={chipRowStyle}>
                <button type="button" data-window-control="true" onClick={submit} style={primaryButtonStyle}>
                  {T.edit.apply}
                </button>
                <button type="button" data-window-control="true" onClick={() => { setOpen(false); }} style={buttonStyle}>
                  {T.edit.cancel}
                </button>
              </div>
            </div>
          )
        ) : null}
      </div>
    </PolicyGated>
  );
}

// ── The card ──────────────────────────────────────────────────────────────

export interface ObjectCardProps {
  descriptor: ObjectCardDescriptor;
  handlers?: ObjectCardHandlers;
}

export function ObjectCard({ descriptor, handlers }: ObjectCardProps) {
  const editChip = descriptor.lifecycleState === "draft" ? T.edit.direct : T.edit.override;
  return (
    <article aria-label={T.panel(descriptor.title)} style={rootStyle}>
      <header style={headerStyle}>
        <div style={headerTopStyle}>
          <h2 style={titleStyle}>{descriptor.title}</h2>
          <span {...objDrag(descriptor.code, descriptor.title)} title={ko.console.window.dragRefOf(descriptor.title)} style={monoStyle}>
            {descriptor.code}
          </span>
        </div>
        <div style={chipRowStyle}>
          <StatusChip tone="neutral" ariaLabel={T.typeBadge(descriptor.objectType.title)}>
            {descriptor.objectType.title}
          </StatusChip>
          <StatusChip
            tone={lifecycleTone[descriptor.lifecycleState]}
            ariaLabel={T.lifecycleAria(T.lifecycle[descriptor.lifecycleState])}
          >
            {T.lifecycle[descriptor.lifecycleState]}
          </StatusChip>
          {descriptor.schemaVersion !== undefined ? (
            <StatusChip tone="info">{T.schema(descriptor.schemaVersion)}</StatusChip>
          ) : null}
          <PolicyGated action={OBJECT_CARD_ACTIONS.edit} resource={{ kind: "object", id: descriptor.id }}>
            <StatusChip tone="accent">{editChip}</StatusChip>
          </PolicyGated>
        </div>
      </header>

      {/* Semantic */}
      <div style={layerStyle}>
        <h3 style={layerHeadingStyle}>{T.layers.semantic}</h3>
        <PropertyList properties={descriptor.properties} />
        <Section title={T.sections.relations} count={descriptor.relations.length} labelledById="object-card-relations">
          <RelationList relations={descriptor.relations} onRemove={handlers?.onRelationRemove} />
        </Section>
        <Section title={T.sections.relationDraw} labelledById="object-card-relation-draw">
          <RelationDraw
            objectId={descriptor.id}
            onAdd={(draft) => handlers?.onRelationAdd?.(draft)}
            onResolveCode={handlers?.onResolveCode}
          />
        </Section>
      </div>

      {/* Kinetic */}
      <div style={layerStyle}>
        <h3 style={layerHeadingStyle}>{T.layers.kinetic}</h3>
        <Section title={T.sections.lifecycle} labelledById="object-card-lifecycle">
          <LifecycleStepper steps={descriptor.lifecycle} />
          <EditBar
            lifecycleState={descriptor.lifecycleState}
            objectId={descriptor.id}
            onEdit={handlers?.onEdit}
          />
        </Section>
        {descriptor.history.length > 0 ? (
          <Section title={T.sections.history} count={descriptor.history.length} labelledById="object-card-history">
            <HistoryTimeline history={descriptor.history} />
          </Section>
        ) : null}
        {descriptor.approvals && descriptor.approvals.length > 0 ? (
          <Section title={T.sections.approvals} count={descriptor.approvals.length} labelledById="object-card-approvals">
            <ApprovalLine approvals={descriptor.approvals} />
          </Section>
        ) : null}
      </div>

      {/* Dynamic */}
      <div style={layerStyle}>
        <h3 style={layerHeadingStyle}>{T.layers.dynamic}</h3>
        {descriptor.acting && descriptor.acting.length > 0 ? (
          <Section title={T.sections.acting} labelledById="object-card-acting">
            <ActingChips acting={descriptor.acting} onNavigate={handlers?.onActingChipClick} />
          </Section>
        ) : null}
        {descriptor.actions.length > 0 ? (
          <Section title={T.sections.actions} count={descriptor.actions.length} labelledById="object-card-actions">
            <ActionBar objectId={descriptor.id} actions={descriptor.actions} onAction={handlers?.onAction} />
          </Section>
        ) : null}
      </div>
    </article>
  );
}

/**
 * §4.7-3 default open gesture: turn a descriptor into a WindowEntry so a click
 * opens the card as the right pin — `windowManager.open(objectCardWindowEntry(d, h))`.
 */
export function objectCardWindowEntry(
  descriptor: ObjectCardDescriptor,
  handlers?: ObjectCardHandlers,
): WindowEntry {
  return {
    id: descriptor.id,
    title: descriptor.title,
    code: descriptor.code,
    render: () => <ObjectCard descriptor={descriptor} handlers={handlers} />,
  };
}

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "grid",
  placeItems: "start center",
  padding: "var(--sp-6)",
  overflowY: "auto",
  background: "color-mix(in srgb, var(--canvas) 86%, transparent)",
  zIndex: 60,
};

const modalPanelStyle: CSSProperties = {
  width: "min(100%, 620px)",
  borderRadius: "var(--radius-card)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  boxShadow: "var(--shadow-pop)",
};

/** Same surface as a centered modal (Escape / backdrop closes). */
export function ObjectCardModal({
  descriptor,
  handlers,
  onClose,
}: ObjectCardProps & { onClose: () => void }) {
  return (
    <div
      className="console"
      role="dialog"
      aria-modal="true"
      aria-label={T.dialog(descriptor.title)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onClick={onClose}
      style={modalOverlayStyle}
    >
      <div style={modalPanelStyle} onClick={(event) => { event.stopPropagation(); }}>
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "var(--sp-3) var(--sp-3) 0" }}>
          <button
            type="button"
            data-window-control="true"
            aria-label={ko.console.window.close}
            autoFocus
            onClick={onClose}
            style={buttonStyle}
          >
            {ko.console.window.close}
          </button>
        </div>
        <ObjectCard descriptor={descriptor} handlers={handlers} />
      </div>
    </div>
  );
}
