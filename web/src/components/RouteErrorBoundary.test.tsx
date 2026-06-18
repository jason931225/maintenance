import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteErrorBoundary } from "./RouteErrorBoundary";

function Boom(): never {
  throw new Error("page crashed");
}

describe("RouteErrorBoundary", () => {
  // The boundary logs the caught error via componentDidCatch; silence it.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => {
    consoleError.mockClear();
  });

  it("contains a child crash and shows the friendly fallback", () => {
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByText("이 화면을 표시하지 못했습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeVisible();
  });

  it("renders children when nothing throws", () => {
    render(
      <RouteErrorBoundary>
        <p>healthy page</p>
      </RouteErrorBoundary>,
    );
    expect(screen.getByText("healthy page")).toBeVisible();
  });

  it("retry clears the error so a recovered child re-renders", async () => {
    const user = userEvent.setup();

    // The "fix" button lives outside the boundary (it must survive the crash);
    // clicking it fixes the underlying condition before we retry.
    function Harness() {
      const [crash, setCrash] = useState(true);
      return (
        <>
          <button type="button" onClick={() => { setCrash(false); }}>
            fix
          </button>
          <RouteErrorBoundary>
            {crash ? <Boom /> : <p>recovered</p>}
          </RouteErrorBoundary>
        </>
      );
    }

    render(<Harness />);

    expect(screen.getByText("이 화면을 표시하지 못했습니다.")).toBeVisible();

    // Fix the underlying condition, then retry: the boundary clears its error.
    await user.click(screen.getByRole("button", { name: "fix" }));
    await user.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(screen.getByText("recovered")).toBeVisible();
    expect(
      screen.queryByText("이 화면을 표시하지 못했습니다."),
    ).not.toBeInTheDocument();
  });

  it("resets on resetKey change (navigation) so a new route renders", () => {
    const { rerender } = render(
      <RouteErrorBoundary resetKey="/dispatch">
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText("이 화면을 표시하지 못했습니다.")).toBeVisible();

    // Navigating to a different path swaps the child for a healthy one.
    rerender(
      <RouteErrorBoundary resetKey="/approvals">
        <p>next page</p>
      </RouteErrorBoundary>,
    );
    expect(screen.getByText("next page")).toBeVisible();
    expect(
      screen.queryByText("이 화면을 표시하지 못했습니다."),
    ).not.toBeInTheDocument();
  });
});
