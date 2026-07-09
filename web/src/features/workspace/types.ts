// Workspace window-engine types (UI-M1b).
//
// The console workspace is a 2x2 quadrant grid. The page body <section> takes
// the largest free rectangle; pinned detail panels take quadrant/half areas so
// content reflows into a true split (not an overlay). Float panels are
// position:fixed popouts; minimized panels live in the bottom tray.

export const SCREEN_KEYS = ["overview", "attendance", "eApprovals"] as const;
export type ScreenKey = (typeof SCREEN_KEYS)[number];

export const QUADRANTS = ["tl", "tr", "bl", "br"] as const;
export type Quadrant = (typeof QUADRANTS)[number];

// A panel occupies a quadrant or a half. Section fills the complement.
export const PANEL_AREAS = [
  "tl",
  "tr",
  "bl",
  "br",
  "left",
  "right",
  "top",
  "bottom",
] as const;
export type PanelArea = (typeof PANEL_AREAS)[number];

// Snap drop zones during a header drag: 4 corners + 4 edges + center (no-pin).
export type SnapZone = PanelArea | "center";

// Object kinds a row can be pinned as. Kept local to the workspace (not the
// shared ObjectChip set) so the persisted-state sanitizer has an explicit
// allowlist and unknown kinds from an older/newer client are dropped on load.
export const PIN_KINDS = [
  "workOrder",
  "support",
  "approval",
  "dailyPlan",
  "conversation",
  "attendance",
  "person",
  "org",
] as const;
export type PinKind = (typeof PIN_KINDS)[number];

export interface PinField {
  label: string;
  value: string;
}

// The real object a panel renders. `(kind, code)` is the dedupe identity
// within a screen (two pins of the same object collapse to one).
export interface PinnedObject {
  kind: PinKind;
  code: string;
  title: string;
  fields: PinField[];
  href?: string;
  /** Backend row id (UUID / ticket id) for the live-detail fetch when the panel
   * mounts (UI-M2a). Absent → the panel renders only its pinned snapshot (kinds
   * with no detail endpoint, or a pin created without an id). */
  refId?: string;
}

export type PanelMode = "pinned" | "float" | "minimized";

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Default popout geometry, used by the reducer (new float), FloatWindow (render
// fallback) and the sanitizer (missing dimensions).
export const DEFAULT_FLOAT_RECT: FloatRect = { x: 64, y: 96, w: 468, h: 412 };

export interface Panel {
  id: string;
  screen: ScreenKey;
  object: PinnedObject;
  mode: PanelMode;
  // Last pinned area — retained across float/minimize so restore returns here.
  area: PanelArea;
  float?: FloatRect;
}

// Schema-versioned persistence envelope stored server-side per person.
export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export interface WorkspaceEnvelope {
  v: typeof WORKSPACE_SCHEMA_VERSION;
  panels: Panel[];
}
