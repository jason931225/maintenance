import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FeedbackBanner } from "./FeedbackBanner";
import { SkeletonCards, SkeletonTable } from "./Skeleton";

describe("FeedbackBanner", () => {
  it("renders a polite status region for success and is dismissible", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <FeedbackBanner kind="success" message="저장했습니다." onDismiss={onDismiss} />,
    );
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("저장했습니다.");
    await user.click(screen.getByRole("button", { name: "알림 닫기" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders an assertive alert region for errors", () => {
    render(<FeedbackBanner kind="error" message="실패했습니다." />);
    expect(screen.getByRole("alert")).toHaveTextContent("실패했습니다.");
  });

  it("renders nothing when the message is empty", () => {
    const { container } = render(
      <FeedbackBanner kind="success" message={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Skeleton primitives", () => {
  it("exposes a busy status region for the table skeleton", () => {
    render(<SkeletonTable rows={3} cols={4} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
  });

  it("exposes a busy status region for the cards skeleton", () => {
    render(<SkeletonCards count={2} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
  });
});
