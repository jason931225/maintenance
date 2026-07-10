// §19 dashboard/console editor — 4-slot grid over a widget palette. The whole
// layout is ONE serializable config doc (benchmark §3b) held in state:
// 저장 = personal view, direct + audited comment (§3.9.0-①);
// 팀 배포 — 결재 = shared-layout deploy via AP- approval (stub prefill).
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { objectCardWindowEntry } from "../objectcard";
import { PolicyGated } from "../policy";
import { objDrag, useOptionalWindowManager } from "../window";
import { defaultDashboardDoc, drillRows, serializeDashboardDoc, setSlotWidget } from "./doc";
import type { ConfigConsoleStrings } from "./strings";
import {
  CONFIG_CONSOLE_ACTIONS,
  WIDGET_KINDS,
  type DashboardDoc,
  type DashboardSlot,
  type DrillFilter,
  type OntInstanceRow,
  type OntObjectTypeDef,
  type WidgetConfig,
  type WidgetKind,
} from "./types";
import { WidgetBody } from "./widgets";

const S: ConfigConsoleStrings = ko.console.configconsole;
const OBJECT_CARD_STRINGS = ko.console.objectcard;

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: "1px solid var(--signal)",
  background: "var(--signal)",
  // --signal (#f6b521) is theme-stable; pin a dark ink so the dark theme's
  // light --ink never lands on the yellow (WCAG 1.4.3).
  color: "#141a21",
};

const inputStyle: CSSProperties = {
  minHeight: 44,
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

const selectStyle: CSSProperties = { ...inputStyle, cursor: "pointer" };

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: "var(--sp-5)",
  alignItems: "start",
};

const slotStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  minHeight: 120,
};

const panelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
};

const kvRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
  fontSize: "var(--text-sm)",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--text-sm)",
  color: "var(--steel)",
  cursor: "grab",
};

// drill result row: real button (keyboard/AT operable, ≥44px) with objDrag on top
const objectButtonStyle: CSSProperties = {
  ...monoStyle,
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: "0 var(--sp-2)",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  cursor: "pointer",
};

function choiceProps(registry: readonly OntObjectTypeDef[], objectType: string) {
  return (
    registry
      .find((type) => type.key === objectType)
      ?.properties.filter((prop) => prop.type === "choice") ?? []
  );
}

function defaultWidget(registry: readonly OntObjectTypeDef[]): WidgetConfig {
  const first = registry.at(0);
  const groupBy = first ? choiceProps(registry, first.key).at(0)?.key : undefined;
  return {
    kind: "liveCount",
    objectType: first?.key ?? "",
    ...(groupBy !== undefined ? { groupBy } : {}),
  };
}

function convertWidget(
  widget: WidgetConfig,
  kind: WidgetKind,
  registry: readonly OntObjectTypeDef[],
): WidgetConfig {
  const objectType =
    widget.kind === "statBar"
      ? (widget.objectTypes.at(0) ?? registry.at(0)?.key ?? "")
      : widget.objectType;
  const firstChoice = choiceProps(registry, objectType).at(0)?.key;
  switch (kind) {
    case "liveCount":
      return { kind, objectType, ...(firstChoice !== undefined ? { groupBy: firstChoice } : {}) };
    case "statBar":
      return { kind, objectTypes: [objectType] };
    case "chart":
      return { kind, objectType, field: firstChoice ?? "" };
  }
}

function retargetWidget(
  widget: WidgetConfig,
  objectType: string,
  registry: readonly OntObjectTypeDef[],
): WidgetConfig {
  const firstChoice = choiceProps(registry, objectType).at(0)?.key;
  switch (widget.kind) {
    case "liveCount":
      return { ...widget, objectType, ...(firstChoice !== undefined ? { groupBy: firstChoice } : { groupBy: undefined }) };
    case "statBar":
      return widget;
    case "chart":
      return { ...widget, objectType, field: firstChoice ?? "" };
  }
}

function DrillPanel({
  filter,
  rows,
  registry,
  onOpen,
  onClose,
}: {
  filter: DrillFilter;
  rows: readonly OntInstanceRow[];
  registry: readonly OntObjectTypeDef[];
  onOpen: (row: OntInstanceRow) => void;
  onClose?: () => void;
}) {
  const matched = drillRows(rows, filter);
  const type = registry.find((entry) => entry.key === filter.objectType);
  const choice =
    filter.field !== undefined
      ? type?.properties
          .find((prop) => prop.key === filter.field)
          ?.config?.choices?.find((entry) => entry.id === filter.choiceId)
      : undefined;
  return (
    <article aria-label={S.drill.panelTitle} style={panelStyle}>
      <div style={headerRowStyle}>
        <StatusChip tone="neutral">{type?.title ?? filter.objectType}</StatusChip>
        {choice ? <StatusChip tone="info">{choice.name}</StatusChip> : null}
        <StatusChip tone="accent">{S.drill.countChip(matched.length)}</StatusChip>
        {onClose ? (
          <button
            type="button"
            aria-label={S.drill.close}
            style={{ ...buttonStyle, marginLeft: "auto" }}
            onClick={onClose}
          >
            {S.drill.close}
          </button>
        ) : null}
      </div>
      <ul aria-label={S.drill.listAria} style={{ display: "grid", gap: "var(--sp-2)", margin: 0, padding: 0, listStyle: "none" }}>
        {matched.map((row) => {
          const title = type?.title ?? row.objectType;
          return (
            <li key={row.id} style={kvRowStyle}>
              <button
                type="button"
                {...objDrag(row.code, title)}
                aria-label={S.drill.openObject(row.code)}
                title={ko.console.window.dragRefOf(row.code)}
                style={objectButtonStyle}
                onClick={() => {
                  onOpen(row);
                }}
              >
                {row.code}
              </button>
              <StatusChip tone={row.lifecycleState === "active" ? "ok" : "neutral"}>
                {OBJECT_CARD_STRINGS.lifecycle[row.lifecycleState]}
              </StatusChip>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

// wire-pending: HANDOFF §4 POST /api/v1/appr — no approvals-create endpoint in
// the OpenAPI yet (governance only exposes .../approvals/decide), so 상신 stays
// a prefill stub that flips the 결재 대기 chip; the panel content itself is the
// real serialized layout doc.
function DeployPrefillPanel({
  doc,
  onSubmit,
  onClose,
}: {
  doc: DashboardDoc;
  onSubmit: () => void;
  onClose?: () => void;
}) {
  const widgetCount = doc.slots.filter((slot) => slot.widget !== null).length;
  return (
    <article aria-label={S.deploy.panelTitle} style={panelStyle}>
      <div style={headerRowStyle}>
        <StatusChip tone="purple">{S.deploy.prefillCode}</StatusChip>
        {onClose ? (
          <button
            type="button"
            aria-label={S.deploy.close}
            style={{ ...buttonStyle, marginLeft: "auto" }}
            onClick={onClose}
          >
            {S.deploy.close}
          </button>
        ) : null}
      </div>
      <div style={kvRowStyle}>
        <span style={{ color: "var(--steel)" }}>{S.deploy.screenField}</span>
        <StatusChip tone="neutral">{S.deploy.screenValue}</StatusChip>
      </div>
      <div style={kvRowStyle}>
        <span style={{ color: "var(--steel)" }}>{S.deploy.versionField}</span>
        <StatusChip tone="info">{`v${String(doc.version)}`}</StatusChip>
      </div>
      <div style={kvRowStyle}>
        <span style={{ color: "var(--steel)" }}>{S.deploy.widgetsField}</span>
        <StatusChip tone="neutral">{S.deploy.widgetsValue(widgetCount)}</StatusChip>
      </div>
      <pre
        aria-label={S.deploy.docAria}
        style={{
          margin: 0,
          padding: "var(--sp-4)",
          border: "1px solid var(--border-soft)",
          borderRadius: "var(--radius)",
          background: "var(--muted)",
          color: "var(--steel)",
          fontSize: "var(--text-xs)",
          maxHeight: 220,
          overflow: "auto",
        }}
      >
        {serializeDashboardDoc(doc)}
      </pre>
      <button type="button" style={primaryButtonStyle} onClick={onSubmit}>
        {S.deploy.submit}
      </button>
    </article>
  );
}

function SlotConfig({
  slot,
  index,
  registry,
  onChange,
}: {
  slot: DashboardSlot;
  index: number;
  registry: readonly OntObjectTypeDef[];
  onChange: (widget: WidgetConfig | null) => void;
}) {
  const widget = slot.widget;
  if (!widget) return null;
  const n = index + 1;
  const enumProps =
    widget.kind === "statBar" ? [] : choiceProps(registry, widget.objectType);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
      <select
        aria-label={S.slot.presetAria(n)}
        value={widget.kind}
        style={selectStyle}
        onChange={(event) => {
          onChange(convertWidget(widget, event.target.value as WidgetKind, registry));
        }}
      >
        {WIDGET_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {S.presets[kind]}
          </option>
        ))}
      </select>
      {widget.kind === "statBar" ? (
        <div role="group" aria-label={S.slot.statTypesAria(n)} style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
          {registry.map((type) => {
            const selected = widget.objectTypes.includes(type.key);
            return (
              <button
                key={type.key}
                type="button"
                aria-pressed={selected}
                style={selected ? primaryButtonStyle : buttonStyle}
                onClick={() => {
                  const next = selected
                    ? widget.objectTypes.filter((key) => key !== type.key)
                    : [...widget.objectTypes, type.key];
                  onChange({ ...widget, objectTypes: next });
                }}
              >
                {type.title}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <select
            aria-label={S.slot.objectTypeAria(n)}
            value={widget.objectType}
            style={selectStyle}
            onChange={(event) => {
              onChange(retargetWidget(widget, event.target.value, registry));
            }}
          >
            {registry.map((type) => (
              <option key={type.key} value={type.key}>
                {type.title}
              </option>
            ))}
          </select>
          <select
            aria-label={S.slot.groupByAria(n)}
            value={widget.kind === "liveCount" ? (widget.groupBy ?? "") : widget.field}
            style={selectStyle}
            onChange={(event) => {
              const key = event.target.value;
              onChange(
                widget.kind === "liveCount"
                  ? { ...widget, ...(key === "" ? { groupBy: undefined } : { groupBy: key }) }
                  : { ...widget, field: key },
              );
            }}
          >
            {widget.kind === "liveCount" ? <option value="">{S.slot.groupByNone}</option> : null}
            {enumProps.map((prop) => (
              <option key={prop.key} value={prop.key}>
                {prop.title}
              </option>
            ))}
          </select>
        </>
      )}
      <button
        type="button"
        aria-label={S.slot.removeAria(n)}
        style={buttonStyle}
        onClick={() => { onChange(null); }}
      >
        {S.slot.remove}
      </button>
    </div>
  );
}

export interface DashboardEditorProps {
  /** GET /api/v1/ontology/object-types* (mapped) — the owning page loads it. */
  registry: readonly OntObjectTypeDef[];
  /** GET /api/v1/ontology/instances?type= rows; a refetch just swaps this prop. */
  rows: readonly OntInstanceRow[];
}

export function DashboardEditor({ registry, rows }: DashboardEditorProps) {
  const windowManager = useOptionalWindowManager();
  const [doc, setDoc] = useState<DashboardDoc>(defaultDashboardDoc);
  const [configMode, setConfigMode] = useState(false);
  const [comment, setComment] = useState("");
  const [savedView, setSavedView] = useState<string | null>(null);
  const [deployPending, setDeployPending] = useState(false);
  const [inlinePanel, setInlinePanel] = useState<ReactNode>(null);

  // §4.7-3: detail opens as a right pin; without a window shell (unit tests),
  // the same panel degrades to an inline aside.
  const openPanel = (id: string, title: string, render: () => ReactNode) => {
    if (windowManager) {
      windowManager.open({ id, title, render });
    } else {
      setInlinePanel(render());
    }
  };

  const closeInline = () => { setInlinePanel(null); };

  // §4.7-3: a drill result opens its ObjectCard as the right pin (inline
  // fallback without a window shell). The descriptor is built from the REAL
  // instance row (attributes + registry labels); sections the list payload
  // does not carry (relations/history) stay empty — omitted, never faked.
  const handleOpenObject = (row: OntInstanceRow) => {
    const type = registry.find((entry) => entry.key === row.objectType);
    const typeTitle = type?.title ?? row.objectType;
    const properties = (type?.properties ?? []).flatMap((prop) => {
      // == null also covers keys genuinely absent from the payload at runtime.
      const raw = row.attributes[prop.key];
      if (raw == null) return [];
      const value =
        prop.config?.choices?.find((choice) => choice.id === raw)?.name ?? String(raw);
      return [{ key: prop.key, title: prop.title, type: prop.type, value }];
    });
    const entry = objectCardWindowEntry({
      id: row.id,
      code: row.code,
      title: row.code,
      objectType: { key: row.objectType, title: typeTitle, ...(type ? { id: type.id } : {}) },
      lifecycleState: row.lifecycleState,
      properties,
      relations: [],
      lifecycle: [],
      history: [],
      actions: [],
    });
    if (windowManager) windowManager.open(entry);
    else setInlinePanel(entry.render());
  };

  const handleDrill = (filter: DrillFilter) => {
    const id = `configconsole-drill-${filter.objectType}-${filter.choiceId ?? "all"}`;
    openPanel(id, S.drill.panelTitle, () => (
      <DrillPanel
        filter={filter}
        rows={rows}
        registry={registry}
        onOpen={handleOpenObject}
        onClose={windowManager ? undefined : closeInline}
      />
    ));
  };

  const handleDeploy = () => {
    const snapshot = doc;
    const id = "configconsole-deploy";
    const submit = () => {
      setDeployPending(true);
      if (windowManager) windowManager.close(id);
      else setInlinePanel(null);
    };
    openPanel(id, S.deploy.panelTitle, () => (
      <DeployPrefillPanel
        doc={snapshot}
        onSubmit={submit}
        onClose={windowManager ? undefined : closeInline}
      />
    ));
  };

  const handleSave = () => {
    // §3.9.0-① personal view: direct save, comment is the audited change reason.
    // wire-pending: HANDOFF §4 PUT /api/v1/console/views/config-console — no
    // personal-view persistence endpoint in the OpenAPI yet; the doc saved here
    // is the real serialized layout (UI-created config, not display data).
    setSavedView(serializeDashboardDoc(doc));
    setComment("");
  };

  return (
    <section aria-label={S.screenAria} style={rootStyle}>
      <div style={headerRowStyle}>
        <StatusChip tone="neutral">{S.chips.personal}</StatusChip>
        {savedView !== null ? <StatusChip role="status" tone="ok">{S.chips.saved}</StatusChip> : null}
        {deployPending ? <StatusChip role="status" tone="purple">{S.chips.deployPending}</StatusChip> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", marginLeft: "auto", alignItems: "center" }}>
          <PolicyGated action={CONFIG_CONSOLE_ACTIONS.configure}>
            {configMode ? (
              <button type="button" style={buttonStyle} onClick={() => { setDoc(defaultDashboardDoc()); }}>
                {S.config.restore}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={S.config.toggleAria}
              aria-pressed={configMode}
              style={configMode ? primaryButtonStyle : buttonStyle}
              onClick={() => { setConfigMode((mode) => !mode); }}
            >
              {S.config.toggle}
            </button>
          </PolicyGated>
          <PolicyGated action={CONFIG_CONSOLE_ACTIONS.saveView}>
            <input
              aria-label={S.save.comment}
              placeholder={S.save.comment}
              value={comment}
              style={inputStyle}
              onChange={(event) => { setComment(event.target.value); }}
            />
            <button
              type="button"
              disabled={comment.trim() === ""}
              style={primaryButtonStyle}
              onClick={handleSave}
            >
              {S.save.action}
            </button>
          </PolicyGated>
          <PolicyGated action={CONFIG_CONSOLE_ACTIONS.deploy}>
            <button type="button" style={buttonStyle} onClick={handleDeploy}>
              {S.deploy.action}
            </button>
          </PolicyGated>
        </div>
      </div>

      <div style={gridStyle}>
        {doc.slots.map((slot, index) => (
          <section key={slot.id} aria-label={S.slot.aria(index + 1)} style={slotStyle}>
            {configMode ? (
              <SlotConfig
                slot={slot}
                index={index}
                registry={registry}
                onChange={(widget) => { setDoc((current) => setSlotWidget(current, slot.id, widget)); }}
              />
            ) : null}
            {slot.widget ? (
              <WidgetBody config={slot.widget} rows={rows} registry={registry} onDrill={handleDrill} />
            ) : (
              // §4-22 add-anything: every empty slot carries its in-place add path.
              <PolicyGated action={CONFIG_CONSOLE_ACTIONS.configure}>
                <button
                  type="button"
                  aria-label={S.slot.addAria(index + 1)}
                  style={{ ...buttonStyle, justifyContent: "center", minHeight: 64 }}
                  onClick={() => {
                    setDoc((current) => setSlotWidget(current, slot.id, defaultWidget(registry)));
                    setConfigMode(true);
                  }}
                >
                  {S.slot.add}
                </button>
              </PolicyGated>
            )}
          </section>
        ))}
      </div>

      {inlinePanel ? <aside>{inlinePanel}</aside> : null}
    </section>
  );
}
