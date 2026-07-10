// UI copy is injected, never inlined — check-ui-strings forbids Hangul here.
// This lane references ko.console.ontology.* (manifest applied by the serial
// i18n wire-up); the typed accessor below keeps the module compiling and
// testable both before and after the keys land in ko.ts.
import { ko } from "../../i18n/ko";
import type {
  ActionDispatch,
  FieldKind,
  ManagerSubtab,
  OntCardinality,
  SchemaLifecycle,
} from "./types";

export interface OntologyManagerStrings {
  typeList: {
    title: string;
    rowAria: (code: string, title: string) => string;
    addName: string;
    addSubmit: string;
  };
  stage: Record<SchemaLifecycle, string>;
  version: (version: number) => string;
  stagedVersion: (version: number) => string;
  backing: Record<"projected" | "instance", string>;
  instanceCount: (count: number) => string;
  count: (count: number) => string;
  staging: {
    pending: string;
    fourEyes: string;
    approve: string;
    discard: string;
  };
  subtabsAria: string;
  subtabs: Record<ManagerSubtab, string>;
  fieldKind: Record<FieldKind, string>;
  cardinality: Record<OntCardinality, string>;
  dispatch: Record<ActionDispatch, string>;
  properties: {
    required: string;
    policy: string;
    addName: string;
    addType: string;
    addSubmit: string;
  };
  links: {
    addName: string;
    addTarget: string;
    addCardinality: string;
    addSubmit: string;
  };
  actionEditor: {
    addName: string;
    addDispatch: string;
    addSubmit: string;
  };
  analyticEditor: {
    addName: string;
    addFormula: string;
    addSubmit: string;
  };
  instances: {
    rowAria: (code: string) => string;
  };
  empty: string;
  samples: {
    types: { workOrder: string; equipment: string; memo: string };
    props: {
      title: string;
      priority: string;
      assignee: string;
      due: string;
      cost: string;
      model: string;
      commissioned: string;
      body: string;
    };
    links: { equipment: string; workOrders: string };
    actions: { reassign: string; complete: string };
    analytics: { delayDays: string };
    instances: { wo2643: string; wo2650: string; eq118: string };
  };
}

/** ko.console.ontology — typed accessor (keys land via the serial i18n wire-up). */
export function ontologyStrings(): OntologyManagerStrings {
  return (ko.console as typeof ko.console & { ontology: OntologyManagerStrings }).ontology;
}
