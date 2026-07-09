import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  computeDropdownPosition,
  detectActiveTrigger,
  useTokenGrammarInput,
} from "./useTokenGrammarInput";

describe("detectActiveTrigger", () => {
  it("detects an in-progress mention right after the trigger", () => {
    expect(detectActiveTrigger("@", 1)).toEqual({ trigger: "@", start: 0, query: "" });
  });

  it("detects an in-progress Korean mention query", () => {
    expect(detectActiveTrigger("안녕 @홍길", 6)).toEqual({
      trigger: "@",
      start: 3,
      query: "홍길",
    });
  });

  it("detects an in-progress object-link query", () => {
    expect(detectActiveTrigger("#작업", 3)).toEqual({
      trigger: "#",
      start: 0,
      query: "작업",
    });
  });

  it("detects an in-progress code-link query", () => {
    expect(detectActiveTrigger("!AP-31", 6)).toEqual({
      trigger: "!",
      start: 0,
      query: "AP-31",
    });
  });

  it("is null once whitespace is typed after the trigger (space reverts)", () => {
    expect(detectActiveTrigger("@홍길동 ", 5)).toBeNull();
  });

  it("is null for a pure-numeric # query (#23 stays inert while typing)", () => {
    expect(detectActiveTrigger("#23", 3)).toBeNull();
  });

  it("is null for !! (no valid code shape)", () => {
    expect(detectActiveTrigger("!!", 2)).toBeNull();
  });

  it("is null for an email local-part @ (no boundary before it)", () => {
    expect(detectActiveTrigger("a@b", 2)).toBeNull();
  });

  it("is null when the cursor is outside any token", () => {
    expect(detectActiveTrigger("plain text", 5)).toBeNull();
  });

  it("is null for an empty document", () => {
    expect(detectActiveTrigger("", 0)).toBeNull();
  });
});

describe("computeDropdownPosition", () => {
  const viewport = { width: 800, height: 600 };
  const dropdown = { width: 240, height: 160 };

  it("places the dropdown below the caret when there is room, at its full requested height", () => {
    const result = computeDropdownPosition({ top: 100, bottom: 116, left: 50 }, dropdown, viewport);
    expect(result).toEqual({ top: 116, left: 50, placement: "below", maxHeight: 160 });
  });

  it("flips above the caret when there is no room below", () => {
    const result = computeDropdownPosition({ top: 500, bottom: 516, left: 50 }, dropdown, viewport);
    expect(result.placement).toBe("above");
    expect(result.top).toBe(500 - dropdown.height);
    expect(result.maxHeight).toBe(dropdown.height);
  });

  it("clamps the left edge so the dropdown never overflows the right viewport edge", () => {
    const result = computeDropdownPosition({ top: 100, bottom: 116, left: 780 }, dropdown, viewport);
    expect(result.left).toBeLessThanOrEqual(viewport.width - dropdown.width);
    expect(result.left).toBeGreaterThanOrEqual(0);
  });

  it("clamps the top edge so the dropdown never overflows above the viewport", () => {
    const result = computeDropdownPosition({ top: 2, bottom: 18, left: 50 }, dropdown, { width: 800, height: 20 });
    expect(result.top).toBeGreaterThanOrEqual(0);
  });

  it("shrinks maxHeight to the available space instead of clipping past the viewport edge", () => {
    // Only 60px available below the caret (spaceBelow still >= spaceAbove, so
    // "below" is still chosen) in a 600px-tall viewport, far less than the
    // dropdown's requested 160px.
    const result = computeDropdownPosition({ top: 10, bottom: 540, left: 50 }, dropdown, viewport);
    expect(result.placement).toBe("below");
    expect(result.maxHeight).toBeLessThan(dropdown.height);
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(viewport.height);
  });

  it("never returns a negative maxHeight even when there is no usable space at all", () => {
    const result = computeDropdownPosition({ top: 2, bottom: 18, left: 50 }, dropdown, { width: 800, height: 20 });
    expect(result.maxHeight).toBeGreaterThanOrEqual(0);
  });
});

function TokenInputHarness() {
  const [value, setValue] = useState("");
  const {
    inputRef,
    activeTrigger,
    highlightedCode,
    setHighlightedCode,
    confirmToken,
    handleChange,
    handleKeyDown,
    handleSelect,
    handleCompositionStart,
    handleCompositionEnd,
  } = useTokenGrammarInput(value, setValue);
  return (
    <div>
      <textarea
        aria-label="composer"
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={handleSelect}
        onClick={handleSelect}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />
      <div data-testid="active-trigger">
        {activeTrigger ? `${activeTrigger.trigger}:${activeTrigger.query}` : "none"}
      </div>
      <div data-testid="highlighted">{highlightedCode ?? "none"}</div>
      <button type="button" onClick={() => { setHighlightedCode("WO-2643"); }}>
        highlight
      </button>
      <button type="button" onClick={() => { confirmToken("WO-2643"); }}>
        confirm
      </button>
      <input aria-label="next field" />
    </div>
  );
}

describe("useTokenGrammarInput", () => {
  it("tracks the active trigger while typing and clears it after a space", async () => {
    const user = userEvent.setup();
    render(<TokenInputHarness />);
    const textarea = screen.getByLabelText("composer");

    await user.type(textarea, "안녕 #작업");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("#:작업");

    await user.type(textarea, " ");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("none");
  });

  it("Enter never auto-confirms — it inserts a literal newline, not a resolved token", async () => {
    const user = userEvent.setup();
    render(<TokenInputHarness />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("composer");

    await user.type(textarea, "참고 #작업");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("#:작업");

    await user.keyboard("{Enter}");
    expect(textarea).toHaveValue("참고 #작업\n");
    expect(textarea.value).not.toContain("WO-2643");
  });

  it("confirmToken (the only commit path — wired to click/Tab by the caller) inserts the token at the trigger position", async () => {
    const user = userEvent.setup();
    render(<TokenInputHarness />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("composer");

    await user.type(textarea, "참고 #작업");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("#:작업");

    await user.click(screen.getByText("confirm"));
    expect(textarea.value).toBe("참고 #WO-2643 ");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("none");
  });

  it("Esc clears the active trigger without touching the typed text", async () => {
    const user = userEvent.setup();
    render(<TokenInputHarness />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("composer");

    await user.type(textarea, "!AP-31");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("!:AP-31");

    await user.keyboard("{Escape}");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("none");
    expect(textarea).toHaveValue("!AP-31");
  });

  it("Tab confirms the highlighted candidate and prevents the default focus-move", async () => {
    const user = userEvent.setup();
    render(<TokenInputHarness />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("composer");

    await user.type(textarea, "참고 #작업");
    await user.click(screen.getByText("highlight"));
    expect(screen.getByTestId("highlighted")).toHaveTextContent("WO-2643");

    // fireEvent (not userEvent) so the keydown is dispatched straight at the
    // textarea regardless of userEvent's own focus-order tracking; its
    // dispatchEvent return value is `false` iff preventDefault() was called.
    const notPrevented = fireEvent.keyDown(textarea, { key: "Tab" });

    expect(notPrevented).toBe(false);
    expect(textarea.value).toBe("참고 #WO-2643 ");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("none");
    expect(screen.getByTestId("highlighted")).toHaveTextContent("none");
  });

  it("Tab does nothing (default browser focus-move stays uninterrupted) when no candidate is highlighted", async () => {
    const user = userEvent.setup();
    render(<TokenInputHarness />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("composer");

    await user.type(textarea, "참고 #작업");
    const notPrevented = fireEvent.keyDown(textarea, { key: "Tab" });

    expect(notPrevented).toBe(true); // preventDefault was NOT called — Tab keeps its normal behavior
    expect(textarea.value).toBe("참고 #작업");
    expect(textarea.value).not.toContain("WO-2643");
  });

  it("suspends trigger detection during IME composition and recomputes once composition ends", async () => {
    const user = userEvent.setup();
    render(<TokenInputHarness />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("composer");

    // userEvent can't emit real composition events, so this is driven manually
    // (fireEvent) rather than through user.type.
    await user.type(textarea, "@");
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("@:");

    fireEvent.compositionStart(textarea);
    // Mid-composition: this would normally clear the trigger (trailing space),
    // but must be ignored while composing.
    fireEvent.change(textarea, { target: { value: "@ ", selectionStart: 2 } });
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("@:");

    fireEvent.compositionEnd(textarea, { target: { value: "@ ", selectionStart: 2 } });
    expect(screen.getByTestId("active-trigger")).toHaveTextContent("none");
  });

  it("does not confirm a token while composing, even if a candidate is highlighted", async () => {
    const user = userEvent.setup();
    render(<TokenInputHarness />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("composer");

    await user.type(textarea, "참고 #작업");
    await user.click(screen.getByText("highlight"));
    fireEvent.compositionStart(textarea);

    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(textarea.value).toBe("참고 #작업");
    expect(textarea.value).not.toContain("WO-2643");
  });
});
