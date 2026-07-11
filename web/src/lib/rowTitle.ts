// §4-18 shared row-title resolver.
//
// A list row must LEAD with a human subject line and carry its object/business
// code as secondary meta — never the reverse. Two console surfaces were showing
// a raw code as the primary title: the overview 처리대기 queue (dispatch/work
// rows carry only a request_no as their `title`, e.g. "20260710-004") and the
// workflow run-log (some events summarise to a bare object id, e.g.
// "20260701-001"). Both route through this ONE resolver so the rule holds
// identically everywhere.

import { isUuid } from "./utils";

// A business/object code used as a row's *secondary* identifier: an approval
// AP-code, a work-order request_no (YYYYMMDD-NNN), a WO-/CS-/GL- code, or a bare
// UUID. Human subject lines never match — they carry letters and spaces (and, in
// this product, Hangul). The pattern is intentionally strict: at most a short
// alpha prefix, then digits/hyphens to the end, no interior spaces.
const CODE_RE = /^[A-Za-z]{0,4}-?\d[\d-]*$/;

export function isObjectCode(value: string | null | undefined): boolean {
  const s = (value ?? "").trim();
  return s.length > 0 && (isUuid(s) || CODE_RE.test(s));
}

export interface ResolvedRowTitle {
  /** Human subject for the primary slot. */
  title: string;
  /** Business code for the secondary meta slot — never a UUID. */
  code?: string;
}

/**
 * Resolve a row's primary title and its secondary code.
 *
 * - A genuine human `rawTitle` stays the title; `rawCode` becomes the meta code
 *   unless it duplicates the title or is a bare UUID (which is not human-facing).
 * - When `rawTitle` is itself a code (or empty), promote `fallback` — a human
 *   kind/status label the caller already has localized — to the title and demote
 *   the code (the title-code, else `rawCode`) to meta. UUIDs are never surfaced.
 */
export function resolveRowTitle(
  rawTitle: string | undefined,
  rawCode: string | undefined,
  fallback: string,
): ResolvedRowTitle {
  const title = (rawTitle ?? "").trim();
  const code = (rawCode ?? "").trim();

  if (title && !isObjectCode(title)) {
    const meta = code && code !== title && !isUuid(code) ? code : undefined;
    return { title, code: meta };
  }

  const candidate = title || code;
  const meta = candidate && !isUuid(candidate) ? candidate : undefined;
  return { title: fallback, code: meta };
}
