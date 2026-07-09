import { type CSSProperties } from "react";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { ObjectCardView } from "./ObjectCard";
import type { ObjectCardState } from "./useObjectCard";

/**
 * Deterministic render of the object card's distinct states for the fidelity
 * rig (charter P0.6: full 3-layer vs redacted/minimal). Static — no backend, no
 * async settle — each state renders from fixture `ObjectCardState` so a
 * screenshot is reproducible. The `data-fidelity` selectors are the capture
 * targets.
 *
 * ponytail: registered as component states here (matching how P0.3's
 * ComposerDemo shipped its states) rather than a new capture script — the
 * `e2e/fidelity/` visual-regression capture wires these two selectors in once
 * the demo route + P0.2's window-states rig land. Convergence note in the PR.
 */
export type ObjectCardDemoState = "full" | "minimal";

export interface ObjectCardDemoProps {
  state: ObjectCardDemoState;
  /** Fixture card data (test/rig supplies Korean labels — no hardcoded UI strings). */
  full: ObjectCardState;
  minimal: ObjectCardState;
}

// Full 3-layer: every affordance permitted so the add/remove controls render.
const ALLOW_ALL: PolicyGate = { can: () => true };
// Minimal/redacted: mutations denied (deny-by-omission hides add/remove).
const DENY_MUTATIONS: PolicyGate = { can: (action) => action === "object.view" };

const panel: CSSProperties = {
  minHeight: "100dvh",
  padding: "var(--sp-5)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

export function ObjectCardDemo({ state, full, minimal }: ObjectCardDemoProps) {
  const isFull = state === "full";
  const cardState = isFull ? full : minimal;
  const gate = isFull ? ALLOW_ALL : DENY_MUTATIONS;
  const target = { kind: cardState.head?.kind ?? "work_order", id: cardState.head?.id ?? "x" };
  return (
    <div className="console" data-console-root style={panel}>
      <div data-fidelity={`objectcard-${state}`} style={{ maxWidth: 420 }}>
        <PolicyGateProvider gate={gate}>
          <ObjectCardView
            state={cardState}
            target={target}
            onOpenObject={() => undefined}
            onAddRelation={() => Promise.resolve(true)}
            onRemoveRelation={() => undefined}
          />
        </PolicyGateProvider>
      </div>
    </div>
  );
}
