import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ConsoleScreenContext,
  ConsoleWorkspaceOwnerContext,
} from "../../../features/workspace/pin-context";
import { selectScreenPanels, useWorkspaceStore } from "../../../features/workspace/store";
import type { Panel, PinnedObject } from "../../../features/workspace/types";
import { FloatWindow } from "./FloatWindow";
import { PinButton } from "./PinButton";
import { QuadrantContainer } from "./QuadrantContainer";
import { Tray } from "./Tray";

const wo: PinnedObject = {
  kind: "workOrder",
  code: "WO-1",
  title: "작업 1",
  fields: [{ label: "상태", value: "진행" }],
};

// A minimal ConsoleShell-like harness for the "overview" screen: the window grid
// hosting a pinnable row, plus the tray. Exercises the pin -> panel -> minimize
// -> restore -> close loop without mocking the real page data.
function Harness() {
  const workspaceRef = useRef<HTMLElement>(null);
  // Select the stable panels reference, then derive — a selector that returns a
  // fresh array every call breaks useSyncExternalStore (zustand v5).
  const allPanels = useWorkspaceStore((s) => s.panels);
  const panels = selectScreenPanels(allPanels, "overview");
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
        <ConsoleScreenContext.Provider value="overview">
          <PinButton object={wo} />
        </ConsoleScreenContext.Provider>
      </QuadrantContainer>
      <Tray
        minimized={minimized}
        hasAnyPanels={panels.length > 0}
        onRestore={restore}
        onRestoreDefault={() => {
          restoreDefault("overview");
        }}
      />
    </>
  );
}

beforeEach(() => {
  useWorkspaceStore.setState({ ownerKey: null, panels: [], hydrated: false, saveEnabled: false, snapPreview: null, draggingId: null });
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

  it("does not pin when the workspace owner context is stale", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      ownerKey: "org-old:user-old",
      panels: [],
      hydrated: true,
      saveEnabled: true,
      snapPreview: null,
      draggingId: null,
    });

    render(
      <ConsoleWorkspaceOwnerContext.Provider value="org-new:user-new">
        <ConsoleScreenContext.Provider value="overview">
          <PinButton object={wo} />
        </ConsoleScreenContext.Provider>
      </ConsoleWorkspaceOwnerContext.Provider>,
    );

    const button = screen.getByRole("button", { name: "작업 1 상세 고정" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(useWorkspaceStore.getState().panels).toHaveLength(0);
  });

  it("does not let a stale floating drag mutate a new owner's workspace", () => {
    const panel: Panel = {
      id: "overview:workOrder:WO-1",
      screen: "overview",
      area: "left",
      mode: "float",
      object: wo,
      float: { x: 64, y: 64, w: 320, h: 240 },
    };
    const workspace = document.createElement("section");
    Object.defineProperty(workspace, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 400,
        width: 400,
        height: 400,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });
    useWorkspaceStore.setState({
      ownerKey: "org-old:user-old",
      panels: [panel],
      hydrated: true,
      saveEnabled: true,
      snapPreview: null,
      draggingId: null,
    });
    const onSnap = () => {
      useWorkspaceStore.getState().pin("overview", panel.object, "left");
    };
    const onMove = () => {
      useWorkspaceStore
        .getState()
        .moveFloat(panel.id, { x: 16, y: 16, w: 320, h: 240 });
    };

    render(
      <FloatWindow
        panel={panel}
        ownerKey="org-old:user-old"
        workspaceRef={{ current: workspace }}
        onSnap={onSnap}
        onMove={onMove}
        onMinimize={() => {
          useWorkspaceStore.getState().minimize(panel.id);
        }}
        onClose={() => {
          useWorkspaceStore.getState().close(panel.id);
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByTestId("workspace-pin-panel-header"), {
      button: 0,
      clientX: 80,
      clientY: 80,
    });
    useWorkspaceStore.getState().resetForOwner("org-new:user-new");
    fireEvent.pointerUp(window, {
      clientX: 8,
      clientY: 8,
    });

    expect(useWorkspaceStore.getState()).toMatchObject({
      ownerKey: "org-new:user-new",
      panels: [],
      snapPreview: null,
      draggingId: null,
    });
  });
});
