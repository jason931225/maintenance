/**
 * Token grammar — the single parser for every console input (기안·할 일·메신저·
 * 메일·코멘트), DESIGN §4.7-7. Carbon-copy console owns its own grammar
 * (charter D3 "grammar built once in P0"); this is TRANSFERRED pure logic from
 * `web/src/lib/{tokenGrammar,useTokenGrammarInput}.ts` (D4: transfer data flow),
 * decoupled from the legacy re-skin modules so cutover deletion can't break it.
 *
 * Pure text in, spans out — unparsed text always survives verbatim (the
 * `msgParts` crash lesson: the renderer maps over this DATA array, never over
 * React elements). Trigger rules are spec-exact:
 * - `@` fires only after start/whitespace/`([{`, then a Korean/Latin name — so
 *   `example@x.com` never matches (the `@` isn't boundary-preceded).
 * - `#` fires only after the same boundary, then a term whose first char is a
 *   letter — so pure-numeric `#23` never matches.
 * - `!` fires only for the explicit `CODE-NNNN` shape (`!AP-3121`,
 *   `!WO-20260612-001`) — so `주의!!` and bare punctuation never match.
 */

export type TokenKind = "mention" | "objectLink" | "codeLink";

export type TokenSpan =
  | { kind: "text"; value: string }
  | { kind: TokenKind; raw: string; value: string };

const MENTION_RE = /(^|[\s([{])(@[\p{L}\p{N}._-]{1,48})/gu;
const OBJECT_LINK_RE = /(^|[\s([{])(#[\p{L}][\p{L}\p{N}_-]{0,63})/gu;
// Second optional `-NNNNNN` segment covers real two-segment codes like
// workOrderCode()'s "WO-20260612-001" and journal's "JL-20260704-1".
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
    if (match.start < cursor) continue; // triggers are distinct chars; never double-consume text
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

// --- in-progress trigger detection (composer autocomplete) -------------------

export type TriggerChar = "@" | "#" | "!";

export interface ActiveTrigger {
  trigger: TriggerChar;
  /** Index of the trigger character itself. */
  start: number;
  /** Typed text after the trigger, up to the caret (no trigger char). */
  query: string;
}

const BOUNDARY_RE = /[\s([{]/u;
const MENTION_QUERY_RE = /^[\p{L}\p{N}._-]*$/u;
const OBJECT_LINK_QUERY_RE = /^[\p{L}\p{N}_-]*$/u;
// Permissive while typing; the strict shape (CODE_LINK_RE) is enforced once the
// token is committed. The cap stays >= that regex's max capture length
// (8 + 1 + 10 + 1 + 6 = 26) so "WO-20260612-001" is never rejected mid-typing.
const CODE_LINK_QUERY_RE = /^[A-Z0-9-]*$/u;
const CODE_LINK_QUERY_MAX_LENGTH = 26;
const LEADING_LETTER_RE = /^\p{L}/u;

function isBoundary(char: string | undefined): boolean {
  return char === undefined || BOUNDARY_RE.test(char);
}

function isValidInProgressQuery(trigger: TriggerChar, query: string): boolean {
  switch (trigger) {
    case "@":
      return query.length <= 48 && MENTION_QUERY_RE.test(query);
    case "#":
      if (query.length > 64 || !OBJECT_LINK_QUERY_RE.test(query)) return false;
      return query.length === 0 || LEADING_LETTER_RE.test(query);
    case "!":
      return query.length <= CODE_LINK_QUERY_MAX_LENGTH && CODE_LINK_QUERY_RE.test(query);
  }
}

/**
 * Find the trigger (if any) the caret sits inside, scanning back from
 * `cursorIndex` to the nearest whitespace/start. Pure and DOM-free — the same
 * inertness rules as the parser, applied to in-progress text.
 */
export function detectActiveTrigger(text: string, cursorIndex: number): ActiveTrigger | null {
  const upToCursor = text.slice(0, cursorIndex);
  for (let i = upToCursor.length - 1; i >= 0; i -= 1) {
    const char = upToCursor[i];
    if (BOUNDARY_RE.test(char) && char !== "(" && char !== "[" && char !== "{") {
      return null; // hit whitespace before a trigger — caret isn't in a token
    }
    if (char === "@" || char === "#" || char === "!") {
      if (!isBoundary(upToCursor[i - 1])) return null;
      const query = upToCursor.slice(i + 1);
      if (!isValidInProgressQuery(char, query)) return null;
      return { trigger: char, start: i, query };
    }
  }
  return null;
}

// --- viewport flip/clamp math for the candidate dropdown ---------------------

export interface CaretRect {
  top: number;
  bottom: number;
  left: number;
}
export interface DropdownSize {
  width: number;
  height: number;
}
export interface ViewportSize {
  width: number;
  height: number;
}
export interface DropdownPlacement {
  top: number;
  left: number;
  placement: "below" | "above";
  /** Room in the chosen direction, capped at `dropdown.height` — apply as the
   * dropdown's CSS `max-height` (+ `overflow-y:auto`) so a tall list scrolls
   * internally instead of clipping past the viewport edge. */
  maxHeight: number;
}

const EDGE_MARGIN = 8;

/** Pure viewport-flip/clamp math (DESIGN §4.7-7 "뷰포트를 벗어나 잘리지 않게"). */
export function computeDropdownPosition(
  caret: CaretRect,
  dropdown: DropdownSize,
  viewport: ViewportSize,
): DropdownPlacement {
  const spaceBelow = viewport.height - caret.bottom;
  const spaceAbove = caret.top;
  const placement: "below" | "above" =
    spaceBelow >= dropdown.height || spaceBelow >= spaceAbove ? "below" : "above";

  const available = Math.max((placement === "below" ? spaceBelow : spaceAbove) - EDGE_MARGIN, 0);
  const maxHeight = Math.min(dropdown.height, available);
  const top = placement === "below" ? caret.bottom : caret.top - maxHeight;

  const maxLeft = Math.max(viewport.width - dropdown.width - EDGE_MARGIN, EDGE_MARGIN);
  const left = Math.min(Math.max(caret.left, EDGE_MARGIN), maxLeft);
  return { top: Math.max(top, EDGE_MARGIN), left, placement, maxHeight };
}
