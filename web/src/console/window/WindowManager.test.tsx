import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { WindowManagerProvider } from "./WindowManager";
import { PANEL_DEFAULT_WIDTH, QUADRANT_GAP } from "./windowModel";
import { usePinnedPanel, useWindowManager } from "./windowManagerContext";

const ENTRY = {
  id: "WO-2643",
  title: "작업지시 2643",
  render: () => <div data-testid="panel-body">본문</div>,
};

function Harness() {
  const { open } = usePinnedPanel();
  const manager = useWindowManager();
  return (
    <div data-testid="content">
      <button data-testid="open" type="button" onClick={() => { open(ENTRY); }}>
        열기
      </button>
      <button data-testid="reset" type="button" onClick={() => { manager.restoreDefault(); }}>
        초기화
      </button>
    </div>
  );
}

function renderHarness() {
  return render(
    <WindowManagerProvider>
      <Harness />
    </WindowManagerProvider>,
  );
}

function hostWrapper() {
  const host = screen.getByTestId("content").parentElement;
  if (!host) throw new Error("host wrapper missing");
  return host;
}

beforeEach(() => {
  localStorage.clear();
});

describe("WindowManagerProvider", () => {
  it("pins an object as a right split and gives host content real padding", () => {
    renderHarness();

    expect(hostWrapper().style.paddingRight).toBe("");
    expect(screen.queryByRole("region", { name: "작업지시 2643" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open"));

    const panel = screen.getByRole("region", { name: "작업지시 2643" });
    expect(panel).toBeVisible();
    expect(screen.getByTestId("panel-body")).toBeVisible();
    // Wide viewport (jsdom innerWidth 1024 → not narrow): the split is a REAL
    // padding-right of panel width + the 2px quadrant gap, not an overlay.
    expect(hostWrapper().style.paddingRight).toBe(`${String(PANEL_DEFAULT_WIDTH + QUADRANT_GAP)}px`);
  });

  it("round-trips minimize → tray chip → restore", () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("open"));

    fireEvent.click(screen.getByRole("button", { name: "최소화" }));

    // Panel gone, host padding released, a restorable tray chip present.
    expect(screen.queryByRole("region", { name: "작업지시 2643" })).not.toBeInTheDocument();
    expect(hostWrapper().style.paddingRight).toBe("");
    const tray = screen.getByRole("group", { name: "작업 트레이" });
    const chip = screen.getByRole("button", { name: "작업지시 2643 복원" });
    expect(tray).toContainElement(chip);

    fireEvent.click(chip);

    expect(screen.getByRole("region", { name: "작업지시 2643" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "작업 트레이" })).not.toBeInTheDocument();
  });

  it("closes the panel back to the default (grid) arrangement", () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("open"));

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(screen.queryByRole("region", { name: "작업지시 2643" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "작업 트레이" })).not.toBeInTheDocument();
    expect(hostWrapper().style.paddingRight).toBe("");
  });

  it("restore-default resets every window", () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("open"));
    expect(screen.getByRole("region", { name: "작업지시 2643" })).toBeVisible();

    fireEvent.click(screen.getByTestId("reset"));

    expect(screen.queryByRole("region", { name: "작업지시 2643" })).not.toBeInTheDocument();
  });

  it("exposes the window controls as keyboard-operable, named buttons", () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("open"));

    for (const name of ["최소화", "닫기"]) {
      const control = screen.getByRole("button", { name });
      // Native <button> is inherently keyboard operable (Enter/Space) + focusable.
      expect(control.tagName).toBe("BUTTON");
      expect(control).toHaveAccessibleName(name);
      control.focus();
      expect(control).toHaveFocus();
    }
  });
});
