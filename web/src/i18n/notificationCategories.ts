// Real backend NotificationSummary.category DATA values (not UI copy) — the
// backend crates author these as Korean literals directly (see
// backend/crates/{notices,messenger,workflow}/adapter-postgres/src/lib.rs),
// so there is no English enum to compare against. Kept in its own file under
// src/i18n/ (same Hangul-allowed directory as ko.ts, per check-ui-strings)
// rather than inside ko.ts itself, since this lane must not edit ko.ts.
export const NOTIFICATION_CATEGORY = {
  messenger: "메신저",
  notice: "공지",
} as const;

// Comms-rail category chip copy. `NotificationSummary.category` is an OPEN
// producer string (notifications/domain calls it "extensible"): the real
// backend producers already author Korean literals (결재/메신저/공지), but other
// producers and the dev seed emit bare English keys (leave/support/finance),
// which the rail was rendering RAW ('leave'/'support' on every screen). Map the
// known keys to their Korean label and pass anything else through unchanged, so
// an already-localized literal survives and an unknown key degrades to itself
// rather than to a crash or a blank. i18n/ is the Hangul-allowed home for this
// (same rule as NOTIFICATION_CATEGORY above), keeping ko.ts untouched.
const CATEGORY_LABEL: Record<string, string> = {
  leave: "연차",
  support: "지원",
  finance: "재무",
  approval: "결재",
  dispatch: "배차",
  work: "정비",
  messenger: "메신저",
  notice: "공지",
  hr: "인사",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category.trim().toLowerCase()] ?? category;
}
