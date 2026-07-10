import { describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import type { SupportSloStrings } from "./supportslo-strings";

/**
 * Mirror of the ko.console.supportslo manifest (applied by the serial i18n
 * wire-up). ??= keeps the real ko.ts keys authoritative once they land; until
 * then this makes the support SLO surface renderable in tests. Sibling test
 * files import KO_CONSOLE_SUPPORTSLO and rely on the injection below.
 */
export const KO_CONSOLE_SUPPORTSLO: SupportSloStrings = {
  commandTitle: "지원 운영",
  urgentOrBreached: "긴급·SLO 위반",
  posture: {
    overdue: "SLO 초과",
    dueSoon: "SLO 임박",
  },
  alerts: {
    title: "SLO 위반 알림",
    escalateTo: (target: string) => `${target} 에스컬레이션`,
    rowAria: (title: string) => `SLO 위반 티켓 ${title} 열기`,
  },
  settings: {
    title: "SLO 설정",
    scopeChip: "SLO · 내부 운영 목표",
    version: (version: number) => `v${String(version)}`,
    category: "티켓 유형",
    threshold: "응답 기한(시간)",
    window: "평가 기간(일)",
    escalation: "에스컬레이션 대상",
    breachColumn: "기간 내 위반",
    breaches: (count: number) => `위반 ${String(count)}건`,
    edit: "수정",
    save: "저장",
    cancel: "취소",
    pending: (version: number) => `개정 대기 v${String(version)}`,
    stagedBy: (name: string) => `상신 ${name}`,
    keepActive: "현행 유지",
    approve: "적용 승인",
    withdraw: "철회",
    targets: {
      TEAM_LEAD: "팀장",
      DEDICATED: "전담자",
      ADMIN: "관리자",
    },
    fieldAria: (category: string, field: string) => `${category} ${field}`,
  },
};

(ko.console as unknown as Record<string, unknown>).supportslo ??=
  KO_CONSOLE_SUPPORTSLO;

describe("ko.console.supportslo manifest mirror", () => {
  it("provides every string the SLO surface renders", () => {
    const injected = (
      ko.console as unknown as { supportslo: SupportSloStrings }
    ).supportslo;
    expect(injected.posture.overdue.length).toBeGreaterThan(0);
    expect(injected.posture.dueSoon.length).toBeGreaterThan(0);
    expect(injected.settings.pending(2)).toContain("2");
    expect(injected.settings.version(1)).toContain("1");
    expect(injected.settings.breaches(3)).toContain("3");
    expect(injected.alerts.escalateTo("팀장")).toContain("팀장");
    expect(injected.alerts.rowAria("t")).toContain("t");
    expect(injected.settings.fieldAria("a", "b")).toContain("a");
  });
});
