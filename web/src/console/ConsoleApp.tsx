import { useCallback, useState } from "react";

import { ConsoleShell } from "./shell/ConsoleShell";
import { nextTheme, themeAttribute } from "./shell/theme";
import type { ThemeMode } from "./shell/theme";
import "./tokens.css";

/**
 * ConsoleApp — the carbon-copy console's root, mounted at `/console` inside the
 * shared auth provider (charter D1/§3).
 *
 * It owns the `.console` token scope (all values resolve through `tokens.css`)
 * and the theme data attribute on that root, then
 * hands the viewport to `ConsoleShell` (P0.1): the sidebar / topbar / comms-rail
 * grid. No shadcn, no Tailwind utility classes, no imports from
 * `components/{ui,shell}` — the carbon-copy mandate is zero visual inheritance
 * from the legacy AppShell, enforced by `scripts/check-console-purity.mjs`.
 *
 * Internal navigation is `state.screen`-driven (owned by `ConsoleShell`), not
 * React-Router pages.
 */
export function ConsoleApp() {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const cycleTheme = useCallback(() => {
    setTheme((t) => nextTheme(t));
  }, []);
  const themeMode = themeAttribute(theme);

  return (
    <div
      className="console"
      data-console-root
      data-console-theme={themeMode}
      style={{
        height: "100dvh",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--canvas)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <ConsoleShell theme={theme} onCycleTheme={cycleTheme} />
    </div>
  );
}
