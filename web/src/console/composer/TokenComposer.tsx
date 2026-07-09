import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { ko } from "../../i18n/ko";
import { filterCandidates, type CandidateProvider } from "./candidates";
import { computeDropdownPosition, parseTokenGrammar, type DropdownPlacement, type TriggerChar } from "./grammar";
import { KIND_META, TONE, type ObjectCandidate, type ObjectKind, type ObjectRef } from "./objectKinds";
import { TokenText } from "./TokenText";
import { useTokenGrammarInput } from "./useTokenGrammarInput";

type ProviderMap = Partial<Record<TriggerChar, CandidateProvider>>;
type LoadState = "idle" | "loading" | "error";

export interface TokenComposerProps {
  value: string;
  onChange: (next: string) => void;
  /** Per-trigger candidate lookups. Omit a trigger to disable its dropdown (the
   * trigger still types as plain text). All providers are backed by
   * permission-scoped endpoints, so the dropdown is deny-by-omission. Pass a
   * STABLE (memoized) object — a new identity re-opens the fetch-once session. */
  providers: ProviderMap;
  /** Resolves bare object codes (no trigger) for the live preview. Fetched once
   * when a code first appears; every returned candidate is recorded, so a
   * permitted code links and an unpermitted one stays inert (deny-by-omission).
   * Pass a STABLE (memoized) provider. */
  objectProvider?: CandidateProvider;
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  /** Forwarded to the textarea (e.g. Enter-to-send). Not called while the
   * candidate dropdown is consuming the key. */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Clicking a resolved chip in the live preview. */
  onOpenObject?: (kind: ObjectKind, code: string) => void;
  disabled?: boolean;
  /** Show the live chip preview under the field. */
  showPreview?: boolean;
}

// ponytail: dropdown anchors to the field rect, not the caret glyph — precise
// caret positioning needs a textarea mirror; the field-anchored flip/clamp is
// what keeps the list on-screen (the spec requirement). Add caret-precise
// anchoring if a multi-line field ever needs the list at the caret row.
const DROPDOWN_MAX_HEIGHT = 264;
const ROW_HEIGHT = 34;

function keyFor(kind: ObjectKind, code: string): string {
  return `${kind}:${code}`;
}

function refFor(c: Pick<ObjectCandidate, "kind" | "code" | "label" | "id">): ObjectRef {
  return c.kind === "person"
    ? { id: c.code, name: c.label }
    : { id: c.id ?? c.code, code: c.code, name: c.label };
}

const fieldStyle: CSSProperties = {
  minHeight: 64,
  width: "100%",
  resize: "vertical",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  padding: "var(--sp-2) var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--ink)",
  lineHeight: "var(--lh-base)",
};

/**
 * The single token-grammar composer (§ directive 2026-07-09): a textarea with a
 * candidate dropdown on `@` (mentions) / `#` (channels), bare-code object
 * auto-linking (no trigger), and a live chip preview. Only objects that flow
 * through a permission-scoped provider become resolvable chips — a hand-typed
 * code that never matched a permitted candidate stays inert plain text
 * (deny-by-omission), so `resolveObject` mirrors the server's authorization, it
 * is never the console's own check.
 */
export function TokenComposer({
  value,
  onChange,
  providers,
  objectProvider,
  ariaLabel,
  placeholder,
  rows = 3,
  onKeyDown,
  onOpenObject,
  disabled = false,
  showPreview = true,
}: TokenComposerProps) {
  const {
    inputRef,
    activeTrigger,
    highlightedCode,
    setHighlightedCode,
    confirmToken,
    cancel,
    handleChange,
    handleKeyDown: grammarHandleKeyDown,
    handleSelect,
    handleCompositionStart,
    handleCompositionEnd,
  } = useTokenGrammarInput(value, onChange);

  const [resolved, setResolved] = useState<Record<string, ObjectRef>>({});
  const [rawCandidates, setRawCandidates] = useState<ObjectCandidate[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const listRef = useRef<HTMLUListElement>(null);

  const record = useCallback((c: Pick<ObjectCandidate, "kind" | "code" | "label" | "id">) => {
    setResolved((prev) => ({ ...prev, [keyFor(c.kind, c.code)]: refFor(c) }));
  }, []);

  const resolveObject = useCallback(
    (kind: ObjectKind, code: string): ObjectRef | undefined => resolved[keyFor(kind, code)],
    [resolved],
  );

  const trigger = activeTrigger?.trigger;
  const query = activeTrigger?.query ?? "";
  const triggerStart = activeTrigger?.start;
  const provider = trigger ? providers[trigger] : undefined;

  // Fetch ONE page when a trigger session opens (keyed on provider + trigger
  // position); typing only changes `query`, which re-filters the cached page
  // below — so a burst of keystrokes never refetches. A stale response (the
  // trigger moved on) is discarded via the `live` guard.
  useEffect(() => {
    if (!provider) return undefined;
    const guard = { live: true };
    void (async () => {
      setLoadState("loading");
      const result = await provider();
      if (!guard.live) return;
      if (result.status === "error") {
        setRawCandidates([]);
        setLoadState("error");
        return;
      }
      setRawCandidates(result.candidates);
      setLoadState("idle");
    })();
    return () => {
      guard.live = false;
    };
  }, [provider, triggerStart]);

  const candidates = useMemo(() => filterCandidates(rawCandidates, query), [rawCandidates, query]);
  const showDropdown = Boolean(trigger && provider);

  // Bare-code object links (no trigger): once the text contains any recognized
  // code, fetch the object list ONCE and record every permitted candidate, so
  // the preview auto-links `WO-2643`/`AP-3122`/`C-5`. Deny-by-omission: a code
  // outside the fetched (permission-scoped) set stays inert plain text.
  const hasBareCode = useMemo(
    () => parseTokenGrammar(value).some((s) => s.kind === "codeLink"),
    [value],
  );
  useEffect(() => {
    if (!objectProvider || !hasBareCode) return undefined;
    const guard = { live: true };
    void (async () => {
      const result = await objectProvider();
      if (!guard.live || result.status !== "ok") return;
      setResolved((prev) => {
        const next = { ...prev };
        for (const c of result.candidates) next[keyFor(c.kind, c.code)] = refFor(c);
        return next;
      });
    })();
    return () => {
      guard.live = false;
    };
  }, [objectProvider, hasBareCode]);

  // Viewport flip/clamp: anchor to the field rect, flip above/below on space,
  // clamp max-height at the edge. Positions the dropdown by mutating its DOM
  // node directly (the endorsed layout-effect use) — no state, no cascade.
  useLayoutEffect(() => {
    if (!showDropdown) return;
    const list = listRef.current;
    const field = inputRef.current;
    if (!list || !field) return;
    const rect = field.getBoundingClientRect();
    const natural = Math.min(list.scrollHeight || ROW_HEIGHT, DROPDOWN_MAX_HEIGHT);
    const p = computeDropdownPosition(
      { top: rect.top, bottom: rect.bottom, left: rect.left },
      { width: rect.width, height: natural },
      { width: window.innerWidth, height: window.innerHeight },
    );
    list.style.top = `${String(p.top)}px`;
    list.style.left = `${String(p.left)}px`;
    list.style.maxHeight = `${String(p.maxHeight)}px`;
    list.style.visibility = "visible";
  }, [showDropdown, candidates.length, loadState, value, inputRef]);

  const confirm = useCallback(
    (candidate: ObjectCandidate) => {
      record(candidate);
      confirmToken(candidate.code);
    },
    [record, confirmToken],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown && candidates.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const index = candidates.findIndex((c) => c.code === highlightedCode);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = (index + delta + candidates.length) % candidates.length;
      setHighlightedCode(candidates[next].code);
      return;
    }
    // Esc / Tab (confirm the highlight) are handled inside the hook; everything
    // else — including Space/Enter — falls through to the caller.
    grammarHandleKeyDown(event);
    if (!event.defaultPrevented) onKeyDown?.(event);
  };

  return (
    <div style={{ position: "relative" }} data-console-composer>
      <textarea
        ref={inputRef as RefObject<HTMLTextAreaElement>}
        value={value}
        rows={rows}
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        style={fieldStyle}
        onChange={handleChange}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        // Close on real focus loss. A candidate click can't reach here: its
        // button preventDefaults mousedown, so focus stays and confirm fires.
        onBlur={cancel}
      />

      {showDropdown ? (
        <ComposerDropdown
          ref={listRef}
          candidates={candidates}
          loadState={loadState}
          highlightedCode={highlightedCode}
          onHighlight={setHighlightedCode}
          onConfirm={confirm}
        />
      ) : null}

      {showPreview && value.trim() ? (
        <div style={previewStyle} data-testid="token-composer-preview">
          <span style={previewLabelStyle}>{ko.console.composer.previewLabel}</span>
          <TokenText text={value} resolveObject={resolveObject} onOpen={onOpenObject} />
        </div>
      ) : null}
    </div>
  );
}

const previewStyle: CSSProperties = {
  marginTop: "var(--sp-2)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-soft)",
  background: "var(--surface)",
  padding: "var(--sp-2) var(--sp-3)",
};
const previewLabelStyle: CSSProperties = {
  display: "block",
  marginBottom: "var(--sp-1)",
  fontSize: "var(--text-micro)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--faint)",
};

export interface ComposerDropdownProps {
  candidates: ObjectCandidate[];
  loadState: LoadState;
  /** An explicit placement (fidelity demo / static use). Omit in the live
   * composer, which positions the forwarded `ref` via a layout effect. */
  placement?: DropdownPlacement;
  highlightedCode: string | null;
  onHighlight: (code: string | null) => void;
  onConfirm: (candidate: ObjectCandidate) => void;
}

/** The candidate dropdown — exported so the composer and the fidelity demo draw
 * the identical shape (§4-18 no shape twice). `position:fixed` keeps it clamped
 * to the viewport; the live composer measures + flips it via the forwarded ref,
 * the demo passes an explicit `placement`. */
export const ComposerDropdown = forwardRef<HTMLUListElement, ComposerDropdownProps>(
  function ComposerDropdown(
    { candidates, loadState, placement, highlightedCode, onHighlight, onConfirm },
    ref,
  ) {
  const isEmpty = loadState === "idle" && candidates.length === 0;
  const listStyle: CSSProperties = {
    position: "fixed",
    top: placement?.top ?? 0,
    left: placement?.left ?? 0,
    width: "22rem",
    maxWidth: "calc(100vw - 2 * var(--sp-2))",
    maxHeight: placement?.maxHeight ?? DROPDOWN_MAX_HEIGHT,
    overflowY: "auto",
    zIndex: 40,
    margin: 0,
    padding: "var(--sp-1)",
    listStyle: "none",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    boxShadow: "var(--shadow-pop)",
    // No explicit placement → the composer's layout effect measures + reveals
    // it (never flashing at 0,0). An explicit placement (demo) is visible now.
    visibility: placement ? "visible" : "hidden",
  };

  const noteStyle: CSSProperties = {
    padding: "var(--sp-2) var(--sp-3)",
    fontSize: "var(--text-xs)",
    color: "var(--steel)",
  };

  return (
    <ul ref={ref} aria-label={ko.console.composer.candidatesLabel} style={listStyle} data-testid="token-composer-dropdown">
      {loadState === "loading" ? <li style={noteStyle}>{ko.console.composer.loading}</li> : null}
      {loadState === "error" ? (
        <li style={{ ...noteStyle, color: "var(--danger-tx)" }}>{ko.console.composer.error}</li>
      ) : null}
      {isEmpty ? <li style={noteStyle}>{ko.console.composer.empty}</li> : null}
      {candidates.map((candidate) => {
        const active = candidate.code === highlightedCode;
        const t = TONE(KIND_META[candidate.kind].tone);
        return (
          <li key={`${candidate.kind}:${candidate.code}`}>
            <button
              type="button"
              onMouseEnter={() => { onHighlight(candidate.code); }}
              // Keep textarea focus/caret so confirmToken inserts at the caret.
              onMouseDown={(event) => { event.preventDefault(); }}
              onClick={() => { onConfirm(candidate); }}
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                gap: "var(--sp-2)",
                borderRadius: "var(--radius-sm)",
                border: "none",
                padding: "var(--sp-1) var(--sp-2)",
                textAlign: "left",
                fontSize: "var(--text-xs)",
                cursor: "pointer",
                background: active ? "var(--muted)" : "transparent",
                color: "var(--ink)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: 6,
                  height: 6,
                  borderRadius: "var(--radius-pill)",
                  border: `1px solid ${t.bd}`,
                  background: t.tx,
                }}
              />
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: "var(--fw-medium)" }}>
                {candidate.label}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
});
