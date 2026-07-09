import "./tokens.css";

/**
 * ConsoleApp — the carbon-copy console's root, mounted at `/console` inside the
 * shared auth provider (P0.0, charter D1/§3).
 *
 * P0.0 is scaffold-only: a single empty themed viewport that carries the
 * `.console` token scope and fills the screen with `var(--canvas)`. No chrome
 * (ConsoleShell arrives in P0.1), no shadcn, no Tailwind utility classes — the
 * carbon-copy mandate is zero visual inheritance from the legacy AppShell, so
 * every value here resolves through `tokens.css`. `scripts/check-console-purity.mjs`
 * enforces that structurally.
 *
 * The internal navigation model is `state.screen`-driven (prototype-style), not
 * React-Router pages; nothing to render for it yet in P0.0.
 */
export function ConsoleApp() {
  return (
    <div
      className="console"
      data-console-root
      style={{
        minHeight: "100dvh",
        width: "100%",
        background: "var(--canvas)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
      }}
    />
  );
}
