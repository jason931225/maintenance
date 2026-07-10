import { useMemo, type CSSProperties } from "react";

import { parseTokenGrammar } from "./grammar";
import { KIND_META, TONE, kindFromCode, type ObjectKind, type ObjectRef } from "./objectKinds";

export interface TokenTextProps {
  text: string;
  /**
   * Resolve a token to a real object. Return `undefined` for anything unknown
   * OR unauthorized — deny-by-omission (DESIGN §4.5): TokenText never
   * distinguishes the two, it just renders the raw trigger text as inert plain
   * text instead of a chip/link (§4.7-7 "권한 없는 개체는 링크되지 않는다").
   * Callers populate this from data they fetched through a permission-scoped
   * endpoint — this component performs no authorization check of its own.
   */
  resolveObject?: (kind: ObjectKind, code: string) => ObjectRef | undefined;
  onOpen?: (kind: ObjectKind, code: string) => void;
}

const wrapStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--ink)",
  lineHeight: "var(--lh-base)",
};

const mentionStyle: CSSProperties = {
  fontWeight: "var(--fw-strong)",
  color: "var(--teal)",
};

function chipStyle(kind: ObjectKind, interactive: boolean): CSSProperties {
  const t = TONE(KIND_META[kind].tone);
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--sp-1)",
    padding: "0 var(--sp-2)",
    height: "1.5em",
    borderRadius: "var(--radius-chip)",
    border: `1px solid ${t.bd}`,
    background: t.bg,
    color: t.tx,
    fontSize: "var(--text-xs)",
    fontWeight: "var(--fw-medium)",
    lineHeight: 1,
    cursor: interactive ? "pointer" : "default",
    verticalAlign: "baseline",
  };
}

/**
 * Renders stored token-grammar text (§ directive 2026-07-09): `@mention`
 * styling, `#channel` chips (navigate → messenger thread), and bare-`CODE`
 * object chips (auto-recognized, no trigger). Maps over the parser's DATA array
 * (`TokenSpan[]`), never over React elements (the legacy `msgParts` crash
 * lesson). An unresolved/unauthorized token renders as inert plain text, never
 * a dead link.
 */
export function TokenText({ text, resolveObject, onOpen }: TokenTextProps) {
  const spans = useMemo(() => parseTokenGrammar(text), [text]);

  return (
    <span style={wrapStyle} data-testid="token-text">
      {spans.map((span, index) => {
        if (span.kind === "text") {
          return <span key={`text-${String(index)}`}>{span.value}</span>;
        }

        // `@` → person, `#` → channel (both resolve by id); a bare code derives
        // its kind from the code prefix (deny-by-omission if unregistered).
        const kind: ObjectKind | undefined =
          span.kind === "mention"
            ? "person"
            : span.kind === "channel"
              ? "channel"
              : kindFromCode(span.value);
        const resolved = kind ? resolveObject?.(kind, span.value) : undefined;

        if (!kind || !resolved) {
          // Unknown prefix or unresolved/unauthorized object: never a dead link.
          return <span key={`${span.kind}-${String(index)}`}>{span.raw}</span>;
        }

        const label = resolved.name?.trim() || resolved.code || span.value;

        if (span.kind === "mention") {
          return (
            <span key={`mention-${String(index)}`} style={mentionStyle} data-mention={resolved.id}>
              @{label}
            </span>
          );
        }

        const code = resolved.code ?? span.value;
        // Channel chips read as `#name` (Slack convention) and skip the raw
        // thread id in the a11y name; coded objects announce their code.
        const isChannel = kind === "channel";
        return (
          <button
            key={`${span.kind}-${String(index)}`}
            type="button"
            style={chipStyle(kind, Boolean(onOpen))}
            aria-label={isChannel ? `${label} ${KIND_META.channel.label}` : `${KIND_META[kind].label} ${code} ${label}`}
            data-object-kind={kind}
            data-object-code={code}
            onClick={onOpen ? () => { onOpen(kind, span.value); } : undefined}
          >
            {isChannel ? `#${label}` : label}
          </button>
        );
      })}
    </span>
  );
}
