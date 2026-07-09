import { ko } from "../../i18n/ko";
import { TONE, kindFromCode } from "../composer";
import type { Tone } from "../composer/objectKinds";

/**
 * Backend object-kind slugs the console object card operates on — the canonical
 * `RESOLVABLE_KIND_AUTH` set from `backend/app/src/objects.rs` (work_order,
 * equipment, account, support_ticket, org_unit, person, approval_run, passkey,
 * consent). The card's `target.kind` is one of these slugs; resolveObject,
 * lifecycle, and object-links all key off the same slug (§4-18: one kind name,
 * not a per-endpoint fork).
 */
export interface SlugMeta {
  tone: Tone;
  labelKey: keyof typeof ko.console.objectCard.kinds;
}

const SLUG_META: Partial<Record<string, SlugMeta>> = {
  work_order: { tone: "info", labelKey: "work_order" },
  equipment: { tone: "neutral", labelKey: "equipment" },
  account: { tone: "purple", labelKey: "account" },
  support_ticket: { tone: "warn", labelKey: "support_ticket" },
  org_unit: { tone: "neutral", labelKey: "org_unit" },
  person: { tone: "purple", labelKey: "person" },
  approval_run: { tone: "accent", labelKey: "approval_run" },
  passkey: { tone: "ok", labelKey: "passkey" },
  consent: { tone: "ok", labelKey: "consent" },
};

/** Korean label for a backend slug; falls back to the raw slug for an
 * unregistered kind (never throws — a link edge may reference a kind the card
 * doesn't know a label for). */
export function slugLabel(slug: string): string {
  const meta = SLUG_META[slug];
  return meta ? ko.console.objectCard.kinds[meta.labelKey] : slug;
}

/** Chip tone triplet for a slug (neutral for unknown). */
export function slugTone(slug: string) {
  return TONE(SLUG_META[slug]?.tone ?? "neutral");
}

/**
 * Composer code prefix -> backend slug, for bare-code relation drawing
 * (kindFromCode gives the composer kind; this maps the linkable subset to the
 * backend slug object-links expects). A code whose kind has no backend slug is
 * NOT linkable — the caller creates no edge (deny-by-omission). Reuses the
 * merged composer `kindFromCode` rather than re-parsing prefixes.
 */
const COMPOSER_KIND_TO_SLUG: Partial<Record<string, string>> = {
  workOrder: "work_order",
  support: "support_ticket",
  approval: "approval_run",
  person: "person",
  org: "org_unit",
};

/** Resolve a typed bare code to a linkable backend (slug, id) pair, or
 * `undefined` when the code's kind isn't a resolvable object (unlinkable). */
export function linkTargetFromCode(code: string): { kind: string; id: string } | undefined {
  const composerKind = kindFromCode(code);
  if (!composerKind) return undefined;
  const slug = COMPOSER_KIND_TO_SLUG[composerKind];
  if (!slug) return undefined;
  // ponytail: dst_id is the issued code as typed — the object-links backend
  // accepts "a UUID or issued code". Canonical code->row-id normalization is a
  // BE-OBJ (canonical codes) concern; note the openapi gap if far-end
  // resolution needs the bare request_no instead of the prefixed code.
  return { kind: slug, id: code.trim() };
}
