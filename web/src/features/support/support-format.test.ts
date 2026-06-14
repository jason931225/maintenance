import { describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import {
  allowedTransitions,
  categoryLabel,
  originLabel,
  priorityLabel,
  slaState,
  statusLabel,
  transitionActionLabel,
} from "./support-format";

describe("support-format", () => {
  it("mirrors the backend FSM transition edges", () => {
    expect(allowedTransitions("OPEN")).toEqual(["IN_PROGRESS"]);
    expect(allowedTransitions("IN_PROGRESS")).toEqual(["ON_HOLD", "RESOLVED"]);
    expect(allowedTransitions("ON_HOLD")).toEqual(["IN_PROGRESS"]);
    expect(allowedTransitions("RESOLVED")).toEqual(["CLOSED", "IN_PROGRESS"]);
    expect(allowedTransitions("CLOSED")).toEqual([]);
  });

  it("labels a re-open edge as 재개 but a fresh start as 처리 시작", () => {
    expect(transitionActionLabel("OPEN", "IN_PROGRESS")).toBe(
      ko.support.transition.to_IN_PROGRESS,
    );
    expect(transitionActionLabel("RESOLVED", "IN_PROGRESS")).toBe(
      ko.support.transition.reopen,
    );
    expect(transitionActionLabel("ON_HOLD", "IN_PROGRESS")).toBe(
      ko.support.transition.reopen,
    );
    expect(transitionActionLabel("IN_PROGRESS", "RESOLVED")).toBe(
      ko.support.transition.to_RESOLVED,
    );
  });

  it("classifies SLA posture and never flags terminal tickets as overdue", () => {
    const now = Date.parse("2026-06-13T12:00:00Z");
    const past = "2026-06-13T11:00:00Z";
    const soon = "2026-06-13T14:00:00Z"; // within 4h
    const later = "2026-06-14T12:00:00Z"; // > 4h

    expect(slaState(past, "IN_PROGRESS", now)).toBe("overdue");
    expect(slaState(soon, "IN_PROGRESS", now)).toBe("dueSoon");
    expect(slaState(later, "IN_PROGRESS", now)).toBe("ok");
    expect(slaState(null, "OPEN", now)).toBe("none");
    expect(slaState("not-a-date", "OPEN", now)).toBe("none");

    // A resolved/closed ticket with a past due date is settled, not overdue.
    expect(slaState(past, "RESOLVED", now)).toBe("ok");
    expect(slaState(past, "CLOSED", now)).toBe("ok");
  });

  it("resolves Korean labels for every enum value", () => {
    expect(statusLabel("ON_HOLD")).toBe(ko.support.ticketStatus.ON_HOLD);
    expect(priorityLabel("URGENT")).toBe(ko.support.ticketPriority.URGENT);
    expect(categoryLabel("SYSTEM_BUG")).toBe(
      ko.support.ticketCategory.SYSTEM_BUG,
    );
    expect(originLabel("CUSTOMER")).toBe(ko.support.ticketOrigin.CUSTOMER);
  });
});
