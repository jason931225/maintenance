import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import type { CandidateProvider, ObjectCandidate } from "../../lib/objectCandidates";
import { readDraggedObject, tokenForDraggedObject } from "../../lib/objectDrag";
import { objectRegistry, type ObjectKind, type ObjectRef } from "../../lib/objectRegistry";
import {
  useTokenGrammarInput,
  type TriggerChar,
} from "../../lib/useTokenGrammarInput";
import { cn } from "../../lib/utils";
import { ko } from "../../i18n/ko";
import { consoleIcons } from "./icons";
import { Chip } from "./primitives";
import { TokenText } from "./TokenText";

type ProviderMap = Partial<Record<TriggerChar, CandidateProvider>>;

export interface TokenComposerProps {
  value: string;
  onChange: (next: string) => void;
  /** Per-trigger candidate lookups. Omit a trigger to disable its dropdown
   * (the trigger still types as plain text). All providers are backed by
   * permission-scoped endpoints, so the dropdown is deny-by-omission. */
  providers: ProviderMap;
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  /** Forwarded to the textarea (e.g. Enter-to-send). Not called while the
   * candidate dropdown is consuming the key. */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Clicking a resolved chip in the live preview. */
  onOpenObject?: (kind: ObjectKind, code: string) => void;
  disabled?: boolean;
  /** Show the live chip preview under the field. Off for compact inputs (e.g.
   * the messenger composer) where the sent message already renders chips. */
  showPreview?: boolean;
  /** Extra classes for the textarea — tailwind-merge lets a caller override
   * sizing (e.g. a compact single-line messenger composer). */
  textareaClassName?: string;
}

function keyFor(kind: ObjectKind, code: string): string {
  return `${kind}:${code}`;
}

function refFor(candidate: Pick<ObjectCandidate, "kind" | "code" | "label" | "id">): ObjectRef {
  return candidate.kind === "person"
    ? { id: candidate.code, name: candidate.label }
    : { id: candidate.id ?? candidate.code, code: candidate.code, name: candidate.label };
}

/**
 * The single token-grammar composer (DESIGN §4.7-7): a textarea that renders a
 * live chip preview, a candidate dropdown on `@`/`#`/`!`, and native drag-drop
 * of object rows. Only objects that flow through a provider or a drop become
 * resolvable chips — a hand-typed code that never matched a permitted candidate
 * stays inert plain text (deny-by-omission), so `resolveObject` is the client's
 * authorization mirror, never its own check.
 */
export function TokenComposer({
  value,
  onChange,
  providers,
  ariaLabel,
  placeholder,
  rows = 3,
  onKeyDown,
  onOpenObject,
  disabled = false,
  showPreview = true,
  textareaClassName,
}: TokenComposerProps) {
  const {
    inputRef,
    activeTrigger,
    highlightedCode,
    setHighlightedCode,
    confirmToken,
    insertToken,
    cancel,
    handleChange,
    handleKeyDown: grammarHandleKeyDown,
    handleSelect,
    handleCompositionStart,
    handleCompositionEnd,
  } = useTokenGrammarInput(value, onChange);
  const [resolved, setResolved] = useState<Record<string, ObjectRef>>({});
  const [candidates, setCandidates] = useState<ObjectCandidate[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [dragOver, setDragOver] = useState(false);

  const record = useCallback((candidate: Pick<ObjectCandidate, "kind" | "code" | "label" | "id">) => {
    setResolved((prev) => ({ ...prev, [keyFor(candidate.kind, candidate.code)]: refFor(candidate) }));
  }, []);

  const resolveObject = useCallback(
    (kind: ObjectKind, code: string): ObjectRef | undefined => resolved[keyFor(kind, code)],
    [resolved],
  );

  const trigger = activeTrigger?.trigger;
  const query = activeTrigger?.query ?? "";
  const provider = trigger ? providers[trigger] : undefined;

  // Fetch candidates whenever the active trigger/query changes. A stale response
  // (the trigger moved on) is discarded via the `live` guard. When there is no
  // provider the dropdown is not rendered (`showDropdown`), so leftover
  // candidate state is harmless and left untouched — the next provider fetch
  // overwrites it.
  useEffect(() => {
    if (!provider) return undefined;
    const guard = { live: true };
    void (async () => {
      setLoadState("loading");
      const result = await provider(query);
      if (!guard.live) return;
      if (result.status === "error") {
        setCandidates([]);
        setLoadState("error");
        return;
      }
      setCandidates(result.candidates);
      setLoadState("idle");
    })();
    return () => {
      guard.live = false;
    };
  }, [provider, query]);

  const confirm = useCallback(
    (candidate: ObjectCandidate) => {
      record(candidate);
      confirmToken(candidate.code);
    },
    [record, confirmToken],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      const object = readDraggedObject(event.dataTransfer);
      if (!object) return;
      event.preventDefault();
      setDragOver(false);
      record(object);
      insertToken(tokenForDraggedObject(object));
    },
    [record, insertToken],
  );

  const showDropdown = Boolean(trigger && provider);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown && candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const index = candidates.findIndex((c) => c.code === highlightedCode);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = (index + delta + candidates.length) % candidates.length;
        setHighlightedCode(candidates[nextIndex].code);
        return;
      }
    }
    // Esc / Tab (confirm the highlight) are handled inside the hook; everything
    // else — including Enter — falls through to the caller (e.g. send).
    grammarHandleKeyDown(event);
    if (!event.defaultPrevented) onKeyDown?.(event);
  };

  return (
    <div className="relative">
      <textarea
        ref={inputRef as RefObject<HTMLTextAreaElement>}
        value={value}
        rows={rows}
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        onChange={handleChange}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        // Close the dropdown when focus really leaves the field. Clicking a
        // candidate can't reach here: its button preventDefaults mousedown, so
        // focus never leaves the textarea and confirm still fires.
        onBlur={cancel}
        onDragOver={(event) => {
          if (readDraggedObject(event.dataTransfer) || event.dataTransfer.types.includes("application/x-oyatie-object")) {
            event.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => {
          setDragOver(false);
        }}
        onDrop={onDrop}
        className={cn(
          "min-h-[64px] w-full resize-y rounded-[8px] border bg-console-canvas px-3 py-2 text-[13px] text-console-ink placeholder:text-console-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal",
          dragOver ? "border-console-signal ring-2 ring-console-signal" : "border-console-border",
          textareaClassName,
        )}
      />

      {showDropdown ? (
        <CandidateDropdown
          candidates={candidates}
          loadState={loadState}
          highlightedCode={highlightedCode}
          onHighlight={setHighlightedCode}
          onConfirm={confirm}
        />
      ) : null}

      {showPreview && value.trim() ? (
        <div
          data-testid="token-composer-preview"
          className="mt-2 rounded-[8px] border border-console-border-soft bg-console-surface px-3 py-2 text-[13px] text-console-ink"
        >
          <span className="mb-1 block text-[10px] font-extrabold uppercase text-console-faint">
            {ko.console.composer.previewLabel}
          </span>
          <TokenText text={value} resolveObject={resolveObject} onOpen={onOpenObject} />
        </div>
      ) : null}
    </div>
  );
}

function CandidateDropdown({
  candidates,
  loadState,
  highlightedCode,
  onHighlight,
  onConfirm,
}: {
  candidates: ObjectCandidate[];
  loadState: "idle" | "loading" | "error";
  highlightedCode: string | null;
  onHighlight: (code: string | null) => void;
  onConfirm: (candidate: ObjectCandidate) => void;
}): ReactNode {
  const isEmpty = loadState === "idle" && candidates.length === 0;
  return (
    <ul
      aria-label={ko.console.composer.candidatesLabel}
      className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-[8px] border border-console-border bg-console-surface p-1 shadow-console-pop"
    >
      {loadState === "loading" ? (
        <li className="px-3 py-2 text-[12px] text-console-steel">{ko.console.composer.loading}</li>
      ) : null}
      {loadState === "error" ? (
        <li className="px-3 py-2 text-[12px] text-console-warn-tx">{ko.console.composer.error}</li>
      ) : null}
      {isEmpty ? (
        <li className="px-3 py-2 text-[12px] text-console-steel">{ko.console.composer.empty}</li>
      ) : null}
      {candidates.map((candidate) => {
        const Icon = consoleIcons[objectRegistry[candidate.kind].icon];
        const active = candidate.code === highlightedCode;
        return (
          <li key={`${candidate.kind}:${candidate.code}`}>
            <button
              type="button"
              // Confirm on click (a mouseDown would steal focus + fire the
              // textarea blur before selection is read).
              onMouseEnter={() => {
                onHighlight(candidate.code);
              }}
              onMouseDown={(event) => {
                // Keep textarea focus/caret so confirmToken inserts at the caret.
                event.preventDefault();
              }}
              onClick={() => {
                onConfirm(candidate);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px]",
                active ? "bg-console-muted text-console-ink" : "text-console-steel hover:bg-console-muted/70",
              )}
            >
              <Chip
                tone={objectRegistry[candidate.kind].chipTone}
                className="px-1.5"
                aria-hidden="true"
              >
                <Icon className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              </Chip>
              <span className="min-w-0 flex-1 truncate font-medium text-console-ink">
                {candidate.label}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
