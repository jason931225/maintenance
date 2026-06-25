import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FeedbackBanner } from "./FeedbackBanner";
import { PageError } from "./PageError";
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

describe("PageError 403-awareness", () => {
  it("shows a permission message and hides retry on a 403", () => {
    const onRetry = vi.fn();
    render(<PageError status={403} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "이 페이지에 접근할 권한이 없습니다.",
    );
    expect(screen.getByText("필요한 경우 관리자에게 문의하세요.")).toBeVisible();
    // Retry is futile on a permission denial, so it must NOT be offered.
    expect(
      screen.queryByRole("button", { name: "다시 시도" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the retry button on a transient (500) failure", () => {
    const onRetry = vi.fn();
    render(<PageError status={500} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "데이터를 불러오지 못했습니다.",
    );
    expect(
      screen.getByRole("button", { name: "다시 시도" }),
    ).toBeVisible();
  });

  it("keeps the retry button when the status is unknown (network error)", () => {
    const onRetry = vi.fn();
    render(<PageError onRetry={onRetry} />);
    expect(
      screen.getByRole("button", { name: "다시 시도" }),
    ).toBeVisible();
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
