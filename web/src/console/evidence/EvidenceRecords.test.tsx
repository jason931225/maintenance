import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import { WindowManagerProvider } from "../window";
import { EvidenceRecords } from "./EvidenceRecords";
import { createEvidenceStubs } from "./evidenceStubs";

const T = ko.console.evidence;
const stubs = createEvidenceStubs();

describe("EvidenceRecords list", () => {
  it("renders every EV- row as an objDrag source", () => {
    render(<EvidenceRecords />);
    for (const row of stubs) {
      const code = screen.getByText(row.code);
      expect(code.getAttribute("data-obj-code")).toBe(row.code);
      expect(code.getAttribute("draggable")).toBe("true");
    }
  });

  it("shows the compact stat bar with per-status counts", () => {
    render(<EvidenceRecords />);
    const bar = screen.getByRole("group", { name: T.records.statBar });
    expect(within(bar).getByRole("button", { name: new RegExp(T.records.all) })).toBeTruthy();
    expect(
      within(bar).getByRole("button", { name: new RegExp(T.admissibility.INADMISSIBLE) }),
    ).toBeTruthy();
  });
});

describe("EvidenceRecords filtering", () => {
  it("filters rows by admissibility and toggles back to all", () => {
    render(<EvidenceRecords />);
    const bar = screen.getByRole("group", { name: T.records.statBar });
    const inadmissible = within(bar).getByRole("button", {
      name: new RegExp(T.admissibility.INADMISSIBLE),
    });

    fireEvent.click(inadmissible);
    expect(screen.queryByText("EV-2026-00012")).toBeNull();
    expect(screen.getByText("EV-2026-00009")).toBeTruthy();

    fireEvent.click(inadmissible);
    expect(screen.getByText("EV-2026-00012")).toBeTruthy();
  });

  it("filters to legal-hold rows", () => {
    render(<EvidenceRecords />);
    const bar = screen.getByRole("group", { name: T.records.statBar });
    fireEvent.click(within(bar).getByRole("button", { name: new RegExp(T.hold.active) }));
    expect(screen.getByText("EV-2026-00012")).toBeTruthy();
    expect(screen.queryByText("EV-2026-00013")).toBeNull();
  });
});

describe("EvidenceRecords detail opening", () => {
  it("opens the EvidenceCard as the right pin when the window shell is mounted (§4.7-3)", () => {
    const [first] = stubs;
    render(
      <WindowManagerProvider>
        <EvidenceRecords />
      </WindowManagerProvider>,
    );
    // Both the EV- code button and the 상세 button open the detail.
    fireEvent.click(
      screen.getAllByRole("button", { name: T.records.open(first.code, first.title) })[0],
    );
    const detail = screen.getByLabelText(T.detailAria(first.code));
    expect(within(detail).getByText(T.worm.originalImmutable)).toBeTruthy();
  });

  it("opens the EvidenceCard inline when no window shell is mounted", () => {
    const [first] = stubs;
    render(<EvidenceRecords />);
    fireEvent.click(
      screen.getAllByRole("button", { name: T.records.open(first.code, first.title) })[1],
    );
    const detail = screen.getByLabelText(T.detailAria(first.code));
    expect(within(detail).getByText(T.worm.originalImmutable)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: T.records.close }));
    expect(screen.queryByLabelText(T.detailAria(first.code))).toBeNull();
  });
});
