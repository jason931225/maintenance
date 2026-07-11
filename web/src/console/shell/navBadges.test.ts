import { describe, expect, it } from "vitest";

import type { ActionInboxResponse } from "../screens/overview/overviewModel";
import { deriveNavBadges } from "./navBadges";

function inbox(items: ActionInboxResponse["items"]): ActionInboxResponse {
  return { items, total: items.length };
}

const base = {
  urg: "wait" as const,
  ref: "R-1",
  title: "t",
  dueTone: "neutral" as const,
  links: [],
  done: false,
};

describe("deriveNavBadges", () => {
  it("maps action-inbox kinds to their nav slots and flags urgency", () => {
    const badges = deriveNavBadges(
      inbox([
        { ...base, kind: "approval", id: "approval:1", urg: "now", dueTone: "danger" },
        { ...base, kind: "approval", id: "approval:2" },
        { ...base, kind: "dispatch", id: "dispatch:1", dueTone: "warn" },
        { ...base, kind: "support", id: "support:1" },
      ]),
      { by_category: [{ category: "notification", unread: 3 }] } as never,
    );

    expect(badges.appr).toEqual({ count: 2, tone: "urgent" }); // 승인 due "now"
    expect(badges.dispatch).toEqual({ count: 1, tone: "urgent" }); // SLA tone
    expect(badges.support).toEqual({ count: 1, tone: "neutral" });
    expect(badges.mywork).toEqual({ count: 4, tone: "neutral" }); // all items
    expect(badges.inbox).toEqual({ count: 3, tone: "neutral" }); // unread sum
  });

  it("omits a slot entirely when its count is zero (no 0-badge)", () => {
    const badges = deriveNavBadges(inbox([]), undefined);
    expect(badges.appr).toBeUndefined();
    expect(badges.mywork).toBeUndefined();
    expect(badges.inbox).toBeUndefined();
  });

  it("keeps a non-urgent approval badge neutral", () => {
    const badges = deriveNavBadges(
      inbox([{ ...base, kind: "approval", id: "approval:1" }]),
      undefined,
    );
    expect(badges.appr).toEqual({ count: 1, tone: "neutral" });
  });
});
