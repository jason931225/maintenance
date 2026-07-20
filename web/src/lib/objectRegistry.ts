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

export const objectRegistry: Record<ObjectKind, ObjectRefEntry> = {
  approval: {
    codePrefix: "AP-",
    chipTone: "accent",
    icon: "fileCheck",
    kindLabel: ko.console.objectKinds.approval,
    route: (ref) => `/approvals?run=${encodeURIComponent(ref.id)}`,
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
    chipTone: "warn",
    icon: "msg",
    kindLabel: ko.console.objectKinds.support,
    route: (ref) => `/support?ticket=${encodeURIComponent(ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  attendance: {
    codePrefix: "AT-",
    chipTone: "ok",
    icon: "calCheck",
    kindLabel: ko.console.objectKinds.attendance,
    route: (ref) =>
      `/attendance?exception=${encodeURIComponent(ref.code ?? ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  payroll: {
    codePrefix: "PS-",
    chipTone: "purple",
    icon: "receipt",
    kindLabel: ko.console.objectKinds.payroll,
    route: (ref) => `/payroll?run=${encodeURIComponent(ref.code ?? ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  contract: {
    codePrefix: "C-",
    chipTone: "neutral",
    icon: "scroll",
    kindLabel: ko.console.objectKinds.contract,
    route: (ref) =>
      `/financial?contract=${encodeURIComponent(ref.code ?? ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  journal: {
    codePrefix: "JL-",
    chipTone: "info",
    icon: "book",
    kindLabel: ko.console.objectKinds.journal,
    route: (ref) =>
      `/daily-plan?journal=${encodeURIComponent(ref.code ?? ref.id)}`,
    formatLabel: (ref) => safeLabel(ref.name, ref.code),
  },
  intake: {
    codePrefix: "IN-",
    chipTone: "warn",
    icon: "inbox",
    kindLabel: ko.console.objectKinds.intake,
    route: (ref) => `/intake?ref=${encodeURIComponent(ref.code ?? ref.id)}`,
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
 * Server-owned action-inbox object reference. The browser deliberately accepts
 * the wire kind as a string so newer server kinds remain forward compatible:
 * unknown kinds are inert until they are explicitly registered here.
 */
export interface ActionInboxObjectLink {
  kind: string;
  id: string;
  label?: string;
}

const ACTION_INBOX_OBJECT_KINDS: Readonly<Partial<Record<string, ObjectKind>>> =
  {
    approval_run: "approval",
    work_order: "workOrder",
    support_ticket: "support",
  };

/**
 * Resolve the first canonical action-inbox source reference in server order.
 *
 * This is intentionally a closed, browser-owned allowlist: blank ids and
 * unknown kinds are skipped, server-provided URLs are never consumed, and no
 * route is inferred from an action item's kind, id, label, or code prefix.
 */
export function resolveActionInboxLinkRoute(
  links: readonly ActionInboxObjectLink[],
): string | undefined {
  for (const link of links) {
    const objectKind = ACTION_INBOX_OBJECT_KINDS[link.kind];
    const id = link.id.trim();
    if (!objectKind || id.length === 0) continue;
    return objectRegistry[objectKind].route({ id });
  }
  return undefined;
}

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
