// Carbon-copy lifecycle card — dev-only capture harness (charter §3 P0.5).
//
// A self-contained mount so the fidelity rig can capture the card's distinct
// states in isolation, without ConsoleApp or the P0.1 shell (which this slice
// must not touch). `?state=` drives a deterministic fixture render for the
// component-state captures; `?live=1` mounts the REAL LifecycleCard bound to a
// document object so a real-backend session can drive an actual transition.
// NOT a product surface — mounted at /console-dev/lifecycle.

import "../tokens.css";

import { type ReactNode } from "react";
import { useSearchParams } from "react-router";

import { LifecycleCard } from "./LifecycleCard";
import { LifecycleCardView } from "./LifecycleCardView";
import { DOCUMENT_CHAIN } from "./chain";
import { disposeBlockedFixture, historyFixture, stepperFixture } from "./demoFixtures";
import type { Lifecycle } from "./types";

// A document object with a live lifecycle row on the real backend. The `?live`
// path renders against it; on the preview server (no backend) it shows the
// absent/loading notice, which is expected.
const LIVE_OBJECT_ID = "00000000-0000-0000-0000-0000000cae05";

const FIXTURES: Record<string, { record: Lifecycle; mode?: "asOf" }> = {
  stepper: { record: stepperFixture },
  history: { record: historyFixture },
  "dispose-block": { record: disposeBlockedFixture },
  asof: { record: historyFixture, mode: "asOf" },
};

export function LifecycleHarness() {
  const [params] = useSearchParams();

  const wrap = (children: ReactNode) => (
    <div
      className="console"
      data-console-root
      data-lifecycle-harness
      style={{
        display: "flex",
        justifyContent: "center",
        minHeight: "100dvh",
        padding: "var(--sp-6)",
        background: "var(--canvas)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {children}
    </div>
  );

  if (params.get("live") === "1") {
    return wrap(<LifecycleCard objectType="document" objectId={LIVE_OBJECT_ID} mode="live" />);
  }

  const fixture = FIXTURES[params.get("state") ?? "stepper"] ?? FIXTURES.stepper;
  return wrap(
    <LifecycleCardView
      chain={DOCUMENT_CHAIN}
      record={fixture.record}
      mode={fixture.mode ?? "live"}
      asOfDate={fixture.record.updatedAt.slice(0, 10)}
      today="2026-06-06"
      onTransition={() => undefined}
      onSetHold={() => undefined}
    />,
  );
}
