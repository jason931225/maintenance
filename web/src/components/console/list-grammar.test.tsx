import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  CONSOLE_LIST_BODY_CLASS,
  CONSOLE_LIST_ROW_CLASS,
  useColumnResize,
  useListNav,
} from "./list-grammar";

function NavHarness({ onOpen }: { onOpen: (index: number) => void }) {
  const nav = useListNav({ count: 3, onOpen });
  return (
    <div role="listbox" tabIndex={0} onKeyDown={nav.onKeyDown}>
      {["AP-3108", "WO-2643", "AT-0703"].map((code, index) => (
        <button
          key={code}
          type="button"
          ref={nav.getItemRef(index)}
          data-selected={nav.selectedIndex === index}
          className={nav.getItemClassName(index)}
        >
          {code}
        </button>
      ))}
    </div>
  );
}

function ResizeHarness({ onCommit }: { onCommit: (width: number) => void }) {
  const [width, setWidth] = useState(160);
  const resize = useColumnResize({
    initialWidth: width,
    minWidth: 120,
    maxWidth: 260,
    onCommit(next) {
      setWidth(next);
      onCommit(next);
    },
  });
  return (
    <div>
      <div data-testid="width">{resize.width}</div>
      <button
        type="button"
        aria-label="열 너비 조정"
        {...resize.getHandleProps()}
      />
    </div>
  );
}

describe("console list grammar hooks", () => {
  it("navigates dense lists with J/K and opens with Enter", async () => {
    const onOpen = vi.fn();
    render(<NavHarness onOpen={onOpen} />);

    const list = screen.getByRole("listbox");
    list.focus();
    await userEvent.keyboard("j");
    await userEvent.keyboard("j");
    await userEvent.keyboard("{Enter}");

    expect(screen.getByText("WO-2643")).toHaveAttribute("data-selected", "true");
    expect(screen.getByText("WO-2643")).toHaveClass("ring-console-signal");
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("wraps list navigation and clears selection on Escape", async () => {
    render(<NavHarness onOpen={() => undefined} />);

    screen.getByRole("listbox").focus();
    await userEvent.keyboard("k");
    expect(screen.getByText("AT-0703")).toHaveAttribute("data-selected", "true");

    await userEvent.keyboard("{Escape}");
    expect(screen.getByText("AT-0703")).toHaveAttribute("data-selected", "false");
  });

  it("resizes columns with pointer drag and clamps to readability floor", () => {
    const onCommit = vi.fn();
    render(<ResizeHarness onCommit={onCommit} />);

    const handle = screen.getByRole("separator", { name: "열 너비 조정" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 160 });
    fireEvent.pointerMove(window, { clientX: 80 });
    fireEvent.pointerUp(window, { clientX: 80 });

    expect(screen.getByTestId("width")).toHaveTextContent("120");
    expect(onCommit).toHaveBeenLastCalledWith(120);
    expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("quantizes dragged width to the 8px tick before clamping", () => {
    const onCommit = vi.fn();
    render(<ResizeHarness onCommit={onCommit} />);

    const handle = screen.getByRole("separator", { name: "열 너비 조정" });
    // startWidth 160, delta 13 -> raw 173, nearest 8px tick is 176.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 160 });
    fireEvent.pointerMove(window, { clientX: 173 });
    expect(screen.getByTestId("width")).toHaveTextContent("176");

    fireEvent.pointerUp(window, { clientX: 173 });
    expect(onCommit).toHaveBeenLastCalledWith(176);
  });

  it("ends the drag on pointercancel so a stray pointermove no longer resizes", () => {
    const onCommit = vi.fn();
    render(<ResizeHarness onCommit={onCommit} />);

    const handle = screen.getByRole("separator", { name: "열 너비 조정" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 160 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(screen.getByTestId("width")).toHaveTextContent("200");

    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(screen.getByTestId("width")).toHaveTextContent("160");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { clientX: 240 });
    expect(screen.getByTestId("width")).toHaveTextContent("160");
  });

  it("steps the handle width by the 8px tick with arrow keys, respecting the floor", () => {
    const onCommit = vi.fn();
    render(<ResizeHarness onCommit={onCommit} />);

    const handle = screen.getByRole("separator", { name: "열 너비 조정" });
    handle.focus();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(screen.getByTestId("width")).toHaveTextContent("168");
    expect(onCommit).toHaveBeenLastCalledWith(168);
    expect(handle).toHaveAttribute("aria-valuenow", "168");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(screen.getByTestId("width")).toHaveTextContent("120");
    expect(handle).toHaveAttribute("aria-valuemin", "120");
    expect(handle).toHaveAttribute("aria-valuemax", "260");
  });

  it("ignores J/K/Enter typed into an input or textarea inside the list wrapper", () => {
    const onOpen = vi.fn();
    render(<NavHarness onOpen={onOpen} />);

    const list = screen.getByRole("listbox");
    const input = document.createElement("input");
    list.appendChild(input);

    const preventDefault = vi.spyOn(KeyboardEvent.prototype, "preventDefault");
    fireEvent.keyDown(input, { key: "j" });

    expect(screen.getByText("AP-3108")).toHaveAttribute("data-selected", "false");
    expect(preventDefault).not.toHaveBeenCalled();
    preventDefault.mockRestore();
  });

  it("exports shared list body and row alignment classes", () => {
    expect(CONSOLE_LIST_BODY_CLASS).toContain("overscroll-contain");
    expect(CONSOLE_LIST_BODY_CLASS).toContain("after:from-console-surface");
    expect(CONSOLE_LIST_ROW_CLASS).toContain("grid-cols-[minmax(7rem,1.2fr)_minmax(0,2fr)_auto]");
  });
});
