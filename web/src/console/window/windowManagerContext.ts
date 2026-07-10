import { createContext, useContext } from "react";

import type { WindowEntry, WindowState } from "./windowModel";

export interface WindowManagerContextValue {
  pinnedId: string | null;
  minimizedIds: string[];
  entries: ReadonlyMap<string, WindowEntry>;
  panelWidth: number;
  narrow: boolean;
  stateOf: (id: string) => WindowState;
  /** Add/replace an entry, applying any user-saved state for its id (no forced pin). */
  register: (entry: WindowEntry) => void;
  /** Open the object as the right pin (§4.7-3 default open gesture). */
  open: (entry: WindowEntry) => void;
  minimize: (id: string) => void;
  /** Bring a minimized/default entry back as the pinned panel. */
  restore: (id: string) => void;
  /** Close the panel → object returns to grid/default (X control). */
  close: (id: string) => void;
  /** Pin toggle: pin the entry, or unpin it (→ default) when it is already pinned. */
  togglePin: (entry: WindowEntry) => void;
  setPanelWidth: (width: number) => void;
  /** Persist the current arrangement as the user's saved layout. */
  saveLayout: () => void;
  /** Reset every window to the default arrangement and clear the saved layout. */
  restoreDefault: () => void;
}

export const WindowManagerContext = createContext<WindowManagerContextValue | null>(null);

export function useWindowManager(): WindowManagerContextValue {
  const value = useContext(WindowManagerContext);
  if (!value) {
    throw new Error("useWindowManager must be used within a WindowManagerProvider");
  }
  return value;
}

/**
 * Non-throwing accessor: returns null when rendered outside a provider. Screens
 * that offer an optional pin gesture (e.g. the object explorer, which is unit
 * tested without a shell) use this so they degrade to their base behavior.
 */
export function useOptionalWindowManager(): WindowManagerContextValue | null {
  return useContext(WindowManagerContext);
}

/** Ergonomic consumer hook for opening an object as a right pin (§4.7-3). */
export function usePinnedPanel(): {
  open: (entry: WindowEntry) => void;
  close: (id: string) => void;
  pinnedId: string | null;
} {
  const { open, close, pinnedId } = useWindowManager();
  return { open, close, pinnedId };
}
