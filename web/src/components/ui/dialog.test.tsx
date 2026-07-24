import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./dialog";

function DialogHarness() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open dialog
      </button>
      <Dialog
        open={open}
        label="Example dialog"
        onClose={() => {
          setOpen(false);
        }}
      >
        Dialog content
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("closes on Escape and restores focus to its opener", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);

    expect(screen.getByRole("dialog", { name: "Example dialog" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(opener).toHaveFocus();
  });

  it("closes from a valid scrim dismissal and restores focus to its opener", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Example dialog" });
    const scrim = dialog.parentElement;
    if (scrim === null) {
      throw new Error("Dialog scrim was not rendered");
    }

    expect(fireEvent.mouseDown(scrim)).toBe(false);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(opener).toHaveFocus();
  });

  it("ignores scrim mousedown when scrim dismissal is disabled", () => {
    const onClose = vi.fn();
    render(
      <Dialog
        open
        label="Example dialog"
        onClose={onClose}
        closeOnScrimClick={false}
      >
        Dialog content
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Example dialog" });
    const scrim = dialog.parentElement;
    if (scrim === null) {
      throw new Error("Dialog scrim was not rendered");
    }

    fireEvent.mouseDown(scrim);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Example dialog" })).toBeInTheDocument();
  });
});
