import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ko } from "../../i18n/ko";
import { CustomerIntakeForm } from "./CustomerIntakeForm";

describe("CustomerIntakeForm", () => {
  it("requires title, body, name and contact before submitting", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue("ok" as const);
    render(<CustomerIntakeForm onSubmit={onSubmit} />);

    await user.click(
      screen.getByRole("button", { name: ko.support.form.submit }),
    );

    expect(
      await screen.findByText(ko.support.form.requiredTitle),
    ).toBeVisible();
    expect(screen.getByText(ko.support.form.requiredBody)).toBeVisible();
    expect(
      screen.getByText(ko.support.form.requiredRequesterName),
    ).toBeVisible();
    expect(
      screen.getByText(ko.support.form.requiredRequesterContact),
    ).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the typed intake request", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue("ok" as const);
    render(<CustomerIntakeForm onSubmit={onSubmit} />);

    await user.type(
      screen.getByLabelText(ko.support.form.ticketTitle),
      "290호기 점검 요청",
    );
    await user.type(
      screen.getByLabelText(ko.support.form.body),
      "시동이 걸리지 않습니다.",
    );
    await user.type(screen.getByLabelText(ko.support.form.requesterName), "홍길동");
    await user.type(
      screen.getByLabelText(ko.support.form.requesterContact),
      "010-1234-5678",
    );
    await user.click(
      screen.getByRole("button", { name: ko.support.form.submit }),
    );

    expect(onSubmit).toHaveBeenCalledWith({
      category: "EQUIPMENT_INQUIRY",
      priority: "MEDIUM",
      title: "290호기 점검 요청",
      body: "시동이 걸리지 않습니다.",
      requester_name: "홍길동",
      requester_contact: "010-1234-5678",
    });
  });

  it("surfaces the rate-limit message when the channel is throttled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue("rateLimited" as const);
    render(<CustomerIntakeForm onSubmit={onSubmit} />);

    await user.type(
      screen.getByLabelText(ko.support.form.ticketTitle),
      "문의",
    );
    await user.type(screen.getByLabelText(ko.support.form.body), "내용");
    await user.type(screen.getByLabelText(ko.support.form.requesterName), "홍길동");
    await user.type(
      screen.getByLabelText(ko.support.form.requesterContact),
      "010-0000-0000",
    );
    await user.click(
      screen.getByRole("button", { name: ko.support.form.submit }),
    );

    expect(await screen.findByText(ko.support.form.rateLimited)).toBeVisible();
  });
});
