import { ko } from "../../i18n/ko";

/**
 * Object-kind metadata the composer needs to render chips and resolve `!CODE`
 * links — console-owned (charter D4 "rebuild rendering"), NOT the legacy
 * `lib/objectRegistry.ts` (whose route closures target legacy URLs the console
 * navigates past via `state.screen`). Only what the composer uses lives here:
 * code prefix (for `kindFromCode`), a chip tone, and a Korean kind label.
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

/** Semantic tone key (§4-18 TONE charter) mapped to a token triplet below. */
export type Tone = "accent" | "info" | "warn" | "ok" | "purple" | "danger" | "neutral";

export interface ObjectRef {
  /** Route/id-scoped identifier (a UUID for most kinds). */
  id: string;
  /** Issued code (e.g. "AP-3121"). Absent for id/name-referenced kinds. */
  code?: string;
  /** Human label, if known. */
  name?: string | null;
}

/** A dropdown candidate + the shape `record()` stores for later resolution. */
export interface ObjectCandidate {
  kind: ObjectKind;
  /** Issued code for coded kinds; the user id for `person`. */
  code: string;
  label: string;
  /** Backend row id (UUID) for coded kinds. Absent for `person` (code IS id). */
  id?: string;
  /** Lowercased haystack `filterCandidates` matches against as the query narrows. */
  search: string;
}

interface KindMeta {
  /** DESIGN §2 code prefix incl. trailing "-"; absent for id/name kinds. */
  codePrefix?: string;
  tone: Tone;
  label: string;
}

export const KIND_META: Record<ObjectKind, KindMeta> = {
  approval: { codePrefix: "AP-", tone: "accent", label: ko.console.objectKinds.approval },
  workOrder: { codePrefix: "WO-", tone: "info", label: ko.console.objectKinds.workOrder },
  support: { codePrefix: "CS-", tone: "warn", label: ko.console.objectKinds.support },
  attendance: { codePrefix: "AT-", tone: "ok", label: ko.console.objectKinds.attendance },
  payroll: { codePrefix: "PS-", tone: "purple", label: ko.console.objectKinds.payroll },
  contract: { codePrefix: "C-", tone: "neutral", label: ko.console.objectKinds.contract },
  journal: { codePrefix: "JL-", tone: "info", label: ko.console.objectKinds.journal },
  intake: { codePrefix: "IN-", tone: "warn", label: ko.console.objectKinds.intake },
  person: { tone: "purple", label: ko.console.objectKinds.person },
  org: { tone: "neutral", label: ko.console.objectKinds.org },
};

/**
 * Resolve which kind a code belongs to from its prefix ("AP-3121" -> "approval").
 * Returns `undefined` for unregistered prefixes — callers treat that as
 * "unknown / not linkable", never a guess (deny-by-omission).
 */
export function kindFromCode(code: string): ObjectKind | undefined {
  const dashIndex = code.indexOf("-");
  if (dashIndex <= 0) return undefined;
  const prefix = code.slice(0, dashIndex + 1);
  for (const [kind, meta] of Object.entries(KIND_META) as [ObjectKind, KindMeta][]) {
    if (meta.codePrefix === prefix) return kind;
  }
  return undefined;
}

export interface ToneStyle {
  bg: string;
  bd: string;
  tx: string;
}

/**
 * §4-18 TONE charter: one tone key -> one token triplet, used everywhere a chip
 * is drawn (no shape drawn twice). All values resolve through `tokens.css`.
 */
export function TONE(tone: Tone): ToneStyle {
  switch (tone) {
    case "accent":
      return { bg: "var(--accent-bg)", bd: "var(--accent-bd)", tx: "var(--accent-tx)" };
    case "info":
      return { bg: "var(--info-bg)", bd: "var(--info-bd)", tx: "var(--info-tx)" };
    case "warn":
      return { bg: "var(--warn-bg)", bd: "var(--warn-bd)", tx: "var(--warn-tx)" };
    case "ok":
      return { bg: "var(--ok-bg)", bd: "var(--ok-bd)", tx: "var(--ok-tx)" };
    case "purple":
      return { bg: "var(--purple-bg)", bd: "var(--purple-bd)", tx: "var(--purple-tx)" };
    case "danger":
      return { bg: "var(--danger-bg)", bd: "var(--danger-bd)", tx: "var(--danger-tx)" };
    case "neutral":
      return { bg: "var(--muted)", bd: "var(--border)", tx: "var(--steel)" };
  }
}
