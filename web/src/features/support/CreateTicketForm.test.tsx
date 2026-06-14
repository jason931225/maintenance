import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SupportTicketSummary } from "../../api/types";
import { ko } from "../../i18n/ko";
import { CreateTicketForm } from "./CreateTicketForm";

const branchId = "00000000-0000-4000-8000-000000000001";

const created: SupportTicketSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  branch_id: branchId,
  origin: "INTERNAL",
  category: "SYSTEM_BUG",
  priority: "URGENT",
  status: "OPEN",
  title: "로그인 오류",
  requester_user_id: "00000000-0000-4000-8000-0000000000aa",
  requester_name: null,
  assignee_user_id: "00000000-0000-4000-8000-0000000000aa",
  due_at: null,
  created_at: "2026-06-13T09:00:00Z",
  updated_at: "2026-06-13T09:00:00Z",
  resolved_at: null,
  closed_at: null,
};

describe("CreateTicketForm", () => {
  it("validates required fields then submits the typed create request", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(created);
    const onCreated = vi.fn();

    render(
      <CreateTicketForm
        branchId={branchId}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: ko.support.form.submit }),
    );
    expect(
      await screen.findByText(ko.support.form.requiredTitle),
    ).toBeVisible();
    expect(screen.getByText(ko.support.form.requiredBody)).toBeVisible();
    expect(onCreate).not.toHaveBeenCalled();

    await user.selectOptions(
      screen.getByLabelText(ko.support.form.category),
      "SYSTEM_BUG",
    );
    await user.selectOptions(
      screen.getByLabelText(ko.support.form.priority),
      "URGENT",
    );
    await user.type(screen.getByLabelText(ko.support.form.ticketTitle), "로그인 오류");
    await user.type(
      screen.getByLabelText(ko.support.form.body),
      "관리자 계정 로그인이 안 됩니다.",
    );
    await user.click(
      screen.getByRole("button", { name: ko.support.form.submit }),
    );

    expect(onCreate).toHaveBeenCalledWith({
      branch_id: branchId,
      category: "SYSTEM_BUG",
      priority: "URGENT",
      title: "로그인 오류",
      body: "관리자 계정 로그인이 안 됩니다.",
    });
    expect(await screen.findByText(ko.support.form.created)).toBeVisible();
    expect(onCreated).toHaveBeenCalledWith(created);
  });
});
