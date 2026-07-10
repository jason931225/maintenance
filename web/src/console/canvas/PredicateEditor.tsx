// Typed predicate editor — field · operator · value rows (§5d / DESIGN §4-20
// "field·op·value 술어"). Field from the typed registry; operator constrained by
// field type; value input typed. Object-code values accept an objDrag drop.

import type { CSSProperties } from "react";

import { useObjectDrop } from "../window";
import { defaultOperatorForField, defaultValueForField } from "./predicate";
import type { CanvasStrings } from "./strings";
import {
  OPERATORS_BY_TYPE,
  OPERATOR_SYMBOL,
  type FieldDef,
  type FieldRegistry,
  type Predicate,
  type PredicateGroup,
  type PredicateOperator,
  type PredicateValue,
} from "./types";

const rootStyle: CSSProperties = { display: "grid", gap: "var(--sp-3)" };

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const labelStyle: CSSProperties = {
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const controlStyle: CSSProperties = {
  minHeight: 44,
  padding: "0 var(--sp-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  boxSizing: "border-box",
  width: "100%",
};

const iconButtonStyle: CSSProperties = {
  ...controlStyle,
  width: 44,
  cursor: "pointer",
  color: "var(--steel)",
};

const joinToggleStyle: CSSProperties = {
  ...controlStyle,
  width: "auto",
  cursor: "pointer",
};

function firstField(registry: FieldRegistry): FieldDef | undefined {
  return registry[0];
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `p-${String(seq)}`;
}

/** Coerce a raw input string into a typed value for the current field type. */
function readValue(field: FieldDef, op: PredicateOperator, raw: string, multi?: string[]): PredicateValue {
  switch (field.type) {
    case "number":
      return { kind: "number", value: raw === "" ? 0 : Number(raw) };
    case "bool":
      return { kind: "bool", value: raw === "true" };
    case "date":
      return { kind: "date", value: raw };
    case "code":
      return { kind: "code", value: raw };
    case "text":
      return { kind: "text", value: raw };
    case "enum":
      return op === "in" ? { kind: "enumSet", value: multi ?? [] } : { kind: "enum", value: raw };
  }
}

function valueAsString(value: PredicateValue): string {
  switch (value.kind) {
    case "number":
      return String(value.value);
    case "bool":
      return value.value ? "true" : "false";
    case "enumSet":
      return value.value.join(",");
    default:
      return value.value;
  }
}

export interface PredicateEditorProps {
  group: PredicateGroup;
  registry: FieldRegistry;
  strings: CanvasStrings;
  onChange: (group: PredicateGroup) => void;
  /** Gate object-code drops (PBAC): a denied code is a no-op drop. */
  canAcceptCode?: (code: string) => boolean;
}

export function PredicateEditor({ group, registry, strings, onChange, canAcceptCode }: PredicateEditorProps) {
  function patch(id: string, next: Partial<Predicate>) {
    onChange({
      ...group,
      predicates: group.predicates.map((p) => (p.id === id ? { ...p, ...next } : p)),
    });
  }

  function addRow() {
    const field = firstField(registry);
    if (!field) return;
    const predicate: Predicate = {
      id: newId(),
      field: field.key,
      op: defaultOperatorForField(field),
      value: defaultValueForField(field),
    };
    onChange({ ...group, predicates: [...group.predicates, predicate] });
  }

  function removeRow(id: string) {
    onChange({ ...group, predicates: group.predicates.filter((p) => p.id !== id) });
  }

  function onFieldChange(pred: Predicate, key: string) {
    const field = registry.find((f) => f.key === key);
    if (!field) return;
    patch(pred.id, {
      field: key,
      op: defaultOperatorForField(field),
      value: defaultValueForField(field),
    });
  }

  return (
    <div style={rootStyle}>
      <div style={headerRowStyle}>
        <span style={labelStyle}>{strings.predicateLabel}</span>
        <button
          type="button"
          style={joinToggleStyle}
          aria-pressed={group.join === "and"}
          onClick={() => {
            onChange({ ...group, join: group.join === "and" ? "or" : "and" });
          }}
        >
          {group.join === "and" ? strings.joinAnd : strings.joinOr}
        </button>
      </div>

      {group.predicates.map((pred) => {
        const field = registry.find((f) => f.key === pred.field);
        const ops = field ? OPERATORS_BY_TYPE[field.type] : [];
        return (
          <div key={pred.id} style={rowStyle}>
            <select
              aria-label={strings.fieldLabel}
              value={pred.field}
              style={controlStyle}
              onChange={(event) => {
                onFieldChange(pred, event.target.value);
              }}
            >
              {registry.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>

            <select
              aria-label={strings.operatorLabel}
              value={pred.op}
              style={{ ...controlStyle, width: "auto" }}
              onChange={(event) => {
                const op = event.target.value as PredicateOperator;
                const next = field ? readValue(field, op, valueAsString(pred.value)) : pred.value;
                patch(pred.id, { op, value: next });
              }}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {`${OPERATOR_SYMBOL[op]} ${strings.operatorName[op]}`}
                </option>
              ))}
            </select>

            {field ? (
              <ValueControl
                field={field}
                op={pred.op}
                value={pred.value}
                strings={strings}
                canAcceptCode={canAcceptCode}
                onValue={(value) => {
                  patch(pred.id, { value });
                }}
              />
            ) : (
              <span />
            )}

            <button
              type="button"
              aria-label={strings.removePredicate}
              style={iconButtonStyle}
              onClick={() => {
                removeRow(pred.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      <button type="button" style={{ ...controlStyle, cursor: "pointer" }} onClick={addRow}>
        {strings.addPredicate}
      </button>
    </div>
  );
}

interface ValueControlProps {
  field: FieldDef;
  op: PredicateOperator;
  value: PredicateValue;
  strings: CanvasStrings;
  onValue: (value: PredicateValue) => void;
  canAcceptCode?: (code: string) => boolean;
}

function ValueControl({ field, op, value, strings, onValue, canAcceptCode }: ValueControlProps) {
  const drop = useObjectDrop({
    onRef: (ref) => {
      onValue({ kind: "code", value: ref.code });
    },
    canAccept: canAcceptCode,
  });

  switch (field.type) {
    case "number":
      return (
        <input
          type="number"
          aria-label={strings.valueLabel}
          style={controlStyle}
          value={value.kind === "number" ? String(value.value) : ""}
          onChange={(event) => {
            onValue(readValue(field, op, event.target.value));
          }}
        />
      );
    case "date":
      return (
        <input
          type="date"
          aria-label={strings.valueLabel}
          style={controlStyle}
          value={value.kind === "date" ? value.value : ""}
          onChange={(event) => {
            onValue(readValue(field, op, event.target.value));
          }}
        />
      );
    case "bool":
      return (
        <select
          aria-label={strings.valueLabel}
          style={controlStyle}
          value={value.kind === "bool" && value.value ? "true" : "false"}
          onChange={(event) => {
            onValue(readValue(field, op, event.target.value));
          }}
        >
          <option value="true">{strings.boolTrue}</option>
          <option value="false">{strings.boolFalse}</option>
        </select>
      );
    case "enum": {
      const choices = field.choices ?? [];
      if (op === "in") {
        const selected = value.kind === "enumSet" ? value.value : [];
        return (
          <select
            multiple
            aria-label={strings.valueLabel}
            style={controlStyle}
            value={selected}
            onChange={(event) => {
              const picked = Array.from(event.target.selectedOptions, (o) => o.value);
              onValue({ kind: "enumSet", value: picked });
            }}
          >
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        );
      }
      return (
        <select
          aria-label={strings.valueLabel}
          style={controlStyle}
          value={value.kind === "enum" ? value.value : ""}
          onChange={(event) => {
            onValue(readValue(field, op, event.target.value));
          }}
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      );
    }
    case "code":
      return (
        <input
          aria-label={strings.valueLabel}
          placeholder={strings.dropObjectCode}
          style={controlStyle}
          value={value.kind === "code" ? value.value : ""}
          onChange={(event) => {
            onValue(readValue(field, op, event.target.value));
          }}
          {...drop}
        />
      );
    case "text":
      return (
        <input
          aria-label={strings.valueLabel}
          style={controlStyle}
          value={value.kind === "text" ? value.value : ""}
          onChange={(event) => {
            onValue(readValue(field, op, event.target.value));
          }}
        />
      );
  }
}
