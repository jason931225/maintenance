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
