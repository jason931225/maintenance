import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SupportTicketDetail as SupportTicketDetailModel } from "../../api/types";
import { ko } from "../../i18n/ko";
import { SupportTicketDetail } from "./SupportTicketDetail";

const ME = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";

function detail(
  over: Partial<SupportTicketDetailModel["ticket"]> = {},
  comments: SupportTicketDetailModel["comments"] = [],
): SupportTicketDetailModel {
  return {
    ticket: {
      id: "33333333-3333-4333-8333-333333333333",
      branch_id: "00000000-0000-4000-8000-000000000001",
      origin: "CUSTOMER",
      category: "COMPLAINT",
      priority: "URGENT",
      status: "IN_PROGRESS",
      title: "지게차 누유 재발",
      requester_user_id: OTHER,
      requester_name: "태성이엔지",
      assignee_user_id: OTHER,
      due_at: "2026-06-13T18:00:00Z",
      created_at: "2026-06-13T09:00:00Z",
      updated_at: "2026-06-13T09:00:00Z",
      resolved_at: null,
      closed_at: null,
      ...over,
    },
    comments,
  };
}

describe("SupportTicketDetail", () => {
  it("offers only FSM-valid transitions for the current status", () => {
    render(
      <SupportTicketDetail
        detail={detail()}
        currentUserId={ME}
        onTransition={vi.fn().mockResolvedValue(undefined)}
        onAddComment={vi.fn().mockResolvedValue(undefined)}
        onAssignSelf={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // IN_PROGRESS → ON_HOLD | RESOLVED only.
    expect(
      screen.getByRole("button", { name: ko.support.transition.to_ON_HOLD }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: ko.support.transition.to_RESOLVED }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: ko.support.transition.to_CLOSED }),
    ).toBeNull();
  });

  it("renders comments and marks internal notes", () => {
    render(
      <SupportTicketDetail
        detail={detail({}, [
          {
            id: "c1",
            ticket_id: "33333333-3333-4333-8333-333333333333",
            author_user_id: ME,
            body: "고객에게 공개되는 코멘트",
            is_internal_note: false,
            created_at: "2026-06-13T10:00:00Z",
          },
          {
            id: "c2",
            ticket_id: "33333333-3333-4333-8333-333333333333",
            author_user_id: ME,
            body: "내부 전용 메모",
            is_internal_note: true,
            created_at: "2026-06-13T10:05:00Z",
          },
        ])}
        currentUserId={ME}
        onTransition={vi.fn()}
        onAddComment={vi.fn().mockResolvedValue(undefined)}
        onAssignSelf={vi.fn()}
      />,
    );

    expect(screen.getByText("고객에게 공개되는 코멘트")).toBeVisible();
    expect(screen.getByText("내부 전용 메모")).toBeVisible();
    expect(screen.getByText(ko.support.comments.internalNote)).toBeVisible();
  });

  it("submits a transition through the callback", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn().mockResolvedValue(undefined);
    render(
      <SupportTicketDetail
        detail={detail()}
        currentUserId={ME}
        onTransition={onTransition}
        onAddComment={vi.fn().mockResolvedValue(undefined)}
        onAssignSelf={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: ko.support.transition.to_RESOLVED }),
    );
    expect(onTransition).toHaveBeenCalledWith("RESOLVED");
  });

  it("adds an internal note via the comment form", async () => {
    const user = userEvent.setup();
    const onAddComment = vi.fn().mockResolvedValue(undefined);
    render(
      <SupportTicketDetail
        detail={detail()}
        currentUserId={ME}
        onTransition={vi.fn()}
        onAddComment={onAddComment}
        onAssignSelf={vi.fn()}
      />,
    );

    await user.type(
      screen.getByLabelText(ko.support.comments.title),
      "부품 발주 완료",
    );
    await user.click(screen.getByLabelText(ko.support.comments.markInternal));
    await user.click(
      screen.getByRole("button", { name: ko.support.comments.add }),
    );

    expect(onAddComment).toHaveBeenCalledWith("부품 발주 완료", true);
  });

  it("offers self-assign when the ticket is not already mine", async () => {
    const user = userEvent.setup();
    const onAssignSelf = vi.fn().mockResolvedValue(undefined);
    render(
      <SupportTicketDetail
        detail={detail({ assignee_user_id: OTHER })}
        currentUserId={ME}
        onTransition={vi.fn()}
        onAddComment={vi.fn()}
        onAssignSelf={onAssignSelf}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: ko.support.assignSelf }),
    );
    expect(onAssignSelf).toHaveBeenCalledTimes(1);
  });

  it("hides self-assign when the ticket is already mine", () => {
    render(
      <SupportTicketDetail
        detail={detail({ assignee_user_id: ME })}
        currentUserId={ME}
        onTransition={vi.fn()}
        onAddComment={vi.fn()}
        onAssignSelf={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: ko.support.assignSelf }),
    ).toBeNull();
  });
});
