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
  };
  presets: {
    liveCount: string;
    statBar: string;
    chart: string;
  };
  widget: {
    totalAria: (type: string, count: number) => string;
    countAria: (label: string, count: number) => string;
    chartAria: (type: string) => string;
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
