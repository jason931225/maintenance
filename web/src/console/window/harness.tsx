// Carbon-copy window/pin engine — dev-only capture harness (charter §3 P0.2).
//
// A self-contained mount so the fidelity rig can capture the four window states
// in isolation, without ConsoleApp or the P0.1 shell (which this slice must not
// touch). Two demo screens exercise screen-switch float persistence; a `?state`
// query param drives one card into a target state so the rig lands on a
// deterministic screenshot. NOT a product surface — mounted at /console-dev/window.

import "../tokens.css";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { WindowEngine } from "./WindowEngine";
import type { CardRegistry, CardTitles } from "./types";
import { useWindowEngine } from "./useWindowEngine";

const d = ko.console.windowDemo;

const REGISTRY: CardRegistry = {
  a: { off: 214, main: ["roster"], side: ["issues", "board"], min: { roster: 340, issues: 300, board: 360 } },
  b: { off: 176, main: ["teams"], side: ["tasks"], min: { teams: 260, tasks: 240 } },
};
const TITLES: CardTitles = {
  a: { roster: d.cardRoster, issues: d.cardIssues, board: d.cardBoard },
  b: { teams: d.cardTeams, tasks: d.cardTasks },
};

const SCREENS: { key: string; label: string }[] = [
  { key: "a", label: d.screenA },
  { key: "b", label: d.screenB },
];

export function WindowEngineHarness() {
  const { api, session } = useAuth();
  const [params] = useSearchParams();
  const [scr, setScr] = useState("a");
  const ownerKey = session?.user_id;
  const engine = useWindowEngine({ registry: REGISTRY, api, ownerKey });

  // Drive one card into a target state for deterministic fidelity capture.
  const applied = useRef(false);
  const preset = params.get("state");
  useEffect(() => {
    if (applied.current || engine.loading || !preset) return;
    applied.current = true;
    if (preset === "pin-split") engine.pinRight("a", "issues");
    else if (preset === "popout-float") engine.popOut("a", "issues");
    else if (preset === "tray-minimize") engine.minToggle("a", "issues");
    // "grid" (or anything else) leaves the default layout.
  }, [engine, preset]);

  return (
    <div
      className="console"
      data-console-root
      data-window-harness
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100dvh",
        background: "var(--canvas)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-5)",
          padding: "var(--sp-4) var(--sp-6)",
          borderBottom: "var(--border-hairline)",
          background: "var(--surface)",
        }}
      >
        <h1 style={{ fontSize: "var(--text-h1)", fontWeight: 800, letterSpacing: "var(--tracking-tight)" }}>
          {d.title}
        </h1>
        <nav style={{ display: "flex", gap: "var(--sp-2)" }}>
          {SCREENS.map((s) => (
            <button
              key={s.key}
              type="button"
              data-screen-tab={s.key}
              aria-pressed={scr === s.key}
              onClick={() => {
                setScr(s.key);
              }}
              style={{
                padding: "var(--sp-1) var(--sp-4)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: scr === s.key ? "var(--signal)" : "var(--surface)",
                color: scr === s.key ? "#141a21" : "var(--steel)",
                fontSize: "var(--text-body)",
                cursor: "pointer",
              }}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </header>
      <WindowEngine
        engine={engine}
        scr={scr}
        registry={REGISTRY}
        titles={TITLES}
        renderBody={() => <p style={{ margin: 0 }}>{d.body}</p>}
      />
    </div>
  );
}
