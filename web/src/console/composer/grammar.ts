/**
 * Token grammar — the single parser for every console input (기안·할 일·메신저·
 * 메일·코멘트), DESIGN §4.7-7. Carbon-copy console owns its own grammar
 * (charter D3 "grammar built once in P0"); this is TRANSFERRED pure logic from
 * `web/src/lib/{tokenGrammar,useTokenGrammarInput}.ts` (D4: transfer data flow),
 * decoupled from the legacy re-skin modules so cutover deletion can't break it.
 *
 * Pure text in, spans out — unparsed text always survives verbatim (the
 * `msgParts` crash lesson: the renderer maps over this DATA array, never over
 * React elements). Grammar (founder directive 2026-07-09, supersedes the
 * prototype's @/#/! — the prototype predates the channel taxonomy):
 * - `@` = MENTIONS only (people/notify). Fires after start/whitespace/`([{`,
 *   then a Korean/Latin name — so `example@x.com` never matches (the `@` isn't
 *   boundary-preceded).
 * - `#` = CHANNELS (messenger threads, Slack convention). Identical mechanics
 *   to `@`; a non-matching query (`#23`, `#해시태그`) just opens then dismisses
 *   the dropdown gracefully and commits nothing, exactly as `@` does.
 * - OBJECT references have NO trigger: a bare `CODE-NNNN` (`WO-2643`, `AP-3122`,
 *   `C-5`, `WO-20260612-001`) auto-links wherever it appears in plain text. The
 *   `!` trigger and the old `#`-object trigger are REMOVED. `주의!!` and bare
 *   punctuation never match. An unregistered/unauthorized code stays inert.
 */

export type TokenKind = "mention" | "channel" | "codeLink";

export type TokenSpan =
  | { kind: "text"; value: string }
  | { kind: TokenKind; raw: string; value: string };

const MENTION_RE = /(^|[\s([{])(@[\p{L}\p{N}._-]{1,48})/gu;
// `#` mirrors `@` exactly: the stored raw is `#<thread-id>` (a UUID that may
// lead with a digit), so no leading-letter rule — round-trips through confirm.
const CHANNEL_RE = /(^|[\s([{])(#[\p{L}\p{N}._-]{1,48})/gu;
// Bare code, NO trigger char (§ directive: object refs auto-recognize). Second
// optional `-NNNNNN` segment covers two-segment codes like workOrderCode()'s
// "WO-20260612-001" and journal's "JL-20260704-1". kindFromCode is the gate:
// an unregistered prefix ("COVID-19") parses here but renders inert.
const BARE_CODE_RE = /(^|[\s([{])([A-Z]{1,8}-[0-9]{1,10}(?:-[0-9]{1,6})?)/gu;

interface RawMatch {
  start: number;
  end: number;
  kind: TokenKind;
  raw: string;
  value: string;
}

function collect(
  re: RegExp,
  kind: TokenKind,
  hasTrigger: boolean,
  text: string,
  out: RawMatch[],
): void {
  for (const match of text.matchAll(re)) {
    const full = match[0];
    const token = match[2];
    const start = match.index + full.length - token.length;
    // Mention/channel carry a trigger char to strip; a bare code IS its value.
    out.push({ start, end: start + token.length, kind, raw: token, value: hasTrigger ? token.slice(1) : token });
  }
}

/** Split text into plain-text and token spans. Never drops or reorders text. */
export function parseTokenGrammar(text: string): TokenSpan[] {
  const matches: RawMatch[] = [];
  collect(MENTION_RE, "mention", true, text, matches);
  collect(CHANNEL_RE, "channel", true, text, matches);
  collect(BARE_CODE_RE, "codeLink", false, text, matches);
  matches.sort((a, b) => a.start - b.start);

  const spans: TokenSpan[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue; // boundary rules keep kinds disjoint; never double-consume text
    if (match.start > cursor) {
      spans.push({ kind: "text", value: text.slice(cursor, match.start) });
    }
    spans.push({ kind: match.kind, raw: match.raw, value: match.value });
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

export type TriggerChar = "@" | "#";

export interface ActiveTrigger {
  trigger: TriggerChar;
  /** Index of the trigger character itself. */
  start: number;
  /** Typed text after the trigger, up to the caret (no trigger char). */
  query: string;
}

const BOUNDARY_RE = /[\s([{]/u;
const MENTION_QUERY_RE = /^[\p{L}\p{N}._-]*$/u;

function isBoundary(char: string | undefined): boolean {
  return char === undefined || BOUNDARY_RE.test(char);
}

// `@` (people) and `#` (channels) share identical mechanics (§ directive
// 2026-07-09): a boundary-anchored, name-like query. A non-matching query just
// yields an empty dropdown that dismisses gracefully — never a false commit.
function isValidInProgressQuery(_trigger: TriggerChar, query: string): boolean {
  return query.length <= 48 && MENTION_QUERY_RE.test(query);
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
    if (char === "@" || char === "#") {
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
