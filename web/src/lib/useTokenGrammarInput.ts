import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";

/**
 * Editor binding for the token grammar (DESIGN.md §4.7-7): tracks the trigger
 * the caret is currently inside (if any) so a caller can render a candidate
 * dropdown, and commits a chosen candidate via `confirmToken` — the ONLY
 * commit path (wire it to click/Tab in the dropdown UI). Space/Enter are
 * intentionally not wired to anything here, so normal typing is never
 * hijacked; Esc (or moving the caret out of the token) clears `activeTrigger`,
 * which is enough to "revert to plain text" since the raw text was never
 * mutated in the first place.
 */

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
// Kept permissive (any order/count of these chars) while typing — the strict
// shape lives in tokenGrammar.ts's CODE_LINK_RE, checked once the token is
// committed. The length cap below must stay >= that regex's max capture
// length (8 + 1 + 10 + 1 + 6 = 26, for "!AAAAAAAA-NNNNNNNNNN-NNNNNN") so a
// legitimate two-segment code like "WO-20260612-001" is never rejected
// mid-typing.
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
 * inertness rules as `tokenGrammar.ts`'s parser, applied to in-progress text.
 */
export function detectActiveTrigger(
  text: string,
  cursorIndex: number,
): ActiveTrigger | null {
  const upToCursor = text.slice(0, cursorIndex);
  for (let i = upToCursor.length - 1; i >= 0; i -= 1) {
    const char = upToCursor[i];
    if (BOUNDARY_RE.test(char) && char !== "(" && char !== "[" && char !== "{") {
      return null; // hit whitespace before finding a trigger — caret isn't in a token
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
  /** Room actually available in the chosen direction, capped at
   * `dropdown.height` — apply as the dropdown's CSS `max-height` (with
   * `overflow-y: auto`) so a tall candidate list scrolls internally instead
   * of clipping past the viewport edge. */
  maxHeight: number;
}

const EDGE_MARGIN = 8;

/** Pure viewport-flip/clamp math for the candidate dropdown (DESIGN §4.7-7:
 * "뷰포트를 벗어나 잘리지 않게 graceful 처리"). */
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

type FieldElement = HTMLTextAreaElement | HTMLInputElement;

export interface UseTokenGrammarInputResult {
  inputRef: RefObject<FieldElement | null>;
  activeTrigger: ActiveTrigger | null;
  /** Which candidate (by code) the dropdown UI currently highlights — the
   * consumer owns arrow-key navigation over its candidate list and just
   * mirrors the highlighted code here so Tab has something to confirm.
   * Resets to `null` whenever the trigger/query changes. */
  highlightedCode: string | null;
  setHighlightedCode: (code: string | null) => void;
  /** Commit a candidate's code at the active trigger. Call this ONLY from a
   * click handler in the dropdown UI — Tab is wired internally via
   * `handleKeyDown` against `highlightedCode`. */
  confirmToken: (code: string) => void;
  /** Esc (or anything that should close the dropdown without changing text). */
  cancel: () => void;
  handleChange: (event: ChangeEvent<FieldElement>) => void;
  handleKeyDown: (event: KeyboardEvent<FieldElement>) => void;
  handleSelect: (event: SyntheticEvent<FieldElement>) => void;
  /** Wire both onto the field — an IME composing a Korean/Japanese/Chinese
   * character fires intermediate input events with incomplete text, so
   * trigger detection and confirm are suspended until composition ends. */
  handleCompositionStart: () => void;
  handleCompositionEnd: (event: CompositionEvent<FieldElement>) => void;
}

export function useTokenGrammarInput(
  value: string,
  onChange: (next: string) => void,
): UseTokenGrammarInputResult {
  const inputRef = useRef<FieldElement | null>(null);
  const [activeTrigger, setActiveTrigger] = useState<ActiveTrigger | null>(null);
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    inputRef.current?.setSelectionRange(caret, caret);
  }, [value]);

  const recompute = useCallback((nextValue: string, cursor: number | null) => {
    setActiveTrigger(cursor === null ? null : detectActiveTrigger(nextValue, cursor));
    setHighlightedCode(null);
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<FieldElement>) => {
      const nextValue = event.currentTarget.value;
      onChange(nextValue);
      // While an IME composition is in flight the text is provisional
      // (e.g. mid-way through building a Korean syllable) — detecting a
      // trigger against it would flicker/misfire. `handleCompositionEnd`
      // recomputes once the final text lands.
      if (composingRef.current) return;
      recompute(nextValue, event.currentTarget.selectionStart);
    },
    [onChange, recompute],
  );

  const handleSelect = useCallback(
    (event: SyntheticEvent<FieldElement>) => {
      if (composingRef.current) return;
      recompute(event.currentTarget.value, event.currentTarget.selectionStart);
    },
    [recompute],
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<FieldElement>) => {
      composingRef.current = false;
      recompute(event.currentTarget.value, event.currentTarget.selectionStart);
    },
    [recompute],
  );

  const cancel = useCallback(() => {
    setActiveTrigger(null);
    setHighlightedCode(null);
  }, []);

  const confirmToken = useCallback(
    (code: string) => {
      if (!activeTrigger || composingRef.current) return;
      const cursor = inputRef.current?.selectionStart ?? value.length;
      const raw = `${activeTrigger.trigger}${code}`;
      const next = `${value.slice(0, activeTrigger.start)}${raw} ${value.slice(cursor)}`;
      pendingCaretRef.current = activeTrigger.start + raw.length + 1;
      setActiveTrigger(null);
      setHighlightedCode(null);
      onChange(next);
    },
    [activeTrigger, value, onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<FieldElement>) => {
      if (event.key === "Escape") {
        cancel();
        return;
      }
      // Tab is the second of the spec's two confirm gestures (click/Tab —
      // never Space/Enter). It only fires while a candidate is highlighted;
      // otherwise Tab keeps its normal browser behavior (move focus).
      if (event.key === "Tab" && activeTrigger && highlightedCode && !composingRef.current) {
        event.preventDefault();
        confirmToken(highlightedCode);
      }
      // Space/Enter deliberately do nothing special: typing proceeds normally
      // and the next onChange re-derives activeTrigger from the new text.
    },
    [cancel, activeTrigger, highlightedCode, confirmToken],
  );

  return {
    inputRef,
    activeTrigger,
    highlightedCode,
    setHighlightedCode,
    confirmToken,
    cancel,
    handleChange,
    handleKeyDown,
    handleSelect,
    handleCompositionStart,
    handleCompositionEnd,
  };
}
