import { fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { WindowEngine } from "./WindowEngine";
import type { CardRegistry, CardTitles } from "./types";
import { useWindowEngine } from "./useWindowEngine";

const REGISTRY: CardRegistry = {
  a: { off: 214, main: ["roster"], side: ["issues", "board"], min: { roster: 340, issues: 300, board: 360 } },
  b: { off: 176, main: ["teams"], side: ["tasks"], min: { teams: 260, tasks: 240 } },
};
const TITLES: CardTitles = {
  a: { roster: "명부", issues: "이상", board: "현황" },
  b: { teams: "진행", tasks: "할일" },
};

// persist:false → no network; a stub client satisfies the type only.
const noApi = {} as unknown as ConsoleApiClient;

function Harness() {
  const [scr, setScr] = useState("a");
  const engine = useWindowEngine({ registry: REGISTRY, api: noApi, ownerKey: "u1", persist: false });
  return (
    <div>
      <button
        type="button"
        data-testid="to-a"
        onClick={() => {
          setScr("a");
        }}
      >
        a
      </button>
      <button
        type="button"
        data-testid="to-b"
        onClick={() => {
          setScr("b");
        }}
      >
        b
      </button>
      <WindowEngine engine={engine} scr={scr} registry={REGISTRY} titles={TITLES} renderBody={() => "body"} />
    </div>
  );
}

/** Query one element, throwing (no non-null assertion) when absent. */
function el(root: HTMLElement, sel: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(sel);
  if (!found) throw new Error(`missing element: ${sel}`);
  return found;
}
const card = (root: HTMLElement, id: string) => el(root, `[data-card-id="${id}"]`);
const header = (c: HTMLElement) => el(c, "[data-card-header]");
const zone = (root: HTMLElement) => el(root, '[data-window-scr="a"]');
const state = (root: HTMLElement, id: string) => card(root, id).dataset.cardState;

describe("window engine grammar", () => {
  it("header-drag within the band pops the card out to a free float", () => {
    const { container } = render(<Harness />);
    expect(state(container, "issues")).toBe("grid");
    fireEvent.mouseDown(header(card(container, "issues")), { button: 0, clientX: 200, clientY: 10 });
    fireEvent.mouseUp(document.body, { clientY: 10 });
    expect(state(container, "issues")).toBe("popout-float");
  });

  it("does NOT drag when the mousedown is below the 54px header band", () => {
    const { container } = render(<Harness />);
    fireEvent.mouseDown(header(card(container, "issues")), { button: 0, clientX: 200, clientY: 120 });
    fireEvent.mouseUp(document.body, { clientY: 120 });
    expect(state(container, "issues")).toBe("grid");
  });

  it("does NOT drag when the mousedown target is a control (button)", () => {
    const { container } = render(<Harness />);
    fireEvent.mouseEnter(card(container, "issues"));
    const pinBtn = within(card(container, "issues")).getByRole("button", { name: ko.console.window.pin });
    fireEvent.mouseDown(pinBtn, { button: 0, clientX: 200, clientY: 10 });
    fireEvent.mouseUp(document.body, { clientY: 10 });
    expect(state(container, "issues")).toBe("grid");
  });

  it("double-click pins the card and reserves real body padding-right", () => {
    const { container } = render(<Harness />);
    const before = parseFloat(zone(container).style.paddingRight) || 0;
    fireEvent.doubleClick(header(card(container, "issues")), { clientX: 200, clientY: 10 });
    expect(state(container, "issues")).toBe("pin-split");
    const after = parseFloat(zone(container).style.paddingRight);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(16);
  });

  it("minimize sends the card to the tray; the chip restores it to the grid", () => {
    const { container } = render(<Harness />);
    fireEvent.mouseEnter(card(container, "issues"));
    fireEvent.click(within(card(container, "issues")).getByRole("button", { name: ko.console.window.minimize }));
    expect(container.querySelector('[data-card-id="issues"]')).toBeNull(); // gone from the zone
    const chip = el(container, '[data-tray-chip="issues"]');
    fireEvent.click(chip);
    expect(state(container, "issues")).toBe("grid"); // restored to default zone
  });

  it("close (X) restores a floated card to its default zone", () => {
    const { container } = render(<Harness />);
    fireEvent.doubleClick(header(card(container, "issues")), { clientX: 200, clientY: 10 });
    expect(state(container, "issues")).toBe("pin-split");
    fireEvent.mouseEnter(card(container, "issues"));
    fireEvent.click(within(card(container, "issues")).getByRole("button", { name: ko.console.window.close }));
    expect(state(container, "issues")).toBe("grid");
  });

  it("re-anchors a right-pinned card to follow the viewport's right edge on resize", () => {
    const { container } = render(<Harness />);
    fireEvent.doubleClick(header(card(container, "issues")), { clientX: 200, clientY: 10 });
    expect(state(container, "issues")).toBe("pin-split");
    const before = parseFloat(card(container, "issues").style.left);
    // Widen the viewport; the resize listener re-flows anchored floats.
    (window as unknown as { innerWidth: number }).innerWidth = 1680;
    fireEvent(window, new Event("resize"));
    const after = parseFloat(card(container, "issues").style.left);
    expect(after).toBeGreaterThan(before); // x tracked the wider right edge
  });

  it("a float survives a screen switch and back (mounted-persistent state)", () => {
    const { container, getByTestId } = render(<Harness />);
    fireEvent.doubleClick(header(card(container, "issues")), { clientX: 200, clientY: 10 });
    expect(state(container, "issues")).toBe("pin-split");
    // Switch to screen b — issues is not part of b, so it is not rendered.
    fireEvent.click(getByTestId("to-b"));
    expect(container.querySelector('[data-card-id="issues"]')).toBeNull();
    expect(container.querySelector('[data-card-id="teams"]')).not.toBeNull();
    // Back to a — the pin is still there.
    fireEvent.click(getByTestId("to-a"));
    expect(state(container, "issues")).toBe("pin-split");
  });
});
