/**
 * Korea-Standard-Time datetime formatting.
 *
 * Backend timestamps are RFC3339 UTC instants (e.g. `2026-06-12T09:00:00Z`).
 * Rendering them with naive string slicing (`value.slice(0, 16)`) or
 * `toLocaleString` without a timezone shows the UTC wall-clock — nine hours off
 * for Korean users. Every user-facing timestamp MUST go through one of these
 * helpers so it reads in `Asia/Seoul` regardless of the viewer's browser TZ.
 *
 * `null`, empty, and unparseable inputs render an em dash so the UI never shows
 * `Invalid Date` or a blank where a time is expected.
 */

/** Placeholder for a missing or unparseable timestamp. */
const EMPTY = "—";

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Parse to a valid Date, or `null` for null/empty/invalid input. */
function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Read the Intl parts into a stable `YYYY-MM-DD HH:mm` shape. `ko-KR` formats
 * with locale separators (`2026. 06. 12. 18:00`); we normalize to the compact
 * dash form the dispatch UI has always used, but in the correct timezone.
 */
function isoParts(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

/** `YYYY-MM-DD HH:mm` in KST. Empty placeholder for missing/invalid input. */
export function formatKoreanDateTime(iso: string | null | undefined): string {
  const date = toDate(iso);
  if (!date) return EMPTY;
  const p = isoParts(DATE_TIME_FORMAT.formatToParts(date));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** `YYYY-MM-DD` in KST. Empty placeholder for missing/invalid input. */
export function formatKoreanDate(iso: string | null | undefined): string {
  const date = toDate(iso);
  if (!date) return EMPTY;
  const p = isoParts(DATE_FORMAT.formatToParts(date));
  return `${p.year}-${p.month}-${p.day}`;
}

/** `HH:mm` in KST. Empty placeholder for missing/invalid input. */
export function formatKoreanTime(iso: string | null | undefined): string {
  const date = toDate(iso);
  if (!date) return EMPTY;
  const p = isoParts(TIME_FORMAT.formatToParts(date));
  return `${p.hour}:${p.minute}`;
}

const RELATIVE = new Intl.RelativeTimeFormat("ko-KR", { numeric: "auto" });

/**
 * Largest-unit relative phrase anchored to `now`. The Korean wording comes from
 * the `ko-KR` locale data via Intl.RelativeTimeFormat, never from an inline
 * literal, so this file stays free of hardcoded UI strings. Inputs within ~45s
 * of `now` read as the locale's zero-offset phrase.
 */
export function formatRelativeKo(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  const date = toDate(iso);
  if (!date) return EMPTY;
  const diffSec = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 45) return RELATIVE.format(0, "second");
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secondsInUnit] of units) {
    if (abs >= secondsInUnit) {
      return RELATIVE.format(Math.round(diffSec / secondsInUnit), unit);
    }
  }
  return RELATIVE.format(0, "second");
}
