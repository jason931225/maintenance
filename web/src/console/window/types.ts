// Carbon-copy window/pin engine — types (charter §3 P0.2).
//
// The model is a VERBATIM carbon copy of the prototype's card engine
// (`Oyatie Console.dc.html`, cardVal/cardFloat/cardLayout/cardMin), NOT the
// legacy `features/workspace` quadrant-panel system (that is the prototype's
// separate `panels`/`snapTo` mechanism — see prototype-anatomy/01 "do not
// conflate"). Every card lives in one of four states:
//   grid          — laid out in its zone's main/side column (default)
//   popout-float  — position:fixed free window, no space reservation
//   pin-split     — docked side/bottom panel that RESERVES real body padding
//   tray-minimize — hidden, a chip in the docked task tray
//
// `scr` (screen key) is a free string so the engine is a standalone primitive:
// each host screen supplies its own `CardRegistry`. Prototype screens were
// hr|review|att|pay; the demo harness supplies its own.

/** Horizontal magnet anchor for a float. `null` = free (un-anchored) pixel x. */
export type Anchor = "left" | "cx" | "right" | null;
/** Vertical magnet anchor for a float. `null` = free (un-anchored) pixel y. */
export type VAnchor = "top" | "cy" | "bottom" | null;
/** Which edge a pinned (space-reserving) float docks to. */
export type Dock = "right" | "bottom";

/**
 * A card popped out of its zone. `pinned:false` = free-floating popout (overlay,
 * no space reservation); `pinned:true` = docked pin-split (reserves body padding
 * via {@link bodyPad}). `ax`/`ay` are semantic anchors re-resolved on chrome /
 * viewport change ({@link reanchorFloat}) so the window re-flows correctly.
 */
export interface CardFloat {
  x: number;
  y: number;
  w: number;
  h: number;
  ax: Anchor;
  ay: VAnchor;
  pinned: boolean;
  dock?: Dock;
}

/** Per-screen card order + per-card height overrides + main/side split ratio. */
export interface ScreenLayout {
  main: string[];
  side: string[];
  /** Explicit px height overrides; absent id = budget-auto height. */
  h: Record<string, number>;
  /** main-column width fraction, clamped 0.42‥0.78. */
  split: number;
}

/** Static per-screen card registry entry (the prototype's CARD_META). */
export interface CardMeta {
  /** Vertical px consumed by the page header above the card zone. */
  off: number;
  main: string[];
  side: string[];
  /** Per-card minimum height (budget-fill weight + floor). */
  min: Record<string, number>;
}

/** scr → its card metadata. Supplied by the host screen. */
export type CardRegistry = Record<string, CardMeta>;
/** scr → cardId → human title (resolved from i18n; never a hardcoded literal). */
export type CardTitles = Record<string, Record<string, string>>;

/** A card minimized to the docked task tray. */
export interface MinEntry {
  scr: string;
  id: string;
}

/** The full persisted+live engine state. */
export interface WindowState {
  layout: Record<string, ScreenLayout>;
  min: MinEntry[];
  /** keyed by `${scr}:${id}`. */
  float: Record<string, CardFloat>;
}

export interface Viewport {
  vw: number;
  vh: number;
}

/** Sidebar/comms-rail collapse state — shifts the usable main-content band. */
export interface Chrome {
  sidebarCollapsed: boolean;
  railCollapsed: boolean;
}

/** float map key. */
export function floatKey(scr: string, id: string): string {
  return `${scr}:${id}`;
}

/**
 * Presence-checked record read. The project does not enable
 * `noUncheckedIndexedAccess`, so a bare `rec[key]` is typed as always-present;
 * this returns `T | undefined` across the function boundary so the real runtime
 * "key may be absent" case stays type-safe (and lint-clean).
 */
export function lookup<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined;
}

/** Computed geometry for one card within a render pass. */
export interface CardBox {
  /** CSS left (px string or calc()). */
  x: string;
  /** CSS width (px string or calc()). */
  w: string;
  /** top in px. */
  y: number;
  /** height in px. */
  h: number;
  vis: boolean;
}

export interface ComputedLayout {
  cards: Record<string, CardBox>;
  /** total content height (for the scroll container). */
  contH: number;
  narrow: boolean;
  /** split as a percentage (e.g. 63). */
  split: number;
}
