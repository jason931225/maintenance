// Zustand workspace store (UI-M1b) — the ONE new runtime dependency, scoped to
// the window/panel engine only (AD-2). Data fetching stays on the openapi-fetch
// client. All mutating logic delegates to the pure reducers in reducer.ts.

import { create } from "zustand";

import {
  clearScreen,
  closePanel,
  minimizePanel,
  moveFloat,
  pinObject,
  popoutPanel,
  restorePanel,
} from "./reducer";
import type {
  FloatRect,
  Panel,
  PanelArea,
  PinnedObject,
  ScreenKey,
  SnapZone,
} from "./types";

interface WorkspaceState {
  panels: Panel[];
  hydrated: boolean;
  // Transient drag state — never persisted.
  snapPreview: SnapZone | null;
  draggingId: string | null;

  hydrate: (panels: Panel[]) => void;
  pin: (screen: ScreenKey, object: PinnedObject, area?: PanelArea) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  popout: (id: string) => void;
  close: (id: string) => void;
  moveFloat: (id: string, rect: FloatRect) => void;
  restoreDefault: (screen: ScreenKey) => void;
  setSnapPreview: (zone: SnapZone | null) => void;
  setDragging: (id: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  panels: [],
  hydrated: false,
  snapPreview: null,
  draggingId: null,

  hydrate: (panels) => {
    set({ panels, hydrated: true });
  },
  pin: (screen, object, area) => {
    set((s) => ({ panels: pinObject(s.panels, screen, object, area) }));
  },
  minimize: (id) => {
    set((s) => ({ panels: minimizePanel(s.panels, id) }));
  },
  restore: (id) => {
    set((s) => ({ panels: restorePanel(s.panels, id) }));
  },
  popout: (id) => {
    set((s) => ({ panels: popoutPanel(s.panels, id) }));
  },
  close: (id) => {
    set((s) => ({ panels: closePanel(s.panels, id) }));
  },
  moveFloat: (id, rect) => {
    set((s) => ({ panels: moveFloat(s.panels, id, rect) }));
  },
  restoreDefault: (screen) => {
    set((s) => ({ panels: clearScreen(s.panels, screen) }));
  },
  setSnapPreview: (zone) => {
    set({ snapPreview: zone });
  },
  setDragging: (id) => {
    set({ draggingId: id });
  },
}));

export function selectScreenPanels(panels: Panel[], screen: ScreenKey): Panel[] {
  return panels.filter((p) => p.screen === screen);
}
