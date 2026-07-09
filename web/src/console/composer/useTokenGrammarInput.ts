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

import { detectActiveTrigger, type ActiveTrigger } from "./grammar";

/**
 * Editor binding for the token grammar (DESIGN §4.7-7) — TRANSFERRED pure logic
 * (charter D4). Tracks the trigger the caret is currently inside so the composer
 * can render a candidate dropdown, and commits a chosen candidate via
 * `confirmToken` — the ONLY commit path, wired to click/Tab only. Space/Enter
 * are deliberately not wired to anything here, so normal prose typing is never
 * hijacked; Esc (or moving the caret out of the token) clears `activeTrigger`,
 * which reverts to plain text since the raw text was never mutated.
 */

type FieldElement = HTMLTextAreaElement | HTMLInputElement;

export interface UseTokenGrammarInputResult {
  inputRef: RefObject<FieldElement | null>;
  activeTrigger: ActiveTrigger | null;
  /** Which candidate (by code) the dropdown currently highlights — the composer
   * owns arrow-key navigation and mirrors the highlighted code here so Tab has
   * something to confirm. Resets to `null` when the trigger/query changes. */
  highlightedCode: string | null;
  setHighlightedCode: (code: string | null) => void;
  /** Commit a candidate's code at the active trigger. Call ONLY from a click
   * handler — Tab is wired internally via `handleKeyDown` against `highlightedCode`. */
  confirmToken: (code: string) => void;
  /** Esc (or anything that should close the dropdown without changing text). */
  cancel: () => void;
  handleChange: (event: ChangeEvent<FieldElement>) => void;
  handleKeyDown: (event: KeyboardEvent<FieldElement>) => void;
  handleSelect: (event: SyntheticEvent<FieldElement>) => void;
  /** An IME composing a CJK character fires intermediate input events with
   * incomplete text, so trigger detection/confirm are suspended until it ends. */
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
      // Mid-IME-composition text is provisional (e.g. a half-built Korean
      // syllable) — detecting a trigger against it would flicker/misfire.
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
      // Tab is the second of the spec's two confirm gestures (click/Tab — never
      // Space/Enter). It fires only while a candidate is highlighted; otherwise
      // Tab keeps its normal browser behavior (move focus).
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
