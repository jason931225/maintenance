export const NOTIFICATION_COUNTS_INVALIDATED =
  "maintenance:notification-counts-invalidated";

export function publishNotificationCountsInvalidated() {
  window.dispatchEvent(new Event(NOTIFICATION_COUNTS_INVALIDATED));
}
