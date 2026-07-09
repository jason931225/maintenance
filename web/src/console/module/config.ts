import type { ConsoleApiClient } from "../../api/client";
import type { Tone } from "../composer/objectKinds";

/**
 * ModuleConfig — the single config object that drives the ONE generic
 * ModuleScreen (charter §3 P0.4, prototype `MOD_SCREENS`). Every module surface
 * (finance/purchase/inventory/asset/maintenance/field/compliance/board/…) is
 * data-only specialization of this config; the component is never forked
 * (DESIGN §4-18 "same shape drawn twice = violation").
 *
 * The CONTRACT here is complete — all five generic display fields are declared
 * (`lanes`/`prog`/`stock`/`tl`/`ctl`). `lanes` + `prog` render today; the rest
 * render a dev-loud unimplemented error until their slice lands (silent stubs
 * are banned). See `IMPLEMENTED_FIELDS`.
 */

/** One rendered list cell — DATA, never a React element (§ renderer contract). */
export interface ModuleCell {
  text: string;
  /** Semantic tone → chip styling via TONE(); omit for plain text. */
  tone?: Tone;
  /** Render in the mono face (codes, quantities). */
  mono?: boolean;
}

export interface ModuleColumn<Row> {
  key: string;
  header: string;
  /** Default column width in px; a user drag overrides it (component state). */
  width: number;
  /** Legibility minimum for the resize drag (DESIGN §4.7.1). */
  minWidth?: number;
  align?: "start" | "end";
  cell: (row: Row) => ModuleCell;
}

/** One entry in the compact 1-row stat bar (never a big-number KPI card). */
export interface ModuleStat {
  key: string;
  label: string;
  value: string;
  tone?: Tone;
}

export interface ModuleKv {
  key: string;
  label: string;
  value: string;
}

/** A detail link chip — an object reference by code (kind derived from prefix). */
export interface ModuleLink {
  code: string;
  label?: string;
}

/** A domain primary action on a detail row. Gated through PolicyGated by
 * `policy`; `run` performs a REAL mutation and resolves a short toast label. */
export interface ModuleAction<Row> {
  key: string;
  label: string;
  policy: string;
  tone?: Tone;
  run: (row: Row, api: ConsoleApiClient) => Promise<string>;
}

export interface ModuleLaneCard {
  id: string;
  title: string;
  sub?: string;
  tone?: Tone;
}

export interface ModuleLane {
  id: string;
  label: string;
  tone?: Tone;
  cards: ModuleLaneCard[];
}

/**
 * Generic display field. The union is the complete contract; only `lanes` and
 * `prog` are implemented in P0.4. `stock`/`tl`/`ctl` are declared so every
 * consuming config can commit to the shape now, but the component throws a
 * dev-loud error if one is configured before its slice ships.
 */
export type ModuleField<Row> =
  | { kind: "lanes"; lanes: (rows: Row[]) => ModuleLane[] }
  | { kind: "prog"; progress: (rows: Row[]) => { done: number; total: number } }
  // ── declared, not yet implemented (dev-loud error until their slice) ──
  | { kind: "stock" } // inventory qty-bar matrix — inventory module slice
  | { kind: "tl" } // asset lifecycle timeline — asset module slice
  | { kind: "ctl" }; // control→evidence matrix — compliance module slice

export const IMPLEMENTED_FIELDS = new Set<ModuleField<unknown>["kind"]>(["lanes", "prog"]);

export interface ModuleConfig<Row> {
  /** Stable module key (test ids, fidelity selectors). */
  key: string;
  title: string;
  rowId: (row: Row) => string;
  /** Primary row label — J/K announce, detail title, lane card title. */
  rowTitle: (row: Row) => string;
  columns: ModuleColumn<Row>[];
  statbar: (rows: Row[]) => ModuleStat[];
  /** Lowercased multi-attribute haystack a search query is matched against. */
  search: (row: Row) => string;
  detail: {
    kv: (row: Row) => ModuleKv[];
    links: (row: Row) => ModuleLink[];
    actions: (row: Row) => ModuleAction<Row>[];
  };
  /** Header primary action (create/compose). Gated through PolicyGated. */
  primaryAction?: { key: string; label: string; policy: string };
  /** Optional generic display field (kanban / progress / …). */
  field?: ModuleField<Row>;
  /** Live read — the config binds its OWN real endpoint (charter: real data,
   * end to end). Returns the row list; the component owns loading/error states. */
  load: (api: ConsoleApiClient) => Promise<Row[]>;
}
