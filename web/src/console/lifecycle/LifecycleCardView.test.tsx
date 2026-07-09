import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { disposeBlockedFixture, historyFixture, stepperFixture } from "./demoFixtures";
import { DOCUMENT_CHAIN } from "./chain";
import { LifecycleCardView } from "./LifecycleCardView";
import { PolicyGated, PolicyProvider } from "../policy";

function view(props: Partial<React.ComponentProps<typeof LifecycleCardView>> = {}) {
  return (
    <LifecycleCardView chain={DOCUMENT_CHAIN} record={stepperFixture} today="2026-06-06" {...props} />
  );
}

function allowedView(props: Partial<React.ComponentProps<typeof LifecycleCardView>> = {}) {
  return <PolicyProvider decide={() => true}>{view(props)}</PolicyProvider>;
}

describe("LifecycleCardView", () => {
  it("maps the real state onto the stepper (approved => review stage current)", () => {
    render(view());
    const stepper = screen.getByRole("list", { name: /단계/ });
    const current = stepper.querySelector('[data-step="review"]');
    expect(current).toHaveAttribute("data-step-status", "current");
    expect(stepper.querySelector('[data-step="draft"]')).toHaveAttribute("data-step-status", "done");
  });

  it("fires the transition callback with the target state and the typed reason", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn();
    render(allowedView({ onTransition }));
    await user.type(screen.getByPlaceholderText(/사유/), "효력 발생 처리");
    // approved's only forward edge is `active`.
    await user.click(screen.getByRole("button", { name: "활성" }));
    expect(onTransition).toHaveBeenCalledWith("active", "효력 발생 처리");
  });

  it("keeps the transition disabled until a reason is entered", () => {
    render(allowedView());
    expect(screen.getByRole("button", { name: "활성" })).toBeDisabled();
  });

  it("renders the dispose gate from the payload and blocks the dispose CTA", () => {
    const { container } = render(allowedView({ record: disposeBlockedFixture }));
    const disposeBtn = container.querySelector('[data-transition-to="disposed"]');
    expect(disposeBtn).toBeDisabled();
    const block = container.querySelector('[data-fidelity="lifecycle-dispose-block"]');
    expect(block).toHaveAttribute("data-block", "legalHold");
  });

  it("as-of mode disables every CTA and shows the as-of chip", () => {
    const onTransition = vi.fn();
    const { container } = render(
      allowedView({ record: historyFixture, mode: "asOf", asOfDate: "2026-06-04", onTransition }),
    );
    expect(container.querySelector('[data-fidelity="lifecycle-asof"]')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/사유/)).toBeDisabled();
    expect(container.querySelector('[data-hold-apply]')).toBeDisabled();
    // Every transition button is disabled in the read-only lens.
    container.querySelectorAll("[data-transition-to]").forEach((b) => {
      expect(b).toBeDisabled();
    });
  });


  it("defaults policy-gated affordances to deny when no provider is mounted", () => {
    const { container } = render(
      <PolicyGated action="lifecycle.transition">
        <button type="button">hidden by default</button>
      </PolicyGated>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("omits every gated affordance when policy denies (deny-by-omission)", () => {
    const { container } = render(
      <PolicyProvider decide={() => false}>{view()}</PolicyProvider>,
    );
    expect(container.querySelector('[data-fidelity="lifecycle-transitions"]')).toBeNull();
    expect(container.querySelector('[data-fidelity="lifecycle-hold"]')).toBeNull();
    // History is not an action affordance — it stays visible.
    expect(container.querySelector('[data-fidelity="lifecycle-history"]')).toBeInTheDocument();
  });


  it("does not fire transition or hold callbacks while busy", async () => {
    const user = userEvent.setup();
    const onTransition = vi.fn();
    const onSetHold = vi.fn();
    const { container } = render(allowedView({ busy: true, onTransition, onSetHold }));

    await user.type(screen.getByPlaceholderText(/사유/), "효력 발생 처리");
    await user.click(screen.getByRole("button", { name: "활성" }));
    await user.click(container.querySelector("[data-hold-apply]") as HTMLElement);

    expect(onTransition).not.toHaveBeenCalled();
    expect(onSetHold).not.toHaveBeenCalled();
  });

  it("renders the version history read-only from the real transition log", () => {
    const { container } = render(view({ record: historyFixture }));
    const rows = container.querySelectorAll("[data-history-row]");
    expect(rows).toHaveLength(historyFixture.transitions.length);
  });
});
