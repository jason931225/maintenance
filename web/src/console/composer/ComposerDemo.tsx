import { type CSSProperties } from "react";

import { ComposerDropdown } from "./TokenComposer";
import { TokenText } from "./TokenText";
import type { ObjectCandidate, ObjectRef } from "./objectKinds";

/**
 * Deterministic render of the composer's distinct visual states for the
 * fidelity rig (dropdown open / clamped-at-viewport-edge / chip render). Static,
 * no backend, no focus — each state renders in isolation so a screenshot is
 * reproducible. Fixture data is passed IN (the test and the rig supply the
 * Korean labels; this stays app-shippable with no hardcoded UI strings). The
 * `data-fidelity` selectors are the ones `composer.states.json` targets.
 */
export type ComposerDemoState = "dropdown" | "clamped" | "chips";

export interface ComposerDemoProps {
  state: ComposerDemoState;
  candidates: ObjectCandidate[];
  /** `keyFor(kind, code)` -> resolved ref, for the chip state's preview. */
  resolved: Record<string, ObjectRef>;
  /** Stored token text for the chip state. */
  text: string;
}

const panelStyle: CSSProperties = {
  minHeight: "100dvh",
  padding: "var(--sp-5)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

export function ComposerDemo({ state, candidates, resolved, text }: ComposerDemoProps) {
  if (state === "chips") {
    return (
      <div className="console" data-console-root style={panelStyle}>
        <div data-fidelity="composer-chips" style={{ maxWidth: 520 }}>
          <TokenText
            text={text}
            resolveObject={(kind, code) => resolved[`${kind}:${code}`]}
            onOpen={() => undefined}
          />
        </div>
      </div>
    );
  }

  // dropdown / clamped: the exact ComposerDropdown, placed mid-viewport or
  // pinned near the bottom edge to exercise the flip/clamp path.
  const placement =
    state === "clamped"
      ? { top: window.innerHeight - 120, left: 24, placement: "above" as const, maxHeight: 96 }
      : { top: 120, left: 24, placement: "below" as const, maxHeight: 264 };

  return (
    <div className="console" data-console-root style={panelStyle}>
      <div data-fidelity={`composer-${state}`}>
        <ComposerDropdown
          candidates={candidates}
          loadState="idle"
          placement={placement}
          highlightedCode={candidates[0]?.code ?? null}
          onHighlight={() => undefined}
          onConfirm={() => undefined}
        />
      </div>
    </div>
  );
}
