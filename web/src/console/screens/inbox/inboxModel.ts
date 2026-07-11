// Pure derivations + copy for 개인 수신함. The view is a dumb consumer: filter
// tabs, per-doc status, and the free-form payload → renderable blocks are all
// derived here so every branch is unit-testable without a DOM.

import { ko } from "../../../i18n/ko";
import type { InboxDocDetail, InboxDocSummary, InboxFilter } from "./inboxApi";

// ── copy (defensive-pick off ko.console.inboxVault with a Korean fallback;
// this lane must not edit ko.ts — the koManifest lands the keys later, and the
// fallback IS the real product copy so the screen reads correctly meanwhile) ──

export interface InboxStrings {
  title: string;
  filters: Record<InboxFilter, string>;
  status: { locked: string; confirmed: (date: string) => string; payslip: string };
  kind: { payslip: string; legal_notice: string };
  detail: {
    lockedTitle: string;
    lockedHint: string;
    confirmButton: string;
    confirming: string;
    confirmedAt: (date: string) => string;
    basisLabel: string;
    fromLabel: string;
    receiptFailed: string;
  };
  empty: { list: string; selection: string };
  count: (n: number) => string;
  error: string;
  retry: string;
  loading: string;
}

// English safety net only — the real Korean product copy lives in
// ko.console.inboxVault (check-ui-strings forbids Hangul outside src/i18n). ko
// fully overrides this at runtime; this renders only if the ko block is missing.
const FALLBACK: InboxStrings = {
  title: "Inbox",
  filters: { all: "All", action: "Action needed", pay: "Payslips", done: "Done" },
  status: {
    locked: "Action needed",
    confirmed: (d) => `Receipt confirmed ${d}`,
    payslip: "Payslip",
  },
  kind: { payslip: "Payslip", legal_notice: "Legal notice" },
  detail: {
    lockedTitle: "Verify to view",
    lockedHint:
      "This is a legal notice. Completing identity verification (passkey) marks it as read; that moment is recorded as proof of receipt.",
    confirmButton: "Verify and view",
    confirming: "Verifying",
    confirmedAt: (d) => `${d} receipt confirmed`,
    basisLabel: "Basis",
    fromLabel: "From",
    receiptFailed: "Identity verification failed or was cancelled.",
  },
  empty: { list: "No documents", selection: "Select a document on the left" },
  count: (n) => String(n),
  error: "Could not load the inbox",
  retry: "Retry",
  loading: "Loading",
};

export function inboxStrings(): InboxStrings {
  const wired = (ko.console as unknown as { inboxVault?: Partial<InboxStrings> })
    .inboxVault;
  return wired ? { ...FALLBACK, ...wired } : FALLBACK;
}

// ── filter tabs (order mirrors the server enum) ──────────────────────────────

export const INBOX_FILTERS: readonly InboxFilter[] = ["all", "action", "pay", "done"];

// ── per-doc status chip ──────────────────────────────────────────────────────

export interface DocStatus {
  text: string;
  tone: "danger" | "ok" | "neutral";
}

export function docStatus(
  doc: InboxDocSummary,
  dateFmt: Intl.DateTimeFormat,
  S: InboxStrings,
): DocStatus {
  if (doc.locked) return { text: S.status.locked, tone: "danger" };
  if (doc.confirmed_at) {
    return {
      text: S.status.confirmed(dateFmt.format(new Date(doc.confirmed_at))),
      tone: "ok",
    };
  }
  return { text: S.status.payslip, tone: "neutral" };
}

export function kindLabel(kind: InboxDocSummary["kind"], S: InboxStrings): string {
  return S.kind[kind];
}

// ── free-form payload → renderable blocks ────────────────────────────────────
// The payload is an untyped JSON object (domain guarantees object-shape only).
// Producers use `{ paragraphs: string[] }` for legal prose; payslips carry
// figure fields. We render faithfully: prose paragraphs when present, else the
// object's own entries as label→value rows. No field is invented.

export type PayloadBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "field"; label: string; value: string };

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Remaining values come from parsed JSON (object/array) — stringify faithfully.
  return JSON.stringify(value);
}

export function payloadBlocks(detail: InboxDocDetail): PayloadBlock[] {
  const payload = detail.payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const paragraphs = record.paragraphs;
  if (Array.isArray(paragraphs)) {
    return paragraphs
      .map((p) => stringifyValue(p))
      .filter((text) => text.length > 0)
      .map((text) => ({ kind: "paragraph" as const, text }));
  }
  return Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => ({
      kind: "field" as const,
      label,
      value: stringifyValue(value),
    }));
}

/** A locked legal notice is body-withheld until receipt is confirmed. */
export function isReadable(detail: InboxDocDetail): boolean {
  return !detail.locked && detail.payload != null;
}
