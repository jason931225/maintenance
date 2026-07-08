import { render, screen } from "@testing-library/react";
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

  it("places the dropdown below the caret when there is room", () => {
    const result = computeDropdownPosition({ top: 100, bottom: 116, left: 50 }, dropdown, viewport);
    expect(result).toEqual({ top: 116, left: 50, placement: "below" });
  });

  it("flips above the caret when there is no room below", () => {
    const result = computeDropdownPosition({ top: 500, bottom: 516, left: 50 }, dropdown, viewport);
    expect(result.placement).toBe("above");
    expect(result.top).toBe(500 - dropdown.height);
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
});

function TokenInputHarness() {
  const [value, setValue] = useState("");
  const { inputRef, activeTrigger, confirmToken, handleChange, handleKeyDown, handleSelect } =
    useTokenGrammarInput(value, setValue);
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
      />
      <div data-testid="active-trigger">
        {activeTrigger ? `${activeTrigger.trigger}:${activeTrigger.query}` : "none"}
      </div>
      <button type="button" onClick={() => { confirmToken("WO-2643"); }}>
        confirm
      </button>
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
});
