/**
 * Transport-independent contract for the console communications rail.
 *
 * This module deliberately contains no display copy.  A rail view translates
 * `code` values with the console i18n catalog; data adapters only expose
 * authoritative server values and safe drill targets.
 */
export type CommsRailSource = "messenger" | "mail" | "notifications" | "notices";

export type CommsRailTarget =
  | { kind: "inline"; source: "messenger" | "mail" | "notices"; id: string }
  | { kind: "full-screen"; route: string; source: CommsRailSource; id?: string };

export type CommsRailAction =
  | { kind: "mark-messenger-read"; threadId: string; lastMessageId: string }
  | { kind: "mark-mail-read"; threadId: string }
  | { kind: "mark-notification-read"; notificationId: string };

interface CommsRailItemBase {
  id: string;
  source: CommsRailSource;
  /** Server timestamp, retained for deterministic ordering and display. */
  occurredAt: string;
  /** A non-localized source or decoder code suitable for telemetry/i18n. */
  code: string;
  unread: boolean;
  target?: CommsRailTarget;
  action?: CommsRailAction;
}
export interface MessengerRailItem extends CommsRailItemBase {
  source: "messenger";
  title: string | null;
  branchId: string;
  visibility: "channel" | "direct";
  unreadCount: number;
  muted: boolean;
  memberCount: number;
}

export interface MailRailItem extends CommsRailItemBase {
  source: "mail";
  subject: string;
  unreadCount: number;
  messageCount: number;
  hasAttachments: boolean;
  flagged: boolean;
}

export interface NotificationRailItem extends CommsRailItemBase {
  source: "notifications";
  category: string;
  notificationKind: string;
  text: string;
}

export interface NoticeRailItem extends CommsRailItemBase {
  source: "notices";
  title: string;
  status: "published";
}

export type CommsRailItem =
  | MessengerRailItem
  | MailRailItem
  | NotificationRailItem
  | NoticeRailItem;

export type CommsRailLoadState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "denied"; status: 401 | 403 }
  | { kind: "malformed"; code: "malformed_response" }
  | { kind: "error"; code: "network_error" | "server_error" }
  | { kind: "ready"; items: readonly CommsRailItem[]; loadedAt: string };

export type CommsRailSnapshot = Readonly<Record<CommsRailSource, CommsRailLoadState>>;

export interface CommsRailGeneration {
  principalId: string;
  organizationId: string;
  branchIds: readonly string[];
  /** Ignored compatibility field. Store identity is derived from the fields above. */
  key?: string;
}

/** Canonical non-secret cache boundary. Caller-supplied opaque keys are ignored. */
export function commsRailGenerationFingerprint(generation: CommsRailGeneration): string {
  return JSON.stringify({
    principalId: generation.principalId,
    organizationId: generation.organizationId,
    branchIds: [...new Set(generation.branchIds)].sort(),
  });
}

export const COMMS_RAIL_SOURCES: readonly CommsRailSource[] = [
  "messenger",
  "mail",
  "notifications",
  "notices",
] as const;

export function loadingCommsRailSnapshot(): CommsRailSnapshot {
  return {
    messenger: { kind: "loading" },
    mail: { kind: "loading" },
    notifications: { kind: "loading" },
    notices: { kind: "loading" },
  };
}

export function unreadCount(items: readonly CommsRailItem[]): number {
  return items.reduce((total, item) => total + (item.source === "messenger" || item.source === "mail"
    ? item.source === "messenger" && item.muted ? 0 : item.unreadCount
    : item.unread ? 1 : 0), 0);
}
