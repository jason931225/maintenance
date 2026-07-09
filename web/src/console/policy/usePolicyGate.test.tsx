import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PolicyGated, PolicyGateProvider } from "./PolicyGated";

/**
 * The policy gate is fail-closed: with no provider it denies everything, so a
 * forgotten provider hides affordances rather than leaking them. A demo/harness
 * that wants affordances visible mounts an explicit allow-all provider.
 */
describe("PolicyGated — fail-closed default", () => {
  it("denies (renders nothing) when NO provider wraps the tree", () => {
    render(
      <PolicyGated action="work_order.reject">
        <button type="button">gated</button>
      </PolicyGated>,
    );
    expect(screen.queryByText("gated")).not.toBeInTheDocument();
  });

  it("renders when an explicit allow-all provider wraps the tree", () => {
    render(
      <PolicyGateProvider decide={() => true}>
        <PolicyGated action="work_order.reject">
          <button type="button">gated</button>
        </PolicyGated>
      </PolicyGateProvider>,
    );
    expect(screen.getByText("gated")).toBeInTheDocument();
  });
});
