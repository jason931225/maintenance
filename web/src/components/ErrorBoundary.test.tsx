import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("child crashed");
}

describe("ErrorBoundary", () => {
  // The boundary logs the caught error via componentDidCatch; silence it.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => {
    consoleError.mockClear();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>healthy</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy")).toBeVisible();
  });

  it("falls back to the reload card when no fallback is supplied", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it("degrades a crashed region to its fallback while siblings survive", () => {
    // Models the console shell: a rail crash must show the quiet rail fallback
    // and leave the content plane mounted, never bubble to the route boundary.
    render(
      <>
        <main>content plane</main>
        <ErrorBoundary fallback={<aside>rail unavailable</aside>}>
          <Boom />
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByText("rail unavailable")).toBeVisible();
    expect(screen.getByText("content plane")).toBeVisible();
    // The default crash card must NOT appear when a fallback is given.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
