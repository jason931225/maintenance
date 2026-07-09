import { useEffect, useMemo } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { NOTIFICATION_COUNTS_INVALIDATED } from "../../lib/notification-events";
import {
  FEATURES,
  hasAnyFeatureGrant,
  isNavItemVisible,
} from "../../components/shell/nav";
import { realtimeHub } from "./realtimeHub";
import {
  loadCounts,
  loadMessengerThreads,
  loadNotifications,
  useCommsStore,
  type CommsGates,
} from "./store";

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  (typeof window !== "undefined" ? window.location.origin : "");

const REFRESH_INTERVAL_MS = 30_000;

// Mounted once by the comms rail (which is present on every console screen). It
// owns the shell's badge fetches, the notification feed, the invalidation
// subscription, and the single shared realtime socket — everything the sidebar
// badges and topbar bell used to each fetch on their own.
export function useCommsRuntime(
  api: ConsoleApiClient,
  session: AuthSession | undefined,
): void {
  const token = session?.access_token;
  const currentUserId = session?.user_id;
  const roles = session?.roles;
  const groupRoles = session?.group_roles;
  const featureGrants = session?.feature_grants;

  const gates = useMemo<CommsGates>(
    () => ({
      approvals: isNavItemVisible("approvals", roles, groupRoles, featureGrants),
      support: isNavItemVisible("support", roles, groupRoles, featureGrants),
      messenger: isNavItemVisible("messenger", roles, groupRoles, featureGrants),
      mail: hasAnyFeatureGrant(featureGrants, [FEATURES.MAIL_USE]),
    }),
    [roles, groupRoles, featureGrants],
  );

  useEffect(() => {
    if (!token) return undefined;
    const accessToken = token;

    function loadBadges() {
      void loadCounts(api, gates);
      if (gates.messenger) void loadMessengerThreads(api);
    }
    function loadAll() {
      loadBadges();
      void loadNotifications(apiBaseUrl, accessToken);
    }

    loadAll();
    // Mutations elsewhere (reading a thread, resolving a ticket) fire this to
    // re-pull the badge counts; the feed refreshes on its own via WS + poll.
    window.addEventListener(NOTIFICATION_COUNTS_INVALIDATED, loadBadges);
    const timer = window.setInterval(loadAll, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener(NOTIFICATION_COUNTS_INVALIDATED, loadBadges);
      window.clearInterval(timer);
    };
  }, [api, token, gates]);

  useEffect(() => {
    if (!token) return undefined;
    return realtimeHub.subscribe({ baseUrl: apiBaseUrl, accessToken: token }, (event) => {
      const store = useCommsStore.getState();
      if (event.type === "message_posted") {
        // Suppress the unread bump for a thread the rail already has open (its
        // thread view marks read server-side).
        const openThreadId =
          store.subview.kind === "thread" ? store.subview.threadId : undefined;
        store.dispatchMessenger({
          type: "realtimeEventReceived",
          event,
          selectedThreadId: openThreadId,
          currentUserId,
        });
        // Keep the badge live: bump for another user's message outside the open
        // thread. Reading (which fires the counts-invalidated event) re-pulls the
        // authoritative count.
        const fromMe = event.message.sender_id === currentUserId;
        const isOpen = event.message.thread_id === openThreadId;
        if (!fromMe && !isOpen) {
          store.setCounts({ messenger: store.counts.messenger + 1 });
        }
      } else {
        store.applyNotificationCreated(event.notification);
      }
    });
  }, [token, currentUserId]);
}
