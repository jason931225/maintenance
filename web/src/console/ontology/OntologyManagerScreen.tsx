import { useState, type CSSProperties, type ReactNode } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import {
  objectCardWindowEntry,
  type ObjectCardDescriptor,
  type ObjectLifecycleState,
  type StatusTone,
} from "../objectcard";
import { PolicyGated } from "../policy";
import { objDrag, useOptionalWindowManager } from "../window";
import "../tokens.css";
import {
  applySchemaEdit,
  approveRevision,
  committedOf,
  createDraftType,
  discardRevision,
  initialRegistryState,
  isStaged,
  schemaStageTone,
  viewOf,
  type RegistryState,
  type SchemaEdit,
} from "./model";
import { ontologyStrings, type OntologyManagerStrings } from "./strings";
import { lifecycleStepsOf } from "./wire";
import {
  ACTION_DISPATCHES,
  FIELD_KINDS,
  MANAGER_SUBTABS,
  ONTOLOGY_MANAGER_ACTIONS,
  ONT_CARDINALITIES,
  type ActionDispatch,
  type FieldKind,
  type ManagerSubtab,
  type OntCardinality,
  type OntInstanceRow,
  type OntObjectTypeDef,
} from "./types";

type SubmitEventLike = { preventDefault: () => void };

type OntologyChildKeyPrefix = "prop" | "link" | "action" | "analytic";

function newOntologyChildKey(prefix: OntologyChildKeyPrefix): string {
  const suffix = globalThis.crypto
    .randomUUID()
    .replaceAll("-", "")
    .toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(suffix)) {
    throw new Error("Unable to create ontology child identity");
  }
  return `${prefix}_${suffix}`;
}

const CONTROL_MIN = 44; // WCAG AA target size

const rootStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(240px, 320px) minmax(0, 1fr)",
  gap: "var(--sp-5)",
  alignItems: "start",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
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

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const monoStyle: CSSProperties = {
  color: "var(--faint)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const labelTextStyle: CSSProperties = {
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

const typeRowStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  width: "100%",
  minHeight: CONTROL_MIN,
  padding: "var(--sp-3)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  textAlign: "left",
  cursor: "pointer",
};

const typeRowActiveStyle: CSSProperties = {
  ...typeRowStyle,
  borderColor: "var(--signal)",
  background: "var(--accent-bg)",
};

const buttonStyle: CSSProperties = {
  minHeight: CONTROL_MIN,
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
  // --signal (#f6b521) is theme-stable; pin a dark ink so the dark theme's
  // light --ink never lands on the yellow (WCAG 1.4.3).
  color: "#141a21",
};

const inputStyle: CSSProperties = {
  minHeight: CONTROL_MIN,
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

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const addFormStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: "var(--sp-2)",
  alignItems: "end",
};

const stagingBannerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
  padding: "var(--sp-3) var(--sp-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--warn-bd)",
  background: "var(--warn-bg)",
};

const tabStyle: CSSProperties = {
  minHeight: CONTROL_MIN,
  padding: "0 var(--sp-4)",
  border: 0,
  borderBottom: "2px solid transparent",
  background: "transparent",
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  borderBottomColor: "var(--signal-deep)",
  color: "var(--ink)",
};

const defRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-3)",
  minHeight: CONTROL_MIN,
  padding: "var(--sp-2) var(--sp-3)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-soft)",
  background: "var(--surface)",
};

const instanceRowStyle: CSSProperties = {
  ...defRowStyle,
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
  color: "var(--ink)",
};

function instanceTone(state: ObjectLifecycleState): StatusTone {
  switch (state) {
    case "draft":
      return "neutral";
    case "active":
      return "ok";
    case "locked":
      return "warn";
    case "archived":
      return "info";
    case "disposed":
      return "danger";
  }
}

function EmptyChip({ T }: { T: OntologyManagerStrings }) {
  return <StatusChip tone="neutral">{T.empty}</StatusChip>;
}

function TypeRail({
  T,
  state,
  selectedId,
  onSelect,
  onCreate,
}: {
  T: OntologyManagerStrings;
  state: RegistryState;
  selectedId: string;
  onSelect: (id: string) => void;
  onCreate: (title: string) => void;
}) {
  const [draftTitle, setDraftTitle] = useState("");

  function handleSubmit(event: SubmitEventLike): void {
    event.preventDefault();
    if (draftTitle.trim().length === 0) return;
    onCreate(draftTitle);
    setDraftTitle("");
  }

  return (
    <aside aria-label={T.typeList.title} style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <h2 style={sectionTitleStyle}>{T.typeList.title}</h2>
        <StatusChip tone="neutral">{T.count(state.types.length)}</StatusChip>
      </div>
      <ol style={listStyle}>
        {state.types.map((type) => {
          const selected = type.id === selectedId;
          return (
            <li key={type.id}>
              <button
                type="button"
                {...objDrag(type.code, type.title)}
                aria-label={T.typeList.rowAria(type.code, type.title)}
                aria-current={selected ? "true" : undefined}
                title={ko.console.window.dragRefOf(type.title)}
                onClick={() => {
                  onSelect(type.id);
                }}
                style={selected ? typeRowActiveStyle : typeRowStyle}
              >
                <span style={monoStyle}>{type.code}</span>
                <span style={labelTextStyle}>{type.title}</span>
                <span style={chipRowStyle}>
                  <StatusChip tone={schemaStageTone(type.lifecycleState)}>
                    {T.stage[type.lifecycleState]}
                  </StatusChip>
                  <StatusChip tone="info">
                    {T.version(type.schemaVersion)}
                  </StatusChip>
                  <StatusChip tone="neutral">
                    {T.instanceCount(type.instances.length)}
                  </StatusChip>
                  {isStaged(state, type.id) ? (
                    <StatusChip tone="warn">{T.staging.pending}</StatusChip>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <PolicyGated
        action={ONTOLOGY_MANAGER_ACTIONS.typeCreate}
        resource={{ kind: "ontology_schema", id: "draft" }}
      >
        <form onSubmit={handleSubmit} style={addFormStyle}>
          <input
            aria-label={T.typeList.addName}
            value={draftTitle}
            onChange={(event) => {
              setDraftTitle(event.target.value);
            }}
            style={inputStyle}
          />
          <button type="submit" style={buttonStyle}>
            {T.typeList.addSubmit}
          </button>
        </form>
      </PolicyGated>
    </aside>
  );
}

function AddField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={fieldLabelStyle}>
      {label}
      {children}
    </label>
  );
}

function PropertyAddForm({
  T,
  onAdd,
}: {
  T: OntologyManagerStrings;
  onAdd: (edit: SchemaEdit) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<FieldKind>("text");

  function handleSubmit(event: SubmitEventLike): void {
    event.preventDefault();
    const title = name.trim();
    if (title.length === 0) return;
    onAdd({
      kind: "property",
      def: {
        key: newOntologyChildKey("prop"),
        title,
        type: kind,
        required: false,
      },
    });
    setName("");
  }

  return (
    <form onSubmit={handleSubmit} style={addFormStyle}>
      <AddField label={T.properties.addName}>
        <input
          aria-label={T.properties.addName}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          style={inputStyle}
        />
      </AddField>
      <AddField label={T.properties.addType}>
        <select
          aria-label={T.properties.addType}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as FieldKind);
          }}
          style={inputStyle}
        >
          {FIELD_KINDS.map((fieldKind) => (
            <option key={fieldKind} value={fieldKind}>
              {T.fieldKind[fieldKind]}
            </option>
          ))}
        </select>
      </AddField>
      <button type="submit" style={buttonStyle}>
        {T.properties.addSubmit}
      </button>
    </form>
  );
}

function PropertiesPanel({
  T,
  view,
  onAdd,
}: {
  T: OntologyManagerStrings;
  view: OntObjectTypeDef;
  onAdd: (edit: SchemaEdit) => void;
}) {
  return (
    <>
      {view.properties.length > 0 ? (
        <ol style={listStyle}>
          {view.properties.map((property) => (
            <li key={property.key} style={defRowStyle}>
              <span style={labelTextStyle}>{property.title}</span>
              <span style={monoStyle}>{property.key}</span>
              <span style={chipRowStyle}>
                <StatusChip tone="accent">
                  {T.fieldKind[property.type]}
                </StatusChip>
                {property.required ? (
                  <StatusChip tone="warn">{T.properties.required}</StatusChip>
                ) : null}
                {property.inPropertyPolicy ? (
                  <StatusChip tone="purple">{T.properties.policy}</StatusChip>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyChip T={T} />
      )}
      <PolicyGated
        action={ONTOLOGY_MANAGER_ACTIONS.schemaEdit}
        resource={{ kind: "ontology_schema", id: view.id }}
      >
        <PropertyAddForm T={T} onAdd={onAdd} />
      </PolicyGated>
    </>
  );
}

function LinkAddForm({
  T,
  types,
  onAdd,
}: {
  T: OntologyManagerStrings;
  types: OntObjectTypeDef[];
  onAdd: (edit: SchemaEdit) => void;
}) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState(types[0]?.stableKey ?? "");
  const [cardinality, setCardinality] = useState<OntCardinality>("one_many");

  function handleSubmit(event: SubmitEventLike): void {
    event.preventDefault();
    const title = name.trim();
    if (title.length === 0 || target.length === 0) return;
    onAdd({
      kind: "link",
      def: {
        stableKey: newOntologyChildKey("link"),
        title,
        toTypeKey: target,
        cardinality,
      },
    });
    setName("");
  }

  return (
    <form onSubmit={handleSubmit} style={addFormStyle}>
      <AddField label={T.links.addName}>
        <input
          aria-label={T.links.addName}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          style={inputStyle}
        />
      </AddField>
      <AddField label={T.links.addTarget}>
        <select
          aria-label={T.links.addTarget}
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
          style={inputStyle}
        >
          {types.map((type) => (
            <option key={type.stableKey} value={type.stableKey}>
              {type.code} · {type.title}
            </option>
          ))}
        </select>
      </AddField>
      <AddField label={T.links.addCardinality}>
        <select
          aria-label={T.links.addCardinality}
          value={cardinality}
          onChange={(event) => {
            setCardinality(event.target.value as OntCardinality);
          }}
          style={inputStyle}
        >
          {/* many_one is display-only sugar; the registry admits one_one|one_many|many_many. */}
          {ONT_CARDINALITIES.filter((option) => option !== "many_one").map(
            (option) => (
              <option key={option} value={option}>
                {T.cardinality[option]}
              </option>
            ),
          )}
        </select>
      </AddField>
      <button type="submit" style={buttonStyle}>
        {T.links.addSubmit}
      </button>
    </form>
  );
}

function LinksPanel({
  T,
  view,
  types,
  onAdd,
}: {
  T: OntologyManagerStrings;
  view: OntObjectTypeDef;
  types: OntObjectTypeDef[];
  onAdd: (edit: SchemaEdit) => void;
}) {
  return (
    <>
      {view.links.length > 0 ? (
        <ol style={listStyle}>
          {view.links.map((link) => {
            const target = types.find(
              (type) => type.stableKey === link.toTypeKey,
            );
            return (
              <li key={link.stableKey} style={defRowStyle}>
                <span style={labelTextStyle}>{link.title}</span>
                <span style={chipRowStyle}>
                  <StatusChip tone="info">
                    {target ? target.code : link.toTypeKey}
                  </StatusChip>
                  <StatusChip tone="neutral">
                    {target ? target.title : link.toTypeKey}
                  </StatusChip>
                  <StatusChip tone="accent">
                    {T.cardinality[link.cardinality]}
                  </StatusChip>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyChip T={T} />
      )}
      <PolicyGated
        action={ONTOLOGY_MANAGER_ACTIONS.schemaEdit}
        resource={{ kind: "ontology_schema", id: view.id }}
      >
        <LinkAddForm T={T} types={types} onAdd={onAdd} />
      </PolicyGated>
    </>
  );
}

function ActionAddForm({
  T,
  onAdd,
}: {
  T: OntologyManagerStrings;
  onAdd: (edit: SchemaEdit) => void;
}) {
  const [name, setName] = useState("");
  const [dispatch, setDispatch] = useState<ActionDispatch>("instance_revision");

  function handleSubmit(event: SubmitEventLike): void {
    event.preventDefault();
    const title = name.trim();
    if (title.length === 0) return;
    onAdd({
      kind: "action",
      def: { stableKey: newOntologyChildKey("action"), title, dispatch },
    });
    setName("");
  }

  return (
    <form onSubmit={handleSubmit} style={addFormStyle}>
      <AddField label={T.actionEditor.addName}>
        <input
          aria-label={T.actionEditor.addName}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          style={inputStyle}
        />
      </AddField>
      <AddField label={T.actionEditor.addDispatch}>
        <select
          aria-label={T.actionEditor.addDispatch}
          value={dispatch}
          onChange={(event) => {
            setDispatch(event.target.value as ActionDispatch);
          }}
          style={inputStyle}
        >
          {ACTION_DISPATCHES.map((option) => (
            <option key={option} value={option}>
              {T.dispatch[option]}
            </option>
          ))}
        </select>
      </AddField>
      <button type="submit" style={buttonStyle}>
        {T.actionEditor.addSubmit}
      </button>
    </form>
  );
}

function ActionsPanel({
  T,
  view,
  onAdd,
}: {
  T: OntologyManagerStrings;
  view: OntObjectTypeDef;
  onAdd: (edit: SchemaEdit) => void;
}) {
  return (
    <>
      {view.actions.length > 0 ? (
        <ol style={listStyle}>
          {view.actions.map((action) => (
            <li key={action.stableKey} style={defRowStyle}>
              <span style={labelTextStyle}>{action.title}</span>
              <span style={monoStyle}>{action.stableKey}</span>
              <StatusChip tone="accent">
                {T.dispatch[action.dispatch]}
              </StatusChip>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyChip T={T} />
      )}
      <PolicyGated
        action={ONTOLOGY_MANAGER_ACTIONS.schemaEdit}
        resource={{ kind: "ontology_schema", id: view.id }}
      >
        <ActionAddForm T={T} onAdd={onAdd} />
      </PolicyGated>
    </>
  );
}

function AnalyticAddForm({
  T,
  onAdd,
}: {
  T: OntologyManagerStrings;
  onAdd: (edit: SchemaEdit) => void;
}) {
  const [name, setName] = useState("");
  const [formula, setFormula] = useState("");

  function handleSubmit(event: SubmitEventLike): void {
    event.preventDefault();
    const title = name.trim();
    const expression = formula.trim();
    if (title.length === 0 || expression.length === 0) return;
    onAdd({
      kind: "analytic",
      def: { key: newOntologyChildKey("analytic"), title, formula: expression },
    });
    setName("");
    setFormula("");
  }

  return (
    <form onSubmit={handleSubmit} style={addFormStyle}>
      <AddField label={T.analyticEditor.addName}>
        <input
          aria-label={T.analyticEditor.addName}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          style={inputStyle}
        />
      </AddField>
      <AddField label={T.analyticEditor.addFormula}>
        <input
          aria-label={T.analyticEditor.addFormula}
          value={formula}
          onChange={(event) => {
            setFormula(event.target.value);
          }}
          style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
        />
      </AddField>
      <button type="submit" style={buttonStyle}>
        {T.analyticEditor.addSubmit}
      </button>
    </form>
  );
}

function AnalyticsPanel({
  T,
  view,
  onAdd,
}: {
  T: OntologyManagerStrings;
  view: OntObjectTypeDef;
  onAdd: (edit: SchemaEdit) => void;
}) {
  return (
    <>
      {view.analytics.length > 0 ? (
        <ol style={listStyle}>
          {view.analytics.map((analytic) => (
            <li key={analytic.key} style={defRowStyle}>
              <span style={labelTextStyle}>{analytic.title}</span>
              <span style={monoStyle}>{analytic.formula}</span>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyChip T={T} />
      )}
      <PolicyGated
        action={ONTOLOGY_MANAGER_ACTIONS.schemaEdit}
        resource={{ kind: "ontology_schema", id: view.id }}
      >
        <AnalyticAddForm T={T} onAdd={onAdd} />
      </PolicyGated>
    </>
  );
}

function InstanceRowContent({ row }: { row: OntInstanceRow }) {
  const lifecycle = ko.console.objectcard.lifecycle[row.lifecycleState];
  return (
    <>
      <span style={monoStyle}>{row.code}</span>
      <span style={labelTextStyle}>{row.title}</span>
      <StatusChip tone={instanceTone(row.lifecycleState)}>
        {lifecycle}
      </StatusChip>
    </>
  );
}

function InstancesPanel({
  T,
  view,
  onOpen,
}: {
  T: OntologyManagerStrings;
  view: OntObjectTypeDef;
  onOpen: (row: OntInstanceRow) => void;
}) {
  if (view.instances.length === 0) return <EmptyChip T={T} />;
  return (
    <ol style={listStyle}>
      {view.instances.map((row) => (
        <li key={row.id}>
          <PolicyGated
            action={ONTOLOGY_MANAGER_ACTIONS.instanceOpen}
            resource={{ kind: "object", id: row.id }}
            fallback={
              <span
                {...objDrag(row.code, row.title)}
                title={ko.console.window.dragRefOf(row.title)}
                style={defRowStyle}
              >
                <InstanceRowContent row={row} />
              </span>
            }
          >
            <button
              type="button"
              {...objDrag(row.code, row.title)}
              aria-label={T.instances.rowAria(row.code)}
              title={ko.console.window.dragRefOf(row.title)}
              onClick={() => {
                onOpen(row);
              }}
              style={instanceRowStyle}
            >
              <InstanceRowContent row={row} />
            </button>
          </PolicyGated>
        </li>
      ))}
    </ol>
  );
}

function AutomationsPanel({
  T,
  view,
}: {
  T: OntologyManagerStrings;
  view: OntObjectTypeDef;
}) {
  if (view.acting.length === 0) return <EmptyChip T={T} />;
  return (
    <ol style={listStyle}>
      {view.acting.map((rule) => (
        <li key={rule.id} style={defRowStyle}>
          <StatusChip
            tone={
              rule.kind === "automation"
                ? "accent"
                : rule.kind === "policy"
                  ? "purple"
                  : "info"
            }
          >
            {ko.console.objectcard.acting[rule.kind]}
          </StatusChip>
          <span style={monoStyle}>{rule.label}</span>
        </li>
      ))}
    </ol>
  );
}

export interface OntologyManagerScreenProps {
  /** API-loaded registry (OntologyPage supplies it); absent = empty registry. */
  registry?: OntObjectTypeDef[];
  initialTypeId?: string;
  /** POST /ontology/object-types — the host creates the draft then reloads. */
  onCreateType?: (title: string) => Promise<void> | void;
  /**
   * PUT /ontology/object-types/{key} — the host stages the accumulated edits
   * as a v+1 revision then reloads. Rejection keeps the 개정 대기 banner up.
   */
  onCommitRevision?: (staged: OntObjectTypeDef) => Promise<void>;
  /** GET /ontology/instances/{id} (+history/traverse) → the full card payload. */
  resolveInstanceCard?: (
    row: OntInstanceRow,
  ) => Promise<ObjectCardDescriptor | undefined>;
}

/** Card payload from registry data alone (used when the full read fails). */
function instanceCardFallback(
  row: OntInstanceRow,
  view: OntObjectTypeDef,
): ObjectCardDescriptor {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    objectType: { key: view.stableKey, title: view.title },
    lifecycleState: row.lifecycleState,
    schemaVersion: view.schemaVersion,
    properties: [],
    relations: [],
    lifecycle: lifecycleStepsOf(row.lifecycleState),
    history: [],
    actions: view.actions.map((action) => ({
      key: action.stableKey,
      title: action.title,
    })),
  };
}

/**
 * 매니저 tab workspace (design change-log 63): left = type list (stage · version ·
 * instance count, objDrag sources, inline add), center = type editor with the
 * 속성/관계/액션/분석/인스턴스/자동화 subtabs. Editing a non-draft type stages a
 * v+1 revision behind the 개정 대기 banner (적용 승인 four-eyes / 철회, §3.9.0);
 * drafts edit direct.
 */
export function OntologyManagerScreen({
  registry,
  initialTypeId,
  onCreateType,
  onCommitRevision,
  resolveInstanceCard,
}: OntologyManagerScreenProps) {
  const T = ontologyStrings();
  const windowManager = useOptionalWindowManager();
  const [state, setState] = useState<RegistryState>(() =>
    initialRegistryState(registry ?? []),
  );
  const [selectedId, setSelectedId] = useState(
    initialTypeId ?? state.types.at(0)?.id ?? "",
  );
  const [subtab, setSubtab] = useState<ManagerSubtab>("properties");

  // The host reloads the registry after each committed mutation; adopt the
  // fresh payload during render (drops the just-committed staging copy by
  // design — the React "adjust state on prop change" pattern, no effect).
  const [syncedRegistry, setSyncedRegistry] = useState(registry);
  if (registry !== syncedRegistry) {
    setSyncedRegistry(registry);
    const next = registry ?? [];
    setState(initialRegistryState(next));
    if (!next.some((type) => type.id === selectedId)) {
      setSelectedId(next.at(0)?.id ?? "");
    }
  }

  const view = viewOf(state, selectedId);
  const committed = committedOf(state, selectedId);
  const staged = isStaged(state, selectedId);

  function handleEdit(edit: SchemaEdit): void {
    const editingDraft =
      committedOf(state, selectedId)?.lifecycleState === "draft";
    const nextState = applySchemaEdit(state, selectedId, edit);
    setState(nextState);
    // A draft edits in place: persist the appended definition immediately via
    // PUT /object-types/{key}, which appends the new child to the in-flight
    // draft (§9.8 append-only) and reloads the registry. A non-draft edit
    // accumulates on the staged v+1 copy and persists on 적용 승인 instead.
    if (editingDraft && onCommitRevision) {
      const editedDraft = viewOf(nextState, selectedId);
      if (editedDraft) {
        try {
          void onCommitRevision(editedDraft).catch(() => {
            // The host surfaces the failure; local accumulated edits stay visible.
          });
        } catch {
          // Match an asynchronously rejected host callback.
        }
      }
    }
  }

  function handleTypeCreate(title: string): void {
    if (onCreateType) {
      void onCreateType(title);
      return;
    }
    setState((current) => {
      const result = createDraftType(current, title);
      if (result.created) setSelectedId(result.created.id);
      return result.state;
    });
  }

  async function handleApproveRevision(): Promise<void> {
    if (onCommitRevision) {
      const stagedView = viewOf(state, selectedId);
      if (!stagedView) return;
      try {
        await onCommitRevision(stagedView);
      } catch {
        // Host surfaces the failure; the staged banner stays for retry/철회.
        return;
      }
    }
    setState((current) => approveRevision(current, selectedId));
  }

  async function openInstance(row: OntInstanceRow): Promise<void> {
    if (!view || !windowManager) return;
    // §4.7-3 default gesture: the instance opens as the right pin panel, with
    // the card payload read from GET /ontology/instances/{id} (+history).
    let descriptor: ObjectCardDescriptor;
    try {
      if (resolveInstanceCard) {
        const resolved = await resolveInstanceCard(row);
        if (!resolved) return;
        descriptor = resolved;
      } else {
        descriptor = instanceCardFallback(row, view);
      }
    } catch {
      descriptor = instanceCardFallback(row, view);
    }
    windowManager.open(objectCardWindowEntry(descriptor));
  }

  return (
    <div className="console" style={rootStyle}>
      <TypeRail
        T={T}
        state={state}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={handleTypeCreate}
      />

      {view && committed ? (
        <article aria-label={view.title} style={cardStyle}>
          <header style={sectionHeaderStyle}>
            <span style={chipRowStyle}>
              <span style={monoStyle}>{view.code}</span>
              <h2 style={sectionTitleStyle}>{view.title}</h2>
            </span>
            <span style={chipRowStyle}>
              <StatusChip tone={schemaStageTone(committed.lifecycleState)}>
                {T.stage[committed.lifecycleState]}
              </StatusChip>
              <StatusChip tone="info">
                {T.version(committed.schemaVersion)}
              </StatusChip>
              <StatusChip tone="neutral">
                {T.backing[view.backingKind]}
              </StatusChip>
            </span>
          </header>

          {staged ? (
            <section
              role="status"
              aria-label={T.staging.pending}
              style={stagingBannerStyle}
            >
              <span style={chipRowStyle}>
                <StatusChip tone="warn">{T.staging.pending}</StatusChip>
                <StatusChip tone="info">
                  {T.stagedVersion(committed.schemaVersion + 1)}
                </StatusChip>
                <StatusChip tone="purple">{T.staging.fourEyes}</StatusChip>
              </span>
              <span style={chipRowStyle}>
                <PolicyGated
                  action={ONTOLOGY_MANAGER_ACTIONS.revisionApprove}
                  resource={{ kind: "ontology_schema", id: view.id }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      void handleApproveRevision();
                    }}
                    style={primaryButtonStyle}
                  >
                    {T.staging.approve}
                  </button>
                </PolicyGated>
                <PolicyGated
                  action={ONTOLOGY_MANAGER_ACTIONS.revisionDiscard}
                  resource={{ kind: "ontology_schema", id: view.id }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setState((current) =>
                        discardRevision(current, selectedId),
                      );
                    }}
                    style={buttonStyle}
                  >
                    {T.staging.discard}
                  </button>
                </PolicyGated>
              </span>
            </section>
          ) : null}

          <div
            role="tablist"
            aria-label={T.subtabsAria}
            style={{
              display: "flex",
              flexWrap: "wrap",
              borderBottom: "1px solid var(--border)",
            }}
          >
            {MANAGER_SUBTABS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`ontology-manager-tab-${key}`}
                aria-selected={subtab === key}
                aria-controls={`ontology-manager-panel-${key}`}
                onClick={() => {
                  setSubtab(key);
                }}
                style={subtab === key ? tabActiveStyle : tabStyle}
              >
                {T.subtabs[key]}
              </button>
            ))}
          </div>

          <section
            role="tabpanel"
            id={`ontology-manager-panel-${subtab}`}
            aria-labelledby={`ontology-manager-tab-${subtab}`}
            style={{ display: "grid", gap: "var(--sp-4)" }}
          >
            {subtab === "properties" ? (
              <PropertiesPanel T={T} view={view} onAdd={handleEdit} />
            ) : null}
            {subtab === "links" ? (
              <LinksPanel
                T={T}
                view={view}
                types={state.types}
                onAdd={handleEdit}
              />
            ) : null}
            {subtab === "actions" ? (
              <ActionsPanel T={T} view={view} onAdd={handleEdit} />
            ) : null}
            {subtab === "analytics" ? (
              <AnalyticsPanel T={T} view={view} onAdd={handleEdit} />
            ) : null}
            {subtab === "instances" ? (
              <InstancesPanel
                T={T}
                view={view}
                onOpen={(row) => {
                  void openInstance(row);
                }}
              />
            ) : null}
            {subtab === "automations" ? (
              <AutomationsPanel T={T} view={view} />
            ) : null}
          </section>
        </article>
      ) : null}
    </div>
  );
}
