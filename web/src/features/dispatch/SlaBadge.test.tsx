import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SlaBadge } from "./SlaBadge";
import { slaStatus } from "./sla";

const NOW = new Date("2026-06-12T12:00:00Z");

describe("slaStatus", () => {
  it("classifies a comfortably future target as on-track", () => {
    expect(
      slaStatus(
        { status: "IN_PROGRESS", target_due_at: "2026-06-12T18:00:00Z" },
        NOW,
      ),
    ).toBe("on-track");
  });

  it("classifies a target inside the at-risk window as at-risk", () => {
    expect(
      slaStatus(
        { status: "ASSIGNED", target_due_at: "2026-06-12T12:20:00Z" },
        NOW,
      ),
    ).toBe("at-risk");
  });

  it("classifies a past target as breached", () => {
    expect(
      slaStatus(
        { status: "IN_PROGRESS", target_due_at: "2026-06-12T11:00:00Z" },
        NOW,
      ),
    ).toBe("breached");
  });

  it("returns none when there is no target due", () => {
    expect(
      slaStatus({ status: "IN_PROGRESS", target_due_at: null }, NOW),
    ).toBe("none");
  });

  it("returns none for a terminal status even when the target is past", () => {
    expect(
      slaStatus(
        { status: "FINAL_COMPLETED", target_due_at: "2026-06-12T11:00:00Z" },
        NOW,
      ),
    ).toBe("none");
  });
});

describe("SlaBadge", () => {
  it("renders 정상 for an on-track work order", () => {
    render(
      <SlaBadge
        workOrder={{ status: "IN_PROGRESS", target_due_at: "2026-06-12T18:00:00Z" }}
        now={NOW}
      />,
    );
    const badge = screen.getByText("정상");
    expect(badge).toBeVisible();
    expect(badge).toHaveClass("border-tone-success-border", "bg-tone-success-bg", "text-tone-success-text");
  });

  it("renders 임박 for an at-risk work order", () => {
    render(
      <SlaBadge
        workOrder={{ status: "ASSIGNED", target_due_at: "2026-06-12T12:20:00Z" }}
        now={NOW}
      />,
    );
    const badge = screen.getByText("임박");
    expect(badge).toBeVisible();
    expect(badge).toHaveClass("border-tone-warning-border", "bg-tone-warning-bg", "text-tone-warning-text");
  });

  it("renders 위반 for a breached work order", () => {
    render(
      <SlaBadge
        workOrder={{ status: "IN_PROGRESS", target_due_at: "2026-06-12T11:00:00Z" }}
        now={NOW}
      />,
    );
    const badge = screen.getByText("위반");
    expect(badge).toBeVisible();
    expect(badge).toHaveClass("border-tone-danger-border", "bg-tone-danger-bg", "text-tone-danger-text");
  });

  it("renders nothing when no SLA applies", () => {
    const { container } = render(
      <SlaBadge
        workOrder={{ status: "IN_PROGRESS", target_due_at: null }}
        now={NOW}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
