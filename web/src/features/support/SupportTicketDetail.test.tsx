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
      assignee_name: "박정비",
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
        canAssign
        canComment
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
            author_name: "이작성",
            body: "고객에게 공개되는 코멘트",
            is_internal_note: false,
            created_at: "2026-06-13T10:00:00Z",
          },
          {
            id: "c2",
            ticket_id: "33333333-3333-4333-8333-333333333333",
            author_user_id: ME,
            author_name: "이작성",
            body: "내부 전용 메모",
            is_internal_note: true,
            created_at: "2026-06-13T10:05:00Z",
          },
        ])}
        currentUserId={ME}
        canComment
        onTransition={vi.fn()}
        onAddComment={vi.fn().mockResolvedValue(undefined)}
        onAssignSelf={vi.fn()}
      />,
    );

    expect(screen.getByText("고객에게 공개되는 코멘트")).toBeVisible();
    expect(screen.getByText("내부 전용 메모")).toBeVisible();
    expect(screen.getByText(ko.support.comments.internalNote)).toBeVisible();
    // Each comment renders its author by display name (never a raw UUID).
    expect(screen.getAllByText("이작성").length).toBe(2);
    expect(screen.queryByText(ME)).not.toBeInTheDocument();
  });

  it("links the ticket to work, messaging, mail, and reporting object paths", () => {
    render(
      <SupportTicketDetail
        detail={detail()}
        currentUserId={ME}
        canAssign
        canComment
        onTransition={vi.fn()}
        onAddComment={vi.fn()}
        onAssignSelf={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("navigation", { name: ko.support.objectRail.title }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: ko.support.objectRail.workOrder }),
    ).toHaveAttribute(
      "href",
      `/dispatch?source=support&ticket=${detail().ticket.id}`,
    );
    expect(
      screen.getByRole("link", { name: ko.support.objectRail.messenger }),
    ).toHaveAttribute(
      "href",
      `/messenger?source=support&ticket=${detail().ticket.id}`,
    );
    expect(
      screen.getByRole("link", { name: ko.support.objectRail.mail }),
    ).toHaveAttribute(
      "href",
      `/mail?source=support&ticket=${detail().ticket.id}`,
    );
  });

  it("submits a transition through the callback", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn().mockResolvedValue(undefined);
    render(
      <SupportTicketDetail
        detail={detail()}
        currentUserId={ME}
        canAssign
        canComment
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
        canComment
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
        canAssign
        canComment
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

  it("hides triage controls (transitions + claim) when the principal cannot assign", () => {
    render(
      <SupportTicketDetail
        detail={detail({ assignee_user_id: OTHER })}
        currentUserId={ME}
        canAssign={false}
        canComment
        onTransition={vi.fn()}
        onAddComment={vi.fn()}
        onAssignSelf={vi.fn()}
      />,
    );
    // A non-triager (e.g. MECHANIC) sees neither the claim nor any status
    // transition control — the assignment endpoints would 403 for them.
    expect(
      screen.queryByRole("button", { name: ko.support.assignSelf }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: ko.support.transition.to_RESOLVED }),
    ).toBeNull();
  });

  it("hides the comment composer when the principal cannot comment", () => {
    render(
      <SupportTicketDetail
        detail={detail()}
        currentUserId={ME}
        canAssign={false}
        canComment={false}
        onTransition={vi.fn()}
        onAddComment={vi.fn()}
        onAssignSelf={vi.fn()}
      />,
    );
    // A receptionist (WorkOrderStart Limited) reads the thread but the composer
    // is hidden — the comment endpoint would 403 for them.
    expect(
      screen.queryByRole("button", { name: ko.support.comments.add }),
    ).toBeNull();
  });

  it("hides self-assign when the ticket is already mine", () => {
    render(
      <SupportTicketDetail
        detail={detail({ assignee_user_id: ME })}
        currentUserId={ME}
        canComment
        onTransition={vi.fn()}
        onAddComment={vi.fn()}
        onAssignSelf={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: ko.support.assignSelf }),
    ).toBeNull();
  });

  it("shows the busy label only on the in-flight transition button", async () => {
    const user = userEvent.setup();
    // A pending transition keeps pendingTo set so we can inspect the labels.
    let release: () => void = () => {};
    const onTransition = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <SupportTicketDetail
        detail={detail()} // IN_PROGRESS → offers 보류 (ON_HOLD) + 해결 (RESOLVED)
        currentUserId={ME}
        canAssign
        canComment
        onTransition={onTransition}
        onAddComment={vi.fn()}
        onAssignSelf={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: ko.support.transition.to_RESOLVED }),
    );
    // Only the clicked (RESOLVED) button flips to 변경 중; the other keeps its label.
    expect(
      await screen.findByRole("button", {
        name: ko.support.transition.changing,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: ko.support.transition.to_ON_HOLD }),
    ).toBeVisible();
    release();
  });
});
