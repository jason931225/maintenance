import { createContext, useContext } from "react";

import type { ScreenKey } from "./types";

// Provided by ConsoleShell to the mounted screens so a row can pin itself to the
// screen it belongs to. A screen rendered outside ConsoleShell (e.g. an isolated
// unit test) sees `null`, and PinButton renders nothing — the page still works.
export const ConsoleScreenContext = createContext<ScreenKey | null>(null);

export function useConsoleScreen(): ScreenKey | null {
  return useContext(ConsoleScreenContext);
}
