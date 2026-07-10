import { describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import type { SupportDeskStrings } from "./support-desk-strings";

/**
 * Mirror of the ko.console.supportdesk manifest (applied by the serial i18n
 * wire-up). ??= keeps the real ko.ts keys authoritative once they land; until
 * then this makes the support desk surface renderable in tests. Sibling test
 * files import KO_CONSOLE_SUPPORTDESK and rely on the injection below.
 */
export const KO_CONSOLE_SUPPORTDESK: SupportDeskStrings = {
  statsAria: "지원 티켓 현황",
  drill: (label: string) => `${label} 필터`,
  sloRemaining: (time: string) => `SLO 잔여 ${time}`,
  sloOverdueBy: (time: string) => `SLO 초과 ${time}`,
  duration: (hours: number, minutes: number) =>
    `${String(hours)}시간 ${String(minutes)}분`,
  escalationNote: (target: string) => `${target} 에스컬레이션 — SLO 확인 요청`,
  escalateFailed: "에스컬레이션을 등록하지 못했습니다.",
};

(ko.console as unknown as Record<string, unknown>).supportdesk ??=
  KO_CONSOLE_SUPPORTDESK;

describe("ko.console.supportdesk manifest mirror", () => {
  it("provides every string the support desk surface renders", () => {
    const injected = (
      ko.console as unknown as { supportdesk: SupportDeskStrings }
    ).supportdesk;
    expect(injected.statsAria.length).toBeGreaterThan(0);
    expect(injected.drill("a")).toContain("a");
    expect(injected.duration(2, 5)).toContain("2");
    expect(injected.duration(2, 5)).toContain("5");
    expect(injected.sloRemaining("t")).toContain("t");
    expect(injected.sloOverdueBy("t")).toContain("t");
    expect(injected.escalationNote("팀장")).toContain("팀장");
    expect(injected.escalateFailed.length).toBeGreaterThan(0);
  });
});
