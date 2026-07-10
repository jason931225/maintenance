// UI copy is injected, never inlined — check-ui-strings forbids Hangul here and
// this lane must not edit ko.ts (owned by the objectcard lane this phase). The
// Integrate step passes real ko.ts strings; these English defaults keep the
// canvas mountable + testable standalone. All aria-labels route through here.

import type { CanvasNodeKind, PredicateOperator } from "./types";

export interface CanvasStrings {
  /** Accessible name of the whole canvas region. */
  canvasLabel: string;
  emptyCanvas: string;
  /** aria-label for a node card, given its title. */
  nodeAria: (title: string) => string;
  kindLabel: Record<CanvasNodeKind, string>;
  outputsLabel: string;
  /** aria-label of an output-port connect handle. */
  portAria: (label: string) => string;
  /** Announced when a connect drag/keyboard action starts from a port. */
  connectFrom: (port: string) => string;
  connectCancel: string;
  edgeAria: (from: string, to: string) => string;

  // Predicate editor
  predicateLabel: string;
  addPredicate: string;
  removePredicate: string;
  fieldLabel: string;
  operatorLabel: string;
  valueLabel: string;
  operatorName: Record<PredicateOperator, string>;
  joinAnd: string;
  joinOr: string;
  boolTrue: string;
  boolFalse: string;
  /** Drop-zone prompt for an object-code value (objDrag). */
  dropObjectCode: string;

  // Simulation panel
  simulateLabel: string;
  runSimulation: string;
  /** pass/total result, e.g. "3 / 5". */
  simulationResult: (pass: number, total: number) => string;
  samplesLabel: string;
}

/** English fallback. Non-Hangul so check-ui-strings passes; Integrate overrides. */
export const DEFAULT_CANVAS_STRINGS: CanvasStrings = {
  canvasLabel: "Block canvas",
  emptyCanvas: "No blocks",
  nodeAria: (title) => `${title} block`,
  kindLabel: {
    trigger: "Trigger",
    condition: "Condition",
    branch: "Branch",
    action: "Action",
  },
  outputsLabel: "Outputs",
  portAria: (label) => `Connect from ${label}`,
  connectFrom: (port) => `Connecting from ${port}`,
  connectCancel: "Cancel connection",
  edgeAria: (from, to) => `${from} to ${to}`,

  predicateLabel: "Predicate",
  addPredicate: "Add condition",
  removePredicate: "Remove condition",
  fieldLabel: "Field",
  operatorLabel: "Operator",
  valueLabel: "Value",
  operatorName: {
    gte: "at least",
    lte: "at most",
    eq: "equals",
    neq: "not equal",
    in: "in",
  },
  joinAnd: "All",
  joinOr: "Any",
  boolTrue: "True",
  boolFalse: "False",
  dropObjectCode: "Drop an object",

  simulateLabel: "Simulation",
  runSimulation: "Run",
  simulationResult: (pass, total) => `${String(pass)} / ${String(total)}`,
  samplesLabel: "Samples",
};
