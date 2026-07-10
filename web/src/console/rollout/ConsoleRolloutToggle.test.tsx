import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { ConsoleRolloutToggle } from "./ConsoleRolloutToggle";

const allowGate: PolicyGate = { can: () => true };
const denyGate: PolicyGate = { can: () => false };

function renderRollout(gate: PolicyGate, onToggle = vi.fn()) {
  render(
    <PolicyGateProvider gate={gate}>
      <ConsoleRolloutToggle
        defaultEnabled={false}
        status={{ orgEnabled: true, rolloutPercent: 10, telemetryHealthy: true }}
        onToggle={onToggle}
      />
    </PolicyGateProvider>,
  );
  return onToggle;
}

describe("ConsoleRolloutToggle", () => {
  it("renders the opt-in switch and flips console state immediately", () => {
    const onToggle = renderRollout(allowGate);
    const toggle = screen.getByRole("switch", { name: "새 콘솔 사용" });

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("기존 화면")).toBeVisible();
    expect(screen.getByText("배포 10%")).toBeVisible();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("콘솔")).toBeVisible();
    expect(onToggle).toHaveBeenCalledWith(true);

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("기존 화면")).toBeVisible();
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it("omits the toggle affordance when policy denies it but keeps rollout chips", () => {
    renderRollout(denyGate);

    expect(screen.queryByRole("switch", { name: "새 콘솔 사용" })).not.toBeInTheDocument();
    expect(screen.getByText("기존 화면")).toBeVisible();
    expect(screen.getByText("조직 허용")).toBeVisible();
  });

  it("shows a forced legacy rollout chip when the org kill switch is active", () => {
    render(
      <PolicyGateProvider gate={allowGate}>
        <ConsoleRolloutToggle
          defaultEnabled
          status={{ orgEnabled: true, killSwitchActive: true, telemetryHealthy: false }}
        />
      </PolicyGateProvider>,
    );

    expect(screen.getByRole("switch", { name: "새 콘솔 사용" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByText("기존 화면")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("긴급 차단");
    expect(screen.getByText("관측 점검")).toBeVisible();
  });
});
