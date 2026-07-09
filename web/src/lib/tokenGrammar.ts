/**
 * Token grammar (DESIGN.md §4.7 catalog item 7) — the single parser for every
 * console input (기안·할 일·메신저·메일·코멘트): `@mention`, `#object-link`,
 * `!CODE-link`. Pure text in, spans out; unparsed text always survives
 * verbatim. `serializeTokenSpans` is the inverse — round-trips back to the
 * exact storage form.
 *
 * Trigger rules (spec-exact, see DESIGN.md §4.7-7):
 * - `@` fires only right after start-of-string/whitespace/`([{`, followed by a
 *   Korean/Latin name pattern — so `a@b.com` never matches (the `@` isn't
 *   boundary-preceded).
 * - `#` fires only after the same boundary, followed by a search term whose
 *   first character is a letter — so pure-numeric `#23` never matches.
 * - `!` fires only for an explicit `CODE-NNNN` shape (`!AP-3121`), including
 *   the two-segment date-sequence codes real objects actually use
 *   (`!WO-20260612-001`, `!JL-20260704-1`) — so `!!` and other punctuation
 *   never match.
 */

export type TokenKind = "mention" | "objectLink" | "codeLink";

export type TokenSpan =
  | { kind: "text"; value: string }
  | { kind: TokenKind; raw: string; value: string };

const MENTION_RE = /(^|[\s([{])(@[\p{L}\p{N}._-]{1,48})/gu;
const OBJECT_LINK_RE = /(^|[\s([{])(#[\p{L}][\p{L}\p{N}_-]{0,63})/gu;
// Second optional `-NNNNNN` segment covers real two-segment codes like
// workOrderCode()'s "WO-20260612-001" and journal's "JL-20260704-1", not just
// the single-segment "AP-3121" shape.
const CODE_LINK_RE = /(^|[\s([{])(![A-Z]{1,8}-[0-9]{1,10}(?:-[0-9]{1,6})?)/gu;

interface RawMatch {
  start: number;
  end: number;
  kind: TokenKind;
  raw: string;
}

function collect(re: RegExp, kind: TokenKind, text: string, out: RawMatch[]): void {
  for (const match of text.matchAll(re)) {
    const full = match[0];
    const token = match[2];
    const start = match.index + full.length - token.length;
    out.push({ start, end: start + token.length, kind, raw: token });
  }
}

/** Split text into plain-text and token spans. Never drops or reorders text. */
export function parseTokenGrammar(text: string): TokenSpan[] {
  const matches: RawMatch[] = [];
  collect(MENTION_RE, "mention", text, matches);
  collect(OBJECT_LINK_RE, "objectLink", text, matches);
  collect(CODE_LINK_RE, "codeLink", text, matches);
  matches.sort((a, b) => a.start - b.start);

  const spans: TokenSpan[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue; // triggers are distinct chars; overlaps shouldn't occur, but never double-consume text
    if (match.start > cursor) {
      spans.push({ kind: "text", value: text.slice(cursor, match.start) });
    }
    spans.push({ kind: match.kind, raw: match.raw, value: match.raw.slice(1) });
    cursor = match.end;
  }
  if (cursor < text.length) {
    spans.push({ kind: "text", value: text.slice(cursor) });
  }
  return spans.length > 0 ? spans : [{ kind: "text", value: text }];
}

/** Inverse of `parseTokenGrammar` — reassembles spans into storage text. */
export function serializeTokenSpans(spans: TokenSpan[]): string {
  return spans.map((span) => (span.kind === "text" ? span.value : span.raw)).join("");
}
