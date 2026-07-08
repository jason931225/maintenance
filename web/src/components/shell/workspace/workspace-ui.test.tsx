import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { ConsoleScreenContext } from "../../../features/workspace/pin-context";
import { selectScreenPanels, useWorkspaceStore } from "../../../features/workspace/store";
import type { PinnedObject } from "../../../features/workspace/types";
import { PinButton } from "./PinButton";
import { QuadrantContainer } from "./QuadrantContainer";
import { Tray } from "./Tray";

const wo: PinnedObject = {
  kind: "workOrder",
  code: "WO-1",
  title: "작업 1",
  fields: [{ label: "상태", value: "진행" }],
};

// A minimal ConsoleShell-like harness for the "work-hub" screen: the window grid
// hosting a pinnable row, plus the tray. Exercises the pin -> panel -> minimize
// -> restore -> close loop without mocking the real page data.
function Harness() {
  const workspaceRef = useRef<HTMLElement>(null);
  // Select the stable panels reference, then derive — a selector that returns a
  // fresh array every call breaks useSyncExternalStore (zustand v5).
  const allPanels = useWorkspaceStore((s) => s.panels);
  const panels = selectScreenPanels(allPanels, "work-hub");
  const minimize = useWorkspaceStore((s) => s.minimize);
  const restore = useWorkspaceStore((s) => s.restore);
  const popout = useWorkspaceStore((s) => s.popout);
  const close = useWorkspaceStore((s) => s.close);
  const restoreDefault = useWorkspaceStore((s) => s.restoreDefault);
  const minimized = panels.filter((p) => p.mode === "minimized");
  // Mirror ConsoleShell: return focus to the workspace after removing the
  // focused control.
  const focus = () => workspaceRef.current?.focus();
  return (
    <>
      <QuadrantContainer
        workspaceRef={workspaceRef}
        panels={panels}
        onMinimize={(id) => {
          minimize(id);
          focus();
        }}
        onPopout={popout}
        onClose={(id) => {
          close(id);
          focus();
        }}
      >
        <ConsoleScreenContext.Provider value="work-hub">
          <PinButton object={wo} />
        </ConsoleScreenContext.Provider>
      </QuadrantContainer>
      <Tray
        minimized={minimized}
        hasAnyPanels={panels.length > 0}
        onRestore={restore}
        onRestoreDefault={() => {
          restoreDefault("work-hub");
        }}
      />
    </>
  );
}

beforeEach(() => {
  useWorkspaceStore.setState({ panels: [], hydrated: false, saveEnabled: false, snapPreview: null, draggingId: null });
});

describe("workspace window UI", () => {
  it("pins a row into a detail panel, then minimizes to the tray and restores", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "작업 1 상세 고정" }));
    // Panel is on the grid (its region has an accessible name of code + title).
    expect(screen.getByRole("region", { name: "WO-1 작업 1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "최소화" }));
    expect(screen.queryByRole("region", { name: "WO-1 작업 1" })).not.toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "작업 1 복원" });
    expect(chip).toBeInTheDocument();

    await user.click(chip);
    expect(screen.getByRole("region", { name: "WO-1 작업 1" })).toBeInTheDocument();
  });

  it("closes a pinned panel", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "작업 1 상세 고정" }));
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("region", { name: "WO-1 작업 1" })).not.toBeInTheDocument();
  });

  it("moves focus into the panel header on open", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "작업 1 상세 고정" }));
    const header = screen.getByRole("region", { name: "WO-1 작업 1" }).querySelector("header");
    expect(header).toHaveFocus();
  });

  it("returns focus to the workspace (not <body>) after close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "작업 1 상세 고정" }));
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("restore-default clears the screen's panels", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "작업 1 상세 고정" }));
    await user.click(screen.getByRole("button", { name: "기본 배치" }));
    expect(useWorkspaceStore.getState().panels).toHaveLength(0);
  });
});
