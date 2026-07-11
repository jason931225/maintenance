// Sidebar nav count badges, fed from REAL person-scoped counts — the same two
// sources the overview screen already consumes (/api/v1/me/action-inbox and
// /api/v1/me/notifications/summary), so a badge can never disagree with the
// screen it points at. Only the counts that actually exist on those feeds are
// mapped: 전자결재/배차/고객 접수/내 업무 come from the action inbox and 개인
// 수신함 from the unread notification summary. Nav slots with no cheap count
// source on hand (근태·연차·…) stay un-badged rather than showing a fabricated
// number (§4-25-⑥). Both loads fail soft — a badge feed must never break the
// shell — so an unreachable API just leaves the nav un-badged.

import { useEffect, useState } from "react";

import { createCommsRailApi, createOverviewApi } from "../screens/overview/overviewApi";
import type {
  ActionInboxResponse,
  NotificationCountsSummary,
} from "../screens/overview/overviewModel";
import type { NavBadge } from "./Sidebar";

export function deriveNavBadges(
  inbox: ActionInboxResponse | undefined,
  counts: NotificationCountsSummary | undefined,
): Record<string, NavBadge | undefined> {
  const badges: Record<string, NavBadge | undefined> = {};
  const items = inbox?.items ?? [];
  const countKind = (kind: string) => items.filter((item) => item.kind === kind).length;

  const set = (screen: string, count: number, urgent = false): void => {
    if (count > 0) badges[screen] = { count, tone: urgent ? "urgent" : "neutral" };
  };

  // 전자결재 / 배차 carry an urgency signal (an approval due "now", a dispatch
  // past its SLA tone) → red badge; the rest are neutral tallies.
  set(
    "appr",
    countKind("approval"),
    items.some((item) => item.kind === "approval" && item.urg === "now"),
  );
  set(
    "dispatch",
    countKind("dispatch"),
    items.some((item) => item.kind === "dispatch" && item.dueTone !== "neutral"),
  );
  set("support", countKind("support"));
  set("mywork", items.length);

  const unread = (counts?.by_category ?? []).reduce((sum, category) => sum + category.unread, 0);
  set("inbox", unread);

  return badges;
}

export function useNavBadges(accessToken?: string): Record<string, NavBadge | undefined> {
  const [badges, setBadges] = useState<Record<string, NavBadge | undefined>>({});
  useEffect(() => {
    let live = true;
    const inboxApi = createOverviewApi(accessToken);
    const railApi = createCommsRailApi(accessToken);
    void Promise.all([
      inboxApi.loadInbox().catch(() => undefined),
      railApi.loadNotificationCounts().catch(() => undefined),
    ]).then(([inbox, counts]) => {
      if (!live) return;
      setBadges(deriveNavBadges(inbox, counts));
    });
    return () => {
      live = false;
    };
  }, [accessToken]);
  return badges;
}
