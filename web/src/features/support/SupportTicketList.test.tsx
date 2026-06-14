import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SupportTicketSummary } from "../../api/types";
import { ko } from "../../i18n/ko";
import { SupportTicketList } from "./SupportTicketList";

const NOW = Date.parse("2026-06-13T12:00:00Z");

function ticket(over: Partial<SupportTicketSummary> = {}): SupportTicketSummary {
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
    due_at: "2026-06-13T11:00:00Z", // already overdue at NOW
    created_at: "2026-06-13T09:00:00Z",
    updated_at: "2026-06-13T09:00:00Z",
    resolved_at: null,
    closed_at: null,
    ...over,
  };
}

describe("SupportTicketList", () => {
  it("renders tickets with priority/status/overdue badges", () => {
    render(
      <SupportTicketList tickets={[ticket()]} nowMs={NOW} onSelect={vi.fn()} />,
    );

    expect(screen.getByText("290호기 시동 불량")).toBeVisible();
    expect(screen.getByText(ko.support.ticketPriority.HIGH)).toBeVisible();
    expect(screen.getByText(ko.support.ticketStatus.OPEN)).toBeVisible();
    expect(screen.getByText(ko.support.overdue)).toBeVisible();
  });

  it("shows the empty state when there are no tickets", () => {
    render(<SupportTicketList tickets={[]} nowMs={NOW} onSelect={vi.fn()} />);
    expect(screen.getByText(ko.support.empty)).toBeVisible();
  });

  it("calls onSelect with the ticket id when a row is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SupportTicketList tickets={[ticket()]} nowMs={NOW} onSelect={onSelect} />,
    );

    await user.click(screen.getByText("290호기 시동 불량"));
    expect(onSelect).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("does not flag a resolved ticket as overdue", () => {
    render(
      <SupportTicketList
        tickets={[ticket({ status: "RESOLVED" })]}
        nowMs={NOW}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText(ko.support.overdue)).toBeNull();
  });
});
