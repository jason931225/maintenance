import { useState, type CSSProperties } from "react";

import { StatusChip } from "../components";
import "../tokens.css";
import { resolveText } from "../modules/typeRegistry";
import type { ModuleComposeContext } from "../modules/types";
import { formatWon, submitVoucherDraft, validateDraft, type DraftLine } from "./financeModel";

const F = "console.modules.finance";

const formStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
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

const lineGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 0.7fr) minmax(0, 0.7fr) auto",
  gap: "var(--sp-2)",
  alignItems: "center",
};

const rowButtonStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
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

const ghostButtonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

function emptyLine(lineNo: number): DraftLine {
  return { line_no: lineNo, gl_account_id: "", description: "", debit_won: "", credit_won: "" };
}

type SubmitState = { status: "idle" } | { status: "submitting" } | { status: "error"; reasonKey: string };

export function VoucherComposeForm({ api, onDone, onCancel }: ModuleComposeContext) {
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(1), emptyLine(2)]);
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });

  const validation = validateDraft(title, lines);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((current) => [...current, emptyLine((current.at(-1)?.line_no ?? 0) + 1)]);
  }

  function removeLine(index: number) {
    setLines((current) => (current.length <= 2 ? current : current.filter((_, i) => i !== index)));
  }

  async function handleSubmit() {
    setSubmit({ status: "submitting" });
    const record = await submitVoucherDraft(api, title, memo, lines);
    if (!record) {
      setSubmit({ status: "error", reasonKey: `${F}.compose.errors.submitFailed` });
      return;
    }
    setSubmit({ status: "idle" });
    onDone({
      id: record.id,
      code: record.code,
      title: record.title,
      cells: {},
    });
  }

  return (
    <form
      aria-label={resolveText(`${F}.compose.title`)}
      style={formStyle}
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.balanced && submit.status !== "submitting") void handleSubmit();
      }}
    >
      <label style={fieldStyle}>
        {resolveText(`${F}.compose.titleField`)}
        <input
          type="text"
          value={title}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
          }}
          style={inputStyle}
          required
        />
      </label>
      <label style={fieldStyle}>
        {resolveText(`${F}.compose.memoField`)}
        <input
          type="text"
          value={memo}
          onChange={(event) => {
            setMemo(event.currentTarget.value);
          }}
          style={inputStyle}
        />
      </label>

      <section aria-label={resolveText(`${F}.compose.linesAria`)} style={{ display: "grid", gap: "var(--sp-2)" }}>
        <div style={lineGridStyle} aria-hidden="true">
          <span style={fieldStyle}>{resolveText(`${F}.compose.columns.glAccount`)}</span>
          <span style={fieldStyle}>{resolveText(`${F}.compose.columns.description`)}</span>
          <span style={fieldStyle}>{resolveText(`${F}.compose.columns.debit`)}</span>
          <span style={fieldStyle}>{resolveText(`${F}.compose.columns.credit`)}</span>
          <span />
        </div>
        {lines.map((line, index) => (
          <div key={index} style={lineGridStyle}>
            <input
              type="text"
              aria-label={resolveText(`${F}.compose.columns.glAccount`)}
              value={line.gl_account_id}
              onChange={(event) => {
                updateLine(index, { gl_account_id: event.currentTarget.value });
              }}
              style={inputStyle}
            />
            <input
              type="text"
              aria-label={resolveText(`${F}.compose.columns.description`)}
              value={line.description}
              onChange={(event) => {
                updateLine(index, { description: event.currentTarget.value });
              }}
              style={inputStyle}
            />
            <input
              type="number"
              min={0}
              aria-label={resolveText(`${F}.compose.columns.debit`)}
              value={line.debit_won}
              onChange={(event) => {
                updateLine(index, { debit_won: event.currentTarget.value, credit_won: "" });
              }}
              style={inputStyle}
            />
            <input
              type="number"
              min={0}
              aria-label={resolveText(`${F}.compose.columns.credit`)}
              value={line.credit_won}
              onChange={(event) => {
                updateLine(index, { credit_won: event.currentTarget.value, debit_won: "" });
              }}
              style={inputStyle}
            />
            <button
              type="button"
              style={rowButtonStyle}
              aria-label={resolveText(`${F}.compose.removeLine`)}
              disabled={lines.length <= 2}
              onClick={() => {
                removeLine(index);
              }}
            >
              −
            </button>
          </div>
        ))}
        <span>
          <button type="button" style={ghostButtonStyle} onClick={addLine}>
            {resolveText(`${F}.compose.addLine`)}
          </button>
        </span>
      </section>

      <span style={chipRowStyle} role={validation.balanced ? "status" : "alert"}>
        <StatusChip tone={validation.balanced ? "ok" : "warn"}>
          {resolveText(validation.balanced ? `${F}.balanceCheck.ok` : `${F}.balanceCheck.blocked`)}
        </StatusChip>
        <span style={fieldStyle}>
          {resolveText(`${F}.detail.totalDebit`)} {formatWon(validation.totalDebit) ?? "0"}
        </span>
        <span style={fieldStyle}>
          {resolveText(`${F}.detail.totalCredit`)} {formatWon(validation.totalCredit) ?? "0"}
        </span>
        {validation.reasonKey ? <span style={fieldStyle}>{resolveText(validation.reasonKey)}</span> : null}
      </span>

      {submit.status === "error" ? (
        <StatusChip role="alert" tone="danger">
          {resolveText(submit.reasonKey)}
        </StatusChip>
      ) : null}

      <span style={chipRowStyle}>
        <button type="submit" style={primaryButtonStyle} disabled={!validation.balanced || submit.status === "submitting"}>
          {resolveText(submit.status === "submitting" ? `${F}.compose.submitting` : `${F}.compose.submit`)}
        </button>
        <button type="button" style={ghostButtonStyle} onClick={onCancel}>
          {resolveText(`${F}.compose.cancel`)}
        </button>
      </span>
    </form>
  );
}
