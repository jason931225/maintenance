// Typed contract for ko.console.configconsole. The koManifest now lives in
// ko.ts (serial i18n wire-up landed); CONFIG_CONSOLE_STRINGS re-exports it.
import { ko } from "../../i18n/ko";

export interface ConfigConsoleStrings {
  screenAria: string;
  chips: {
    personal: string;
    saved: string;
    deployPending: string;
  };
  config: {
    toggle: string;
    toggleAria: string;
    restore: string;
  };
  slot: {
    aria: (n: number) => string;
    add: string;
    addAria: (n: number) => string;
    remove: string;
    removeAria: (n: number) => string;
    presetAria: (n: number) => string;
    objectTypeAria: (n: number) => string;
    groupByAria: (n: number) => string;
    groupByNone: string;
    statTypesAria: (n: number) => string;
    /** design delta 96 — add-widget dedup guard toast (optional, see widgetKinds). */
    dedupBlocked?: string;
  };
  presets: {
    liveCount: string;
    statBar: string;
    chart: string;
  };
  /**
   * design delta 94+96 — count/trend/dist replace liveCount/statBar/chart.
   * Optional + merged with an English fallback (below) so this lane never
   * edits ko.ts directly; the serial wire-up promotes these into
   * ko.console.configconsole.widgetKinds/widget.trend* once landed.
   */
  widgetKinds?: {
    count: string;
    trend: string;
    dist: string;
  };
  widget: {
    totalAria: (type: string, count: number) => string;
    countAria: (label: string, count: number) => string;
    chartAria: (type: string) => string;
    trendAria?: (type: string) => string;
    trendLoading?: string;
    trendError?: string;
    trendEmpty?: string;
  };
  save: {
    action: string;
    comment: string;
  };
  deploy: {
    action: string;
    panelTitle: string;
    submit: string;
    prefillCode: string;
    screenField: string;
    screenValue: string;
    versionField: string;
    widgetsField: string;
    widgetsValue: (count: number) => string;
    docAria: string;
    close: string;
  };
  drill: {
    panelTitle: string;
    listAria: string;
    countChip: (count: number) => string;
    openObject: (code: string) => string;
    close: string;
  };
}

/**
 * Test-only seed of the real key path (ko.console.configconsole). The i18n
 * wire-up landed, so the key always exists and `??=` never fires; kept so
 * tests written against it keep passing unchanged.
 */
export function seedConfigConsoleStrings(koTree: { console: object }): void {
  const consoleTree = koTree.console as { configconsole?: ConfigConsoleStrings };
  consoleTree.configconsole ??= CONFIG_CONSOLE_STRINGS;
}

export const CONFIG_CONSOLE_STRINGS: ConfigConsoleStrings = ko.console.configconsole;

/** English defaults for the design-delta-94+96 optional keys, pending ko.ts wire-up. */
const NEW_KEY_FALLBACK = {
  widgetKinds: { count: "Count", trend: "Trend", dist: "Distribution" },
  trendAria: (type: string) => `${type} trend`,
  trendLoading: "Loading trend…",
  trendError: "Trend unavailable",
  trendEmpty: "No revision history yet",
  dedupBlocked: "That widget is already on the dashboard",
};

export type ConfigConsoleStringsFilled = ConfigConsoleStrings & {
  widgetKinds: NonNullable<ConfigConsoleStrings["widgetKinds"]>;
  widget: ConfigConsoleStrings["widget"] &
    Required<Pick<ConfigConsoleStrings["widget"], "trendAria" | "trendLoading" | "trendError" | "trendEmpty">>;
  slot: ConfigConsoleStrings["slot"] & Required<Pick<ConfigConsoleStrings["slot"], "dedupBlocked">>;
};

/** Read-time merge of the real ko.console.configconsole with the new-key fallback above. */
export function configConsoleStrings(): ConfigConsoleStringsFilled {
  const base = CONFIG_CONSOLE_STRINGS;
  return {
    ...base,
    widgetKinds: base.widgetKinds ?? NEW_KEY_FALLBACK.widgetKinds,
    widget: {
      ...base.widget,
      trendAria: base.widget.trendAria ?? NEW_KEY_FALLBACK.trendAria,
      trendLoading: base.widget.trendLoading ?? NEW_KEY_FALLBACK.trendLoading,
      trendError: base.widget.trendError ?? NEW_KEY_FALLBACK.trendError,
      trendEmpty: base.widget.trendEmpty ?? NEW_KEY_FALLBACK.trendEmpty,
    },
    slot: {
      ...base.slot,
      dedupBlocked: base.slot.dedupBlocked ?? NEW_KEY_FALLBACK.dedupBlocked,
    },
  };
}
