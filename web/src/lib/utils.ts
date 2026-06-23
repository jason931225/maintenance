import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import { ko } from "../i18n/ko";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Matches a canonical UUID (v4 et al.) so we never surface one as a label. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` looks like a raw backend identifier (a UUID). */
export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * Render a human-readable label, never a raw UUID. Returns the first candidate
 * that is a non-empty, non-UUID string; otherwise the built-in "unknown" label
 * (`ko.common.unknownLabel`). Pass a custom human fallback as the final
 * argument for cases that want a different default. Use everywhere a
 * `value ?? id` pattern would otherwise leak an internal identifier into the UI.
 */
export function safeLabel(
  ...args: Array<string | null | undefined>
): string {
  // The caller MAY pass a custom fallback as the final argument. We always have
  // a built-in default so a bare `safeLabel(maybeName)` is safe on its own.
  const candidates = args;
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      candidate.trim() &&
      !isUuid(candidate)
    ) {
      return candidate;
    }
  }
  return ko.common.unknownLabel;
}

/**
 * Render the signed-in user's identity for display chrome (topbars, badges):
 * display name, then email, then the supplied generic label — NEVER the raw
 * `user_id` UUID. `generic` is the final fallback (a localized role/user label).
 */
export function identityLabel(
  session: { display_name?: string; email?: string } | undefined,
  generic: string,
): string {
  const name = session?.display_name?.trim();
  if (name && !isUuid(name)) return name;
  const email = session?.email?.trim();
  if (email) return email;
  return generic;
}

/**
 * Today's date as YYYY-MM-DD in Korea Standard Time — the business date used for
 * request/plan/report fields. The viewer's UTC date (new Date().toISOString())
 * records the PREVIOUS day during 00:00–09:00 KST, so always resolve in
 * Asia/Seoul regardless of the browser's timezone. en-CA yields ISO YYYY-MM-DD.
 */
export function todayInSeoul(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}
