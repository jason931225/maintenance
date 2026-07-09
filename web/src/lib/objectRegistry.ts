import type { ConsoleIconName } from "../components/console/icons";
import type { Tone } from "../components/console/primitives";
import { ko } from "../i18n/ko";
import { safeLabel } from "./utils";

/**
 * Object kinds with an Oyatie console identity (DESIGN.md §2 catalog). This is
 * the single dispatch point for "kind -> {code prefix, chip tone, icon, route,
 * label}" — every registry consumer (chips, drag tokens, palette results,
 * token-grammar candidates) reads through here instead of re-deriving these
 * per screen. `objectRegistry` below is a `Record<ObjectKind, …>`, so adding a
 * kind here without a matching registry entry is a compile error.
 */
export type ObjectKind =
  | "approval"
  | "workOrder"
  | "support"
  | "attendance"
  | "payroll"
  | "contract"
  | "journal"
  | "intake"
  | "person"
  | "org";

export type ObjectChipTone = Tone;

export interface ObjectRef {
  /** Route/id-scoped identifier (a UUID for most kinds). */
  id: string;
  /** Issued code (e.g. "AP-3121"). Absent for id/name-referenced kinds (person, org). */
  code?: string;
  /** Human label, if known. Never a raw UUID — run through `safeLabel` before use. */
  name?: string | null;
}

export interface ObjectRefEntry {
  /** DESIGN.md §2 code prefix, including the trailing "-". Kinds referenced by
   * id/name rather than an issued code (person, org unit) have none. */
  codePrefix?: string;
  chipTone: ObjectChipTone;
  icon: ConsoleIconName;
  /** Human kind label for accessible names, e.g. "결재". */
  kindLabel: string;
  route: (ref: ObjectRef) => string;
  formatLabel: (ref: ObjectRef) => string;
}

const withPrefix = (prefix: string, ref: ObjectRef) =>
  ref.code ?? `${prefix}${ref.id}`;

export const objectRegistry: Record<ObjectKind, ObjectRefEntry> = {
  approval: {
    codePrefix: "AP-",
    chipTone: "accent",
    icon: "fileCheck",
    kindLabel: ko.console.objectKinds.approval,
    // UI-M4: the AP- object is a workflow-engine run — its detail lives on the
    // 전자결재 ConsoleShell screen, keyed by the full run id (not the display code).
    route: (ref) => `/e-approvals?run=${encodeURIComponent(ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  workOrder: {
    codePrefix: "WO-",
    chipTone: "info",
    icon: "wrench",
    kindLabel: ko.console.objectKinds.workOrder,
    route: (ref) => `/work-orders/${encodeURIComponent(ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  support: {
    codePrefix: "CS-",
    chipTone: "warn",
    icon: "msg",
    kindLabel: ko.console.objectKinds.support,
    route: (ref) => `/support?ticket=${encodeURIComponent(withPrefix("CS-", ref))}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  attendance: {
    codePrefix: "AT-",
    chipTone: "ok",
    icon: "calCheck",
    kindLabel: ko.console.objectKinds.attendance,
    route: (ref) => `/attendance?exception=${encodeURIComponent(withPrefix("AT-", ref))}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  payroll: {
    codePrefix: "PS-",
    chipTone: "purple",
    icon: "receipt",
    kindLabel: ko.console.objectKinds.payroll,
    route: (ref) => `/payroll?run=${encodeURIComponent(withPrefix("PS-", ref))}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  contract: {
    codePrefix: "C-",
    chipTone: "neutral",
    icon: "scroll",
    kindLabel: ko.console.objectKinds.contract,
    route: (ref) => `/financial?contract=${encodeURIComponent(withPrefix("C-", ref))}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  journal: {
    codePrefix: "JL-",
    chipTone: "info",
    icon: "book",
    kindLabel: ko.console.objectKinds.journal,
    route: (ref) => `/daily-plan?journal=${encodeURIComponent(withPrefix("JL-", ref))}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  intake: {
    codePrefix: "IN-",
    chipTone: "warn",
    icon: "inbox",
    kindLabel: ko.console.objectKinds.intake,
    route: (ref) => `/intake?ref=${encodeURIComponent(withPrefix("IN-", ref))}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  person: {
    chipTone: "purple",
    icon: "users",
    kindLabel: ko.console.objectKinds.person,
    route: (ref) => `/settings/employees?person=${encodeURIComponent(ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  org: {
    chipTone: "neutral",
    icon: "network",
    kindLabel: ko.console.objectKinds.org,
    route: (ref) => `/settings/org?unit=${encodeURIComponent(ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
};

/**
 * Resolve which registered kind a code belongs to from its prefix
 * (e.g. "AP-3121" -> "approval"). Returns `undefined` for codes that don't
 * match any registered prefix — callers must treat that as "unknown/not
 * linkable", never guess.
 */
export function kindFromCode(code: string): ObjectKind | undefined {
  const dashIndex = code.indexOf("-");
  if (dashIndex <= 0) return undefined;
  const prefix = code.slice(0, dashIndex + 1);
  for (const [kind, entry] of Object.entries(objectRegistry) as Array<
    [ObjectKind, ObjectRefEntry]
  >) {
    if (entry.codePrefix === prefix) return kind;
  }
  return undefined;
}

/** Work-order display code: the real backend has no "WO-" prefix on `request_no`
 * (`^[0-9]{8}-[0-9]{3}$`) — this applies the design-grammar prefix for chips/links. */
export function workOrderCode(requestNo: string): string {
  return `WO-${requestNo}`;
}
