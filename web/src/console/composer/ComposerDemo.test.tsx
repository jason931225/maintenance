import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  COMPOSER_DEMO_CANDIDATES,
  COMPOSER_DEMO_RESOLVED,
  COMPOSER_DEMO_TEXT,
} from "../../test/composer-demo-fixtures";
import { ComposerDemo, type ComposerDemoState } from "./ComposerDemo";

function renderDemo(state: ComposerDemoState) {
  return render(
    <ComposerDemo
      state={state}
      candidates={COMPOSER_DEMO_CANDIDATES}
      resolved={COMPOSER_DEMO_RESOLVED}
      text={COMPOSER_DEMO_TEXT}
    />,
  );
}

describe("ComposerDemo (fidelity states)", () => {
  it("renders the chip state with resolved chips and an inert unauthorized code", () => {
    const { container } = renderDemo("chips");
    expect(container.querySelector('[data-fidelity="composer-chips"]')).toBeInTheDocument();
    // Resolved object chips are buttons; the unauthorized !AP-9999 is not.
    expect(screen.getByRole("button", { name: /WO-20260612-001/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /AP-9999/ })).not.toBeInTheDocument();
    expect(container).toHaveTextContent("!AP-9999");
  });

  it("renders the dropdown-open state with all seeded candidates", () => {
    renderDemo("dropdown");
    expect(screen.getByRole("button", { name: /홍길동/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /케이앤엘/ })).toBeInTheDocument();
  });

  it("renders the clamped state as a fixed-position dropdown", () => {
    renderDemo("clamped");
    expect(screen.getByTestId("token-composer-dropdown")).toHaveStyle({ position: "fixed" });
  });
});
