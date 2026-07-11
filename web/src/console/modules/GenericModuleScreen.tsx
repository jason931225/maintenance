import { useCallback, useEffect, useMemo, useReducer, useState, type CSSProperties, type ReactNode } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { ObjectCardModal, objectCardWindowEntry } from "../objectcard";
import { PolicyGated, usePolicyGate } from "../policy";
import { objDrag, useOptionalWindowManager } from "../window";
import "../tokens.css";
import {
  columnVariantFor,
  detailVariantFor,
  getObjectType,
  getProperty,
  propChoices,
  resolveText,
  rowCardDescriptor,
  typeCardDescriptor,
  type OntChoice,
  type OntObjectType,
} from "./typeRegistry";
import type {
  ModuleActionConfig,
  ModuleBalanceCheckValue,
  ModuleChipTone,
  ModuleColumnConfig,
  ModuleDetailFieldConfig,
  ModuleDetailValue,
  ModuleGraphValue,
  ModuleLedgerValue,
  ModuleLinkChipValue,
  ModuleListDisplay,
  ModuleRow,
  ModuleScreenConfig,
  ModuleStatConfig,
  ModuleStatValue,
  ModuleStepperValue,
  ModuleTimelineValue,
} from "./types";

const T = ko.console.modules.common;

const rootStyle: CSSProperties = {
  minHeight: "100%",
  display: "grid",
  // Pack rows at the top: with minHeight 100% and implicit auto rows, the grid's
  // default align-content stretches the tracks to fill the tall canvas, opening
  // a phantom band between the header and the stat chips (verdict R9). Start-pack
  // keeps sections at their natural spacing.
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
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
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

const navStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const navLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-pill)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  textDecoration: "none",
};

const actionButtonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--signal)",
  background: "var(--signal)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const bodyGridStyle: CSSProperties = {
  display: "grid",
  // Detail pane is wide enough that voucher ids (VC-…) and GL account codes
  // (GL-2026-0003, "5104, 1102") no longer wrap mid-token in the key/value rows.
  gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 420px)",
  gap: "var(--sp-5)",
  alignItems: "start",
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

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const thStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
  textAlign: "left",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  verticalAlign: "middle",
  // Code/identifier cells (전표 코드 GL-2026-0003) must not wrap to one char per
  // line when the master-detail split shrinks the list track (minmax(0,1fr));
  // the tableWrap's overflowX:auto scrolls instead. thStyle already nowraps.
  whiteSpace: "nowrap",
};

const rowButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  border: "0",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  width: "100%",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const kvGridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
};

const kvRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(80px, 0.42fr) minmax(0, 1fr)",
  gap: "var(--sp-2)",
  alignItems: "center",
};

const kvKeyStyle: CSSProperties = {
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const kvValueStyle: CSSProperties = {
  minWidth: 0,
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: "var(--fw-strong)",
  // Identifiers (voucher no, GL codes, post timestamp) are atomic — never break
  // "GL-2026-0003" into "GL-202 6- 000 3"; the row/panel gives them the width.
  whiteSpace: "nowrap",
};

const ghostButtonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const detailStackStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
};

const detailPanelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
  background: "var(--muted)",
};

const timelineListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const timelineItemStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "var(--sp-3) minmax(0, 1fr)",
  gap: "var(--sp-2)",
  alignItems: "start",
};

const timelineDotStyle: CSSProperties = {
  width: "var(--sp-2)",
  height: "var(--sp-2)",
  marginTop: "var(--sp-2)",
  borderRadius: "var(--radius-pill)",
  border: "1px solid var(--timeline-dot-bd)",
  background: "var(--timeline-dot-bg)",
};

const graphGridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
};

const graphNodeStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
  background: "var(--surface)",
};

const edgeListStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const typeChipButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  border: 0,
  background: "transparent",
  padding: 0,
  cursor: "pointer",
};

const laneBoardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  alignItems: "start",
};

const laneStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
  background: "var(--muted)",
};

const laneListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

function laneCardStyle(selected: boolean): CSSProperties {
  return {
    width: "100%",
    display: "grid",
    gap: "var(--sp-1)",
    minHeight: 44,
    padding: "var(--sp-3)",
    border: `1px solid ${selected ? "var(--signal)" : "var(--border)"}`,
    borderRadius: "var(--radius-md)",
    background: "var(--surface)",
    color: "var(--ink)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--fw-body)",
    textAlign: "left",
    cursor: "pointer",
  };
}

function viewToggleStyle(pressed: boolean): CSSProperties {
  return {
    ...ghostButtonStyle,
    borderColor: pressed ? "var(--signal)" : "var(--border)",
  };
}

function isBackendBlocked(config: ModuleScreenConfig): boolean {
  return config.emptyMode === "blocked-until-backend";
}

function visibleStats(
  config: ModuleScreenConfig,
  statValues: Record<string, ModuleStatValue | undefined>,
): ModuleStatConfig[] {
  const resolved = config.statbar.map((stat) => ({
    ...stat,
    value: statValues[stat.key] ?? stat.value,
  }));
  if (isBackendBlocked(config)) {
    return resolved.filter((stat) => !stat.requiresBackend && stat.value !== undefined);
  }
  return resolved.filter((stat) => stat.value !== undefined || !stat.requiresBackend);
}

function formatCellValue(value: string | number | undefined): string {
  if (value === undefined || value === "") return "—";
  return String(value);
}

function isScalarDetailValue(value: ModuleDetailValue): value is string | number | undefined {
  return value === undefined || typeof value === "string" || typeof value === "number";
}

function cellStyle(column: ModuleColumnConfig): CSSProperties {
  const numeric = column.align === "end";
  return {
    ...tdStyle,
    textAlign: numeric ? "right" : "left",
    // Money/count columns must never wrap mid-number ("620,\n000"); keep the
    // formatted amount on one line (verdict R9).
    ...(numeric ? { whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" } : {}),
  };
}

function headerCellStyle(column: ModuleColumnConfig): CSSProperties {
  return {
    ...thStyle,
    textAlign: column.align === "end" ? "right" : "left",
  };
}

function resourceFor(config: ModuleScreenConfig, row?: ModuleRow) {
  return row ? { kind: config.objectKind, id: row.id } : { kind: config.objectKind };
}

function actionResourceFor(
  config: ModuleScreenConfig,
  actionResourceKind: string | undefined,
  row?: ModuleRow,
) {
  const kind = actionResourceKind ?? config.objectKind;
  return row ? { kind, id: row.id } : { kind };
}

function LinkChip({ chip }: { chip: ModuleLinkChipValue }) {
  const label = resolveText(chip.labelKey);
  const ariaLabel = chip.code ? `${label} ${chip.code}` : label;
  const content = <StatusChip tone={chip.tone ?? "info"}>{chip.code ?? label}</StatusChip>;
  return (
    <PolicyGated action={chip.policyAction} resource={{ kind: chip.kind, id: chip.id }}>
      {chip.href ? (
        <a href={chip.href} style={{ color: "inherit", textDecoration: "none" }} aria-label={ariaLabel}>
          {content}
        </a>
      ) : (
        content
      )}
    </PolicyGated>
  );
}

function isTimelineValue(value: ModuleDetailValue): value is ModuleTimelineValue {
  return Boolean(value && typeof value === "object" && "events" in value);
}

function isGraphValue(value: ModuleDetailValue): value is ModuleGraphValue {
  return Boolean(value && typeof value === "object" && "nodes" in value && "edges" in value);
}

function isLedgerValue(value: ModuleDetailValue): value is ModuleLedgerValue {
  return Boolean(value && typeof value === "object" && "entries" in value);
}

function isStepperValue(value: ModuleDetailValue): value is ModuleStepperValue {
  return Boolean(value && typeof value === "object" && "steps" in value);
}

function isBalanceCheckValue(value: ModuleDetailValue): value is ModuleBalanceCheckValue {
  return Boolean(value && typeof value === "object" && "status" in value);
}

const stepperToneByState: Record<ModuleStepperValue["steps"][number]["state"], ModuleChipTone> = {
  done: "ok",
  current: "info",
  blocked: "danger",
  pending: "neutral",
};

function renderLinkedContent(content: ReactNode, href: string | undefined, ariaLabel: string) {
  return href ? (
    <a href={href} style={{ color: "inherit", textDecoration: "none" }} aria-label={ariaLabel}>
      {content}
    </a>
  ) : (
    content
  );
}

function renderTimeline(value: ModuleTimelineValue): ReactNode {
  if (value.events.length === 0) return "—";
  return (
    <ol style={timelineListStyle}>
      {value.events.map((event) => {
        const content = (
          <span style={detailPanelStyle}>
            <span style={{ ...chipRowStyle, alignItems: "center" }}>
              <StatusChip tone={event.tone ?? "info"}>{event.kind ?? event.label}</StatusChip>
              {event.occurredAt ? <span style={kvKeyStyle}>{event.occurredAt}</span> : null}
            </span>
            <span style={kvValueStyle}>{event.label}</span>
            {event.description ? <span style={kvKeyStyle}>{event.description}</span> : null}
          </span>
        );
        return (
          <li key={event.id} style={timelineItemStyle}>
            <span aria-hidden="true" style={timelineDotStyle} />
            {renderLinkedContent(content, event.href, event.label)}
          </li>
        );
      })}
    </ol>
  );
}

function renderGraph(value: ModuleGraphValue): ReactNode {
  if (value.nodes.length === 0 && value.edges.length === 0) return "—";
  return (
    <span style={detailStackStyle}>
      {value.nodes.length > 0 ? (
        <span style={graphGridStyle}>
          {value.nodes.map((node) => {
            const content = (
              <span style={graphNodeStyle}>
                <span style={kvValueStyle}>{node.label}</span>
                {node.subtitle ? <span style={kvKeyStyle}>{node.subtitle}</span> : null}
                <span style={chipRowStyle}>
                  <StatusChip tone="neutral">{node.kind}</StatusChip>
                  {node.current ? <StatusChip tone="ok">{T.current}</StatusChip> : null}
                </span>
              </span>
            );
            return <span key={node.id}>{renderLinkedContent(content, node.href, node.label)}</span>;
          })}
        </span>
      ) : null}
      {value.edges.length > 0 ? (
        <ul style={edgeListStyle}>
          {value.edges.map((edge) => (
            <li key={edge.id}>
              <StatusChip tone="neutral">{edge.label}</StatusChip>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}

function renderLedger(value: ModuleLedgerValue): ReactNode {
  if (value.entries.length === 0 && value.total === undefined) return "—";
  return (
    <span style={detailStackStyle}>
      {value.total !== undefined ? <StatusChip tone="info">{formatCellValue(value.total)}</StatusChip> : null}
      {value.entries.length > 0 ? (
        <span style={detailStackStyle}>
          {value.entries.map((entry) => {
            const content = (
              <span style={detailPanelStyle}>
                <span style={{ ...chipRowStyle, alignItems: "center" }}>
                  {entry.sourceLabelKey ? (
                    <StatusChip tone={entry.tone ?? "neutral"}>{resolveText(entry.sourceLabelKey)}</StatusChip>
                  ) : null}
                  {entry.amount !== undefined ? <StatusChip tone="info">{formatCellValue(entry.amount)}</StatusChip> : null}
                </span>
                <span style={kvValueStyle}>{entry.label}</span>
                {entry.meta ? <span style={kvKeyStyle}>{entry.meta}</span> : null}
              </span>
            );
            return <span key={entry.id}>{renderLinkedContent(content, entry.href, entry.label)}</span>;
          })}
        </span>
      ) : null}
    </span>
  );
}

function renderStepper(value: ModuleStepperValue): ReactNode {
  if (value.steps.length === 0) return "—";
  return (
    <ol style={{ ...chipRowStyle, margin: 0, padding: 0, listStyle: "none" }}>
      {value.steps.map((step, index) => (
        <li key={step.key} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <StatusChip tone={stepperToneByState[step.state]}>{resolveText(step.labelKey)}</StatusChip>
          {step.reasonKey ? <span style={kvKeyStyle}>{resolveText(step.reasonKey)}</span> : null}
          {index < value.steps.length - 1 ? <span aria-hidden="true" style={kvKeyStyle}>→</span> : null}
        </li>
      ))}
    </ol>
  );
}

function renderBalanceCheck(value: ModuleBalanceCheckValue): ReactNode {
  return (
    <span style={{ ...chipRowStyle, alignItems: "center" }} role={value.status === "blocked" ? "alert" : "status"}>
      <StatusChip tone={value.status === "ok" ? "ok" : "danger"}>
        {resolveText(value.status === "ok" ? value.okLabelKey : value.blockedLabelKey)}
      </StatusChip>
      {value.totalDebit !== undefined ? (
        <span style={kvKeyStyle}>
          {value.totalDebitLabelKey ? resolveText(value.totalDebitLabelKey) : null} {formatCellValue(value.totalDebit)}
        </span>
      ) : null}
      {value.totalCredit !== undefined ? (
        <span style={kvKeyStyle}>
          {value.totalCreditLabelKey ? resolveText(value.totalCreditLabelKey) : null} {formatCellValue(value.totalCredit)}
        </span>
      ) : null}
      {value.reasonKey ? <span style={kvKeyStyle}>{resolveText(value.reasonKey)}</span> : null}
    </span>
  );
}

function renderDetailValue(field: ModuleDetailFieldConfig, value: ModuleDetailValue): ReactNode {
  if (field.variant === "timeline" && isTimelineValue(value)) return renderTimeline(value);
  if (field.variant === "graph" && isGraphValue(value)) return renderGraph(value);
  if (field.variant === "ledger" && isLedgerValue(value)) return renderLedger(value);
  if (field.variant === "stepper" && isStepperValue(value)) return renderStepper(value);
  if (field.variant === "balanceCheck" && isBalanceCheckValue(value)) return renderBalanceCheck(value);
  return formatCellValue(isScalarDetailValue(value) ? value : undefined);
}

function renderCell(
  config: ModuleScreenConfig,
  row: ModuleRow,
  column: ModuleColumnConfig,
  onSelect: () => void,
): ReactNode {
  if (column.variant === "status") {
    return row.status ? <StatusChip tone={row.status.tone}>{resolveText(row.status.labelKey)}</StatusChip> : "—";
  }
  if (column.variant === "source") {
    if (!row.source) return "—";
    const label = resolveText(row.source.labelKey);
    const chip = <StatusChip tone={row.source.tone}>{row.source.code ?? label}</StatusChip>;
    const ariaLabel = row.source.code ? `${label} ${row.source.code}` : label;
    return (
      <PolicyGated action={row.source.policyAction} resource={{ kind: row.source.kind, id: row.source.id }}>
        {row.source.href ? (
          <a href={row.source.href} style={{ color: "inherit", textDecoration: "none" }} aria-label={ariaLabel}>
            {chip}
          </a>
        ) : (
          chip
        )}
      </PolicyGated>
    );
  }
  if (column.variant === "linkChips") {
    return row.linkChips && row.linkChips.length > 0 ? (
      <span style={chipRowStyle}>
        {row.linkChips.map((chip) => (
          <LinkChip key={chip.key} chip={chip} />
        ))}
      </span>
    ) : (
      "—"
    );
  }
  const value = column.key === "code" ? row.code : row.cells[column.key];
  const content = formatCellValue(value);
  if (column.key === "code") {
    return (
      <PolicyGated action={config.policy.read} resource={resourceFor(config, row)}>
        <button
          type="button"
          {...objDrag(row.code, row.title ?? row.code)}
          style={rowButtonStyle}
          aria-label={T.rowDetail(content)}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
        >
          {content}
        </button>
      </PolicyGated>
    );
  }
  return <span style={column.variant === "mono" ? monoStyle : undefined}>{content}</span>;
}

/** §4.7-3 bound-type chip: OT- code opens the type's ObjectCard (right pin). */
function TypeChip({ type }: { type: OntObjectType }) {
  const windowManager = useOptionalWindowManager();
  const [modalOpen, setModalOpen] = useState(false);
  const ariaLabel = `${type.code} ${resolveText("console.modules.common.openTypeCard")}`;
  return (
    <>
      <button
        type="button"
        {...objDrag(type.code, resolveText(type.nameKey))}
        aria-label={ariaLabel}
        onClick={() => {
          if (windowManager) windowManager.open(objectCardWindowEntry(typeCardDescriptor(type)));
          else setModalOpen(true);
        }}
        style={typeChipButtonStyle}
      >
        <StatusChip tone="purple">{type.code}</StatusChip>
      </button>
      {modalOpen ? (
        <ObjectCardModal
          descriptor={typeCardDescriptor(type)}
          onClose={() => {
            setModalOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

interface Lane {
  key: string;
  labelKey: string;
  tone: OntChoice["tone"];
  rows: ModuleRow[];
}

/** Kanban lanes — one per registry choice of the group-by property; card = row-select. */
function LaneBoard({
  choices,
  rows,
  selectedRowId,
  onSelect,
}: {
  choices: OntChoice[];
  rows: ModuleRow[];
  selectedRowId: string | undefined;
  onSelect: (row: ModuleRow) => void;
}) {
  const lanes: Lane[] = choices.map((choice) => ({
    key: choice.id,
    labelKey: choice.nameKey,
    tone: choice.tone,
    rows: rows.filter((row) => row.status?.labelKey === choice.nameKey),
  }));
  const claimed = new Set(lanes.flatMap((lane) => lane.rows.map((row) => row.id)));
  const rest = rows.filter((row) => !claimed.has(row.id));
  if (rest.length > 0) {
    lanes.push({
      key: "unclassified",
      labelKey: "console.modules.common.laneUnclassified",
      tone: "neutral",
      rows: rest,
    });
  }
  return (
    <div style={laneBoardStyle}>
      {lanes.map((lane) => (
        <section key={lane.key} aria-label={resolveText(lane.labelKey)} style={laneStyle}>
          <div style={chipRowStyle}>
            <StatusChip tone={lane.tone}>{resolveText(lane.labelKey)}</StatusChip>
            <StatusChip tone="neutral">{lane.rows.length}</StatusChip>
          </div>
          <ul style={laneListStyle}>
            {lane.rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  {...objDrag(row.code, row.title ?? row.code)}
                  aria-label={T.rowDetail(row.code)}
                  aria-pressed={row.id === selectedRowId}
                  onClick={() => {
                    onSelect(row);
                  }}
                  style={laneCardStyle(row.id === selectedRowId)}
                >
                  <span style={monoStyle}>{row.code}</span>
                  {row.title ? <span style={kvValueStyle}>{row.title}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

type ModuleLoadState = "idle" | "loading" | "error";

interface ModuleRuntimeState {
  selectedRowId: string | undefined;
  loadedRows: ModuleRow[] | undefined;
  listState: ModuleLoadState;
  detailState: ModuleLoadState;
  listStats: Record<string, ModuleStatValue | undefined>;
  detailStats: Record<string, ModuleStatValue | undefined>;
}

type ModuleRuntimeAction =
  | { type: "select"; rowId: string | undefined }
  | { type: "listLoading" }
  | {
      type: "listLoaded";
      rows: ModuleRow[];
      stats: Record<string, ModuleStatValue | undefined> | undefined;
      selectedRowId: string | undefined;
    }
  | { type: "listFailed" }
  | { type: "detailIdle" }
  | { type: "detailLoading" }
  | {
      type: "detailLoaded";
      row: ModuleRow | undefined;
      stats: Record<string, ModuleStatValue | undefined> | undefined;
      baseRows: readonly ModuleRow[];
    }
  | { type: "detailFailed" };

const EMPTY_ROWS: ModuleRow[] = [];

function initialRuntimeState(config: ModuleScreenConfig): ModuleRuntimeState {
  return {
    selectedRowId: config.rows[0]?.id,
    loadedRows: undefined,
    listState: "idle",
    detailState: "idle",
    listStats: {},
    detailStats: {},
  };
}

function moduleRuntimeReducer(
  state: ModuleRuntimeState,
  action: ModuleRuntimeAction,
): ModuleRuntimeState {
  switch (action.type) {
    case "select":
      return { ...state, selectedRowId: action.rowId };
    case "listLoading":
      return { ...state, listState: "loading" };
    case "listLoaded": {
      const selectedRowId =
        state.selectedRowId && action.rows.some((row) => row.id === state.selectedRowId)
          ? state.selectedRowId
          : action.selectedRowId ?? action.rows[0]?.id;
      return {
        ...state,
        selectedRowId,
        loadedRows: action.rows,
        listStats: action.stats ?? {},
        listState: "idle",
      };
    }
    case "listFailed":
      return {
        ...state,
        selectedRowId: undefined,
        loadedRows: [],
        listStats: {},
        listState: "error",
      };
    case "detailIdle":
      return { ...state, detailStats: {}, detailState: "idle" };
    case "detailLoading":
      return { ...state, detailStats: {}, detailState: "loading" };
    case "detailLoaded": {
      const loadedRows = action.row
        ? (state.loadedRows ?? [...action.baseRows]).map((row) =>
            row.id === action.row?.id ? action.row : row,
          )
        : state.loadedRows;
      return {
        ...state,
        loadedRows,
        detailStats: action.stats ?? {},
        detailState: "idle",
      };
    }
    case "detailFailed":
      return { ...state, detailState: "error" };
    default:
      return state;
  }
}

export function GenericModuleScreen({
  config,
  api,
}: {
  config: ModuleScreenConfig;
  api?: ConsoleApiClient;
}) {
  return <GenericModuleScreenBody key={config.id} api={api} config={config} />;
}

function GenericModuleScreenBody({
  config,
  api,
}: {
  config: ModuleScreenConfig;
  api?: ConsoleApiClient;
}) {
  const gate = usePolicyGate();
  const windowManager = useOptionalWindowManager();
  const [runtime, dispatch] = useReducer(moduleRuntimeReducer, initialRuntimeState(config));
  const [query, setQuery] = useState("");
  const [display, setDisplay] = useState<ModuleListDisplay>(config.list.display ?? "table");
  const [composeOpen, setComposeOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [actionBusyKey, setActionBusyKey] = useState<string | undefined>(undefined);
  const [actionErrorKey, setActionErrorKey] = useState<string | undefined>(undefined);
  const loadRows = config.dataAdapter?.loadRows;
  const loadDetail = config.dataAdapter?.loadDetail;
  const usesListLoader = Boolean(loadRows && api);
  const rows = useMemo(
    () => (usesListLoader ? runtime.loadedRows ?? EMPTY_ROWS : config.rows),
    [config.rows, runtime.loadedRows, usesListLoader],
  );

  // §18 registry binding: config picks WHICH fields, ONT_TYPES defines them.
  const type = getObjectType(config.typeKey);
  const columns = useMemo(
    () =>
      config.list.columns.map((column) => {
        const prop = getProperty(type, column.key);
        return {
          ...column,
          labelKey: column.labelKey ?? prop?.nameKey ?? column.key,
          variant: column.variant ?? columnVariantFor(prop),
        };
      }),
    [config.list.columns, type],
  );
  const detailFields = useMemo(
    () =>
      config.detail.fields.map((field) => {
        const prop = getProperty(type, field.key);
        return {
          ...field,
          labelKey: field.labelKey ?? prop?.nameKey ?? field.key,
          variant: field.variant ?? detailVariantFor(prop),
        };
      }),
    [config.detail.fields, type],
  );
  const laneChoices = config.list.laneGroupBy
    ? propChoices(getProperty(type, config.list.laneGroupBy))
    : [];
  const showLanes = display === "lanes" && laneChoices.length > 0;

  const selectRow = useCallback(
    (row: ModuleRow) => {
      dispatch({ type: "select", rowId: row.id });
      // §4.7-3: a row click also opens the object as the right pin when a
      // window shell hosts the screen; without one, the split detail stands.
      windowManager?.open(objectCardWindowEntry(rowCardDescriptor(type, row)));
    },
    [type, windowManager],
  );

  const runAction = useCallback(
    async (action: ModuleActionConfig, row: ModuleRow) => {
      const executeAction = config.dataAdapter?.executeAction;
      if (!executeAction || !api) return;
      setActionErrorKey(undefined);
      setActionBusyKey(action.key);
      try {
        const result = await executeAction({ api, row, action });
        if (result?.row) {
          dispatch({ type: "detailLoaded", row: result.row, stats: undefined, baseRows: config.rows });
        } else {
          setRefreshToken((token) => token + 1);
        }
      } catch {
        setActionErrorKey(action.labelKey);
      } finally {
        setActionBusyKey(undefined);
      }
    },
    [api, config.dataAdapter, config.rows],
  );

  useEffect(() => {
    if (!api || !loadRows) return;
    let active = true;
    dispatch({ type: "listLoading" });
    void loadRows({ api, query, hasPolicy: gate.can })
      .then((result) => {
        if (!active) return;
        dispatch({
          type: "listLoaded",
          rows: result.rows,
          stats: result.stats,
          selectedRowId: result.selectedRowId,
        });
      })
      .catch(() => {
        if (!active) return;
        dispatch({ type: "listFailed" });
      });
    return () => {
      active = false;
    };
  }, [api, gate.can, loadRows, query, refreshToken]);

  const selectedRow = rows.find((row) => row.id === runtime.selectedRowId) ?? rows.at(0);

  useEffect(() => {
    if (!api || !selectedRow || !loadDetail) {
      dispatch({ type: "detailIdle" });
      return;
    }
    let active = true;
    dispatch({ type: "detailLoading" });
    void loadDetail({ api, row: selectedRow, hasPolicy: gate.can })
      .then((result) => {
        if (!active) return;
        dispatch({
          type: "detailLoaded",
          row: result.row,
          stats: result.stats,
          baseRows: config.rows,
        });
      })
      .catch(() => {
        if (!active) return;
        dispatch({ type: "detailFailed" });
      });
    return () => {
      active = false;
    };
    // Depend on the row's id (not the `selectedRow` object) and refreshToken,
    // not `selectedRow` itself: loadDetail always returns a freshly-mapped row
    // object, so re-running on every reference change here would refetch in
    // an infinite loop the moment a detail load (or a post/reverse action)
    // ever succeeds — the effect must re-run on a real selection/refresh, not
    // on the row's own content settling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, config.rows, gate.can, loadDetail, selectedRow?.id, refreshToken]);

  const stats = visibleStats(config, { ...runtime.listStats, ...runtime.detailStats });
  const blocked = isBackendBlocked(config);
  const objectName = resolveText(config.objectNameKey);
  const blockedChip = config.blockedChipKey ? resolveText(config.blockedChipKey) : undefined;
  const showSearch = Boolean(
    config.search && (!config.search.requiresRows || rows.length > 0 || usesListLoader) && !blocked,
  );

  return (
    <PolicyGated action={config.policy.read} resource={{ kind: "module", id: config.id }}>
      <div className="console" data-console-module={config.id} style={rootStyle}>
        <header style={headerStyle}>
          <div style={titleGroupStyle}>
            <h1 style={titleStyle}>{resolveText(config.titleKey)}</h1>
            <StatusChip tone="neutral">{objectName}</StatusChip>
            {type ? <TypeChip type={type} /> : null}
            {blocked && blockedChip ? <StatusChip tone="warn">{blockedChip}</StatusChip> : null}
          </div>
          <nav aria-label={T.navAria} style={navStyle}>
            <PolicyGated action={config.policy.read} resource={{ kind: "module", id: config.id }}>
              <a href={config.route} aria-current="page" style={navLinkStyle}>
                {resolveText(config.navLabelKey)}
              </a>
            </PolicyGated>
          </nav>
          {config.primaryAction && !config.primaryAction.blockedUntil ? (
            <PolicyGated
              action={config.primaryAction.policyAction}
              resource={actionResourceFor(config, config.primaryAction.resourceKind)}
            >
              {config.primaryAction.href ? (
                <a href={config.primaryAction.href} style={{ ...actionButtonStyle, textDecoration: "none" }}>
                  {resolveText(config.primaryAction.labelKey)}
                </a>
              ) : config.dataAdapter?.renderCompose && api ? (
                <button
                  type="button"
                  style={actionButtonStyle}
                  onClick={() => {
                    setComposeOpen(true);
                  }}
                >
                  {resolveText(config.primaryAction.labelKey)}
                </button>
              ) : (
                <button type="button" style={actionButtonStyle}>
                  {resolveText(config.primaryAction.labelKey)}
                </button>
              )}
            </PolicyGated>
          ) : null}
        </header>

        {composeOpen && config.dataAdapter?.renderCompose && api ? (
          <section aria-label={resolveText(config.primaryAction?.labelKey ?? config.titleKey)} style={cardStyle}>
            {config.dataAdapter.renderCompose({
              api,
              onDone: (row) => {
                setComposeOpen(false);
                setRefreshToken((token) => token + 1);
                if (row) dispatch({ type: "select", rowId: row.id });
              },
              onCancel: () => {
                setComposeOpen(false);
              },
            })}
          </section>
        ) : null}

        {stats.length > 0 ? (
          <section aria-label={T.statsAria(objectName)} style={chipRowStyle}>
            {stats.map((stat) => {
              const chip = (
                <StatusChip key={stat.key} tone={stat.tone}>
                  {resolveText(stat.labelKey)} {formatCellValue(stat.value)}
                </StatusChip>
              );
              return stat.policyAction ? (
                <PolicyGated key={stat.key} action={stat.policyAction} resource={{ kind: config.objectKind }}>
                  {chip}
                </PolicyGated>
              ) : (
                chip
              );
            })}
          </section>
        ) : null}

        {showSearch && config.search ? (
          <label style={labelStyle}>
            {resolveText(config.search.labelKey)}
            <input
              type="search"
              placeholder={resolveText(config.search.placeholderKey)}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              style={inputStyle}
            />
          </label>
        ) : null}

        <section style={bodyGridStyle}>
          <section aria-label={T.listAria(objectName)} data-fidelity="module-list" style={cardStyle}>
            {laneChoices.length > 0 ? (
              <div role="group" aria-label={resolveText("console.modules.common.viewAria")} style={chipRowStyle}>
                <button
                  type="button"
                  aria-pressed={!showLanes}
                  onClick={() => {
                    setDisplay("table");
                  }}
                  style={viewToggleStyle(!showLanes)}
                >
                  {resolveText("console.modules.common.viewTable")}
                </button>
                <button
                  type="button"
                  aria-pressed={showLanes}
                  onClick={() => {
                    setDisplay("lanes");
                  }}
                  style={viewToggleStyle(showLanes)}
                >
                  {resolveText("console.modules.common.viewLanes")}
                </button>
              </div>
            ) : null}
            {showLanes ? (
              <LaneBoard
                choices={laneChoices}
                rows={rows}
                selectedRowId={runtime.selectedRowId}
                onSelect={selectRow}
              />
            ) : (
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <th key={column.key} scope="col" style={headerCellStyle(column)}>
                          {resolveText(column.labelKey)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        data-row-id={row.id}
                        onClick={() => {
                          selectRow(row);
                        }}
                      >
                        {columns.map((column) => (
                          <td key={column.key} style={cellStyle(column)}>
                            {renderCell(config, row, column, () => {
                              selectRow(row);
                            })}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length === 0 && blocked && blockedChip ? (
              <span style={chipRowStyle}>
                <StatusChip tone="warn">{blockedChip}</StatusChip>
              </span>
            ) : null}
            {rows.length === 0 && !blocked && runtime.listState === "idle" && config.emptyLiveHintKey ? (
              <span style={chipRowStyle}>
                <StatusChip tone="neutral">{resolveText(config.emptyLiveHintKey)}</StatusChip>
              </span>
            ) : null}
            {runtime.listState === "loading" ? (
              <StatusChip role="status" tone="info">{T.loading}</StatusChip>
            ) : null}
            {runtime.listState === "error" ? (
              <StatusChip role="alert" tone="danger">{T.loadFailed}</StatusChip>
            ) : null}
          </section>

          <aside aria-label={T.detailAria(objectName)} data-fidelity="module-detail" style={cardStyle}>
            {selectedRow ? (
              <>
                <span style={chipRowStyle}>
                  <StatusChip tone="info">{selectedRow.code}</StatusChip>
                  {selectedRow.status ? (
                    <StatusChip tone={selectedRow.status.tone}>{resolveText(selectedRow.status.labelKey)}</StatusChip>
                  ) : null}
                </span>
                <div style={kvGridStyle}>
                  {detailFields.map((field) => {
                    const value = field.key === "code" ? selectedRow.code : selectedRow.detail?.[field.key];
                    const structured =
                      field.variant === "timeline" ||
                      field.variant === "graph" ||
                      field.variant === "ledger" ||
                      field.variant === "stepper" ||
                      field.variant === "balanceCheck";
                    const valueStyle =
                      !structured && (field.variant === "mono" || field.key === "code" || field.key.toLowerCase().includes("id"))
                        ? { ...kvValueStyle, ...monoStyle }
                        : kvValueStyle;
                    return (
                      <div
                        key={field.key}
                        style={structured ? { ...kvRowStyle, gridTemplateColumns: "minmax(0, 1fr)" } : kvRowStyle}
                      >
                        <span style={kvKeyStyle}>{resolveText(field.labelKey)}</span>
                        <div style={structured ? detailStackStyle : valueStyle}>
                          {renderDetailValue(field, value)}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {runtime.detailState === "loading" ? (
                  <StatusChip role="status" tone="info">{T.loading}</StatusChip>
                ) : null}
                {runtime.detailState === "error" ? (
                  <StatusChip role="alert" tone="danger">{T.loadFailed}</StatusChip>
                ) : null}
                {selectedRow.linkChips && selectedRow.linkChips.length > 0 ? (
                  <span style={chipRowStyle}>
                    {selectedRow.linkChips.map((chip) => (
                      <LinkChip key={chip.key} chip={chip} />
                    ))}
                  </span>
                ) : null}
                <span style={chipRowStyle}>
                  {(selectedRow.actions ?? config.detail.actions)
                    .filter((action) => !action.blockedUntil)
                    .map((action) => (
                      <PolicyGated
                        key={action.key}
                        action={action.policyAction}
                        resource={actionResourceFor(config, action.resourceKind, selectedRow)}
                      >
                        {action.href ? (
                          <a href={action.href} style={{ ...ghostButtonStyle, textDecoration: "none" }}>
                            {resolveText(action.labelKey)}
                          </a>
                        ) : config.dataAdapter?.executeAction && api ? (
                          <button
                            type="button"
                            style={ghostButtonStyle}
                            disabled={actionBusyKey === action.key}
                            onClick={() => {
                              void runAction(action, selectedRow);
                            }}
                          >
                            {resolveText(action.labelKey)}
                          </button>
                        ) : (
                          <button type="button" style={ghostButtonStyle}>
                            {resolveText(action.labelKey)}
                          </button>
                        )}
                      </PolicyGated>
                    ))}
                </span>
                {actionErrorKey ? (
                  <StatusChip role="alert" tone="danger">{resolveText(actionErrorKey)} · {T.loadFailed}</StatusChip>
                ) : null}
              </>
            ) : blocked && blockedChip ? (
              <StatusChip tone="warn">{blockedChip}</StatusChip>
            ) : null}
          </aside>
        </section>
      </div>
    </PolicyGated>
  );
}
