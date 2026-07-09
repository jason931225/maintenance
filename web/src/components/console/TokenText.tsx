import { useMemo } from "react";

import { kindFromCode, objectRegistry, type ObjectKind, type ObjectRef } from "../../lib/objectRegistry";
import { parseTokenGrammar } from "../../lib/tokenGrammar";
import { cn } from "../../lib/utils";
import { ObjectChip } from "./primitives";

export interface TokenTextProps {
  text: string;
  /**
   * Resolve a token to a real object. Return `undefined` for anything unknown
   * OR unauthorized — deny-by-omission (DESIGN §4.5) means TokenText never
   * distinguishes the two, it just renders the raw trigger text as inert
   * plain text instead of a chip/link (§4.7-7: "권한 없는 개체는… 링크되지
   * 않는다"). Callers populate this from data they already fetched through a
   * permission-scoped endpoint — this component performs no authorization
   * check of its own.
   */
  resolveObject?: (kind: ObjectKind, code: string) => ObjectRef | undefined;
  onOpen?: (kind: ObjectKind, code: string) => void;
  className?: string;
}

/**
 * Renders stored token-grammar text (DESIGN §4.7-7) with `@mention` styling
 * and `#object-link`/`!code-link` chips via the object registry. Extends
 * `components/text/MentionText.tsx`'s span-rendering pattern to all three
 * trigger kinds and real object resolution instead of bare mention styling.
 */
export function TokenText({ text, resolveObject, onOpen, className }: TokenTextProps) {
  const spans = useMemo(() => parseTokenGrammar(text), [text]);

  return (
    <span className={cn("whitespace-pre-wrap", className)}>
      {spans.map((span, index) => {
        if (span.kind === "text") {
          return <span key={`text-${String(index)}`}>{span.value}</span>;
        }

        // ponytail: `@` only resolves to "person" — DESIGN §4.7-7 also allows
        // 부서/법인 (org-unit/team) mentions, but no candidate provider for
        // those was in UI-M2a's scope. Add an org/team provider + branch this
        // on the resolved candidate's kind (not a hardcoded literal) when
        // that lands.
        const kind: ObjectKind | undefined =
          span.kind === "mention" ? "person" : kindFromCode(span.value);
        const resolved = kind ? resolveObject?.(kind, span.value) : undefined;

        if (!kind || !resolved) {
          // Unknown prefix or unresolved/unauthorized object: never a dead link.
          return <span key={`${span.kind}-${String(index)}`}>{span.raw}</span>;
        }

        const label = objectRegistry[kind].formatLabel(resolved);

        if (span.kind === "mention") {
          return (
            <span
              key={`mention-${String(index)}`}
              className="font-semibold text-console-teal"
              data-mention={resolved.id}
            >
              @{label}
            </span>
          );
        }

        return (
          <ObjectChip
            key={`${span.kind}-${String(index)}`}
            kind={kind}
            code={resolved.code ?? span.value}
            label={label}
            onOpen={onOpen ? () => { onOpen(kind, span.value); } : undefined}
          />
        );
      })}
    </span>
  );
}
