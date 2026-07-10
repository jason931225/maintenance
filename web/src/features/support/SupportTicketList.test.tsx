import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SupportTicketSummary } from "../../api/types";
import { ko } from "../../i18n/ko";
import { defaultSloSettings } from "./slo-settings";
import { SupportTicketList } from "./SupportTicketList";
import { KO_CONSOLE_SUPPORTSLO } from "./supportslo-ko.test";

const SLO_RULES = defaultSloSettings().active;

const NOW = Date.parse("2026-06-13T12:00:00Z");

function ticket(
  over: Partial<SupportTicketSummary> = {},
): SupportTicketSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    branch_id: "00000000-0000-4000-8000-000000000001",
    origin: "CUSTOMER",
    category: "EQUIPMENT_INQUIRY",
    priority: "HIGH",
    status: "OPEN",
    title: "290호기 시동 불량",
    requester_user_id: "00000000-0000-4000-8000-0000000000aa",
    requester_name: "태성이엔지",
    assignee_user_id: "00000000-0000-4000-8000-0000000000bb",
    assignee_name: "김담당",
    due_at: "2026-06-13T11:00:00Z", // already overdue at NOW
    created_at: "2026-06-13T09:00:00Z",
    updated_at: "2026-06-13T09:00:00Z",
    resolved_at: null,
    closed_at: null,
    ...over,
  };
}

describe("SupportTicketList", () => {
  it("renders tickets with priority/status/SLO-overdue chips", () => {
    render(
      <SupportTicketList
        tickets={[ticket()]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("290호기 시동 불량")).toBeVisible();
    expect(screen.getByText(ko.support.ticketPriority.HIGH)).toBeVisible();
    expect(screen.getByText(ko.support.ticketStatus.OPEN)).toBeVisible();
    expect(
      screen.getByText(KO_CONSOLE_SUPPORTSLO.posture.overdue),
    ).toBeVisible();
  });

  it("derives the SLO chip from the ACTIVE setting when no due date is set", () => {
    // EQUIPMENT_INQUIRY threshold 24h; created 09:00 + 24h is > 4h away → no chip.
    render(
      <SupportTicketList
        tickets={[ticket({ due_at: null })]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.queryByText(KO_CONSOLE_SUPPORTSLO.posture.overdue),
    ).toBeNull();

    // Tightening the active rule to 1h flips the same ticket to SLO-overdue.
    render(
      <SupportTicketList
        tickets={[ticket({ due_at: null })]}
        nowMs={NOW}
        sloRules={{
          ...SLO_RULES,
          EQUIPMENT_INQUIRY: {
            ...SLO_RULES.EQUIPMENT_INQUIRY,
            thresholdHours: 1,
          },
        }}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByText(KO_CONSOLE_SUPPORTSLO.posture.overdue),
    ).toBeVisible();
  });

  it("renders the assignee by display name and the real total", () => {
    render(
      <SupportTicketList
        tickets={[ticket()]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
        total={42}
      />,
    );

    // The assignee renders by name (never the raw UUID), and the badge shows the
    // honest server total rather than just the loaded count.
    expect(screen.getByText(/김담당/)).toBeVisible();
    expect(
      screen.queryByText("00000000-0000-4000-8000-0000000000bb"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/42/)).toBeVisible();
  });

  it("falls back to 미배정 when a ticket has no assignee", () => {
    render(
      <SupportTicketList
        tickets={[ticket({ assignee_user_id: null, assignee_name: null })]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/미배정/)).toBeVisible();
  });

  it("shows the empty state when there are no tickets", () => {
    render(
      <SupportTicketList
        tickets={[]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(ko.support.empty)).toBeVisible();
  });

  it("calls onSelect with the ticket id when a row is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SupportTicketList
        tickets={[ticket()]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByText("290호기 시동 불량"));
    expect(onSelect).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("carries a SUP- object-code chip that is a drag source", () => {
    render(
      <SupportTicketList
        tickets={[ticket()]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
      />,
    );

    // ticketCode derives SUP-1111 from the API id (§4-25-⑥, §4-20 grammar).
    const chip = screen.getByText("SUP-1111");
    expect(chip).toBeVisible();
    expect(chip).toHaveAttribute("draggable", "true");
    expect(chip).toHaveAttribute("data-obj-code", "SUP-1111");
  });

  it("does not flag a resolved ticket as SLO-overdue", () => {
    render(
      <SupportTicketList
        tickets={[ticket({ status: "RESOLVED" })]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.queryByText(KO_CONSOLE_SUPPORTSLO.posture.overdue),
    ).toBeNull();
  });

  it("shows '더 보기' only when hasMore and calls onLoadMore", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <SupportTicketList
        tickets={[ticket()]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
        onLoadMore={onLoadMore}
      />,
    );
    // hasMore defaults false → no button.
    expect(
      screen.queryByRole("button", { name: ko.support.loadMore }),
    ).toBeNull();

    rerender(
      <SupportTicketList
        tickets={[ticket()]}
        nowMs={NOW}
        sloRules={SLO_RULES}
        onSelect={vi.fn()}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    await user.click(screen.getByRole("button", { name: ko.support.loadMore }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
