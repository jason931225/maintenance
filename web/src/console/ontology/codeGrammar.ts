// Single dynamic source for the object-code grammar's prefix set. Every code
// parser — objDrag (drag/drop reference tokens), messengerModel (#code markers
// in chat), composeModel (approval targets) — builds its regex from HERE, so a
// newly-registered object type's code prefix becomes drag/parse-able with NO
// code edit once the registry is primed (`primeCodePrefixes`, fed by the
// bootstrap fetch of GET /api/v1/object-types via typeRegistrySource).
//
// Fail-closed / offline: before the fetch lands, on any fetch/parse failure,
// and in tests, the static FALLBACK set (the seeded prefixes) keeps the grammar
// working. A failed load never empties or narrows the grammar below the
// fallback (see `primeCodePrefixes` union semantics), and recognising a token
// as an object code is NOT authorisation — object rendering and drop stay
// PBAC-gated downstream (authorizedObjectCodes / canAccept) regardless.

/** Seeded object-code prefixes — the offline/pre-load/failure floor. */
export const FALLBACK_CODE_PREFIXES = [
  "AP", "WO", "AT", "CS", "JL", "PS", "IN", "DX", "Bid", "MT",
  "EV", "OT", "SR", "PAY", "EQ", "VC", "FL", "HR", "TK", "C", "R",
] as const;

let activePrefixes: string[] = [...FALLBACK_CODE_PREFIXES];
let cache = compile(activePrefixes);

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A grammar prefix is one or more ASCII alnum chars, leading letter. */
function isPrefixLike(prefix: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(prefix);
}

interface Compiled {
  /** `(?:AP|WO|…)` — the prefix alternation group. */
  prefixSource: string;
  /** `(?:AP|WO|…)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*` — the whole code body. */
  bodySource: string;
  code: RegExp; // \bBODY\b — non-global (exec/test; no shared lastIndex)
  codeGlobal: RegExp; // \bBODY\b — global (matchAll only)
  refToken: RegExp; // \[(BODY)\s+([^\]]+)\] — bracketed drag token
  partial: RegExp; // ^(?:…)-[A-Za-z0-9-]*$ — incomplete token-before-caret
}

function compile(prefixes: string[]): Compiled {
  // Longest-first: a regex alternation is left-biased, so a multi-letter prefix
  // must precede any single-letter one sharing its initial (C vs a hypothetical
  // "CS"). Backtracking would recover anyway, but ordering avoids the pathology.
  const alts = [...new Set(prefixes)]
    .filter(isPrefixLike)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map(escapeRegExp)
    .join("|");
  const prefixSource = `(?:${alts})`;
  const bodySource = `${prefixSource}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*`;
  return {
    prefixSource,
    bodySource,
    code: new RegExp(`\\b${bodySource}\\b`),
    codeGlobal: new RegExp(`\\b${bodySource}\\b`, "g"),
    refToken: new RegExp(`\\[(${bodySource})\\s+([^\\]]+)\\]`),
    partial: new RegExp(`^${prefixSource}-[A-Za-z0-9-]*$`),
  };
}

/**
 * Union the registry's code prefixes into the active grammar. Union — not
 * replace — so a backend that ever omits a seeded prefix can never silently
 * break an existing ref; in prod the seeded set is a subset of the registry, so
 * union is a no-op there. Accepts either bare ("WD") or trailing-dash ("WD-")
 * forms (the registry stores the latter); ignores null/blank prefixes
 * (id/name-referenced kinds) and non-prefix-shaped junk. Idempotent.
 */
export function primeCodePrefixes(prefixes: Iterable<string | null | undefined>): void {
  const next = new Set(activePrefixes);
  for (const raw of prefixes) {
    const prefix = raw?.replace(/-+$/, "").trim();
    if (prefix && isPrefixLike(prefix)) next.add(prefix);
  }
  if (next.size === activePrefixes.length) return; // unchanged — keep cached regexes
  activePrefixes = [...next];
  cache = compile(activePrefixes);
}

/** Reset to the static fallback. Test isolation only. */
export function resetCodePrefixes(): void {
  activePrefixes = [...FALLBACK_CODE_PREFIXES];
  cache = compile(activePrefixes);
}

export function objectCodePrefixes(): readonly string[] {
  return activePrefixes;
}

/** The code-body regex source, for consumers that build their own combined pattern. */
export function objectCodeBodySource(): string {
  return cache.bodySource;
}

/** `\bCODE\b` — non-global; safe to share for exec/test. */
export function objectCodeRegex(): RegExp {
  return cache.code;
}

/** `\bCODE\b` global — for `String.prototype.matchAll` (which clones, so shareable). */
export function objectCodeGlobalRegex(): RegExp {
  return cache.codeGlobal;
}

/** `[CODE title]` bracketed drag token. */
export function objectRefTokenRegex(): RegExp {
  return cache.refToken;
}

/** `^PREFIX-…$` — an incomplete code being typed (token-before-caret autocomplete). */
export function objectCodePartialRegex(): RegExp {
  return cache.partial;
}
