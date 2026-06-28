import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ko } from "../i18n/ko";
import { formatWonAmount } from "./currency";
import { Mono, Won } from "./format";

describe("format primitives", () => {
  it("formats won amounts once for financial UI reuse", () => {
    expect(formatWonAmount(1234567)).toBe("1,234,567");
  });

  it("renders identifiers with mono/tabular typography", () => {
    render(<Mono>AAANN-0001</Mono>);

    expect(screen.getByText("AAANN-0001")).toHaveClass(
      "font-mono",
      "tabular-nums",
    );
  });

  it("renders won amounts with mono digits and the localized unit", () => {
    render(<Won amount={1234567} />);

    expect(screen.getByLabelText(`1,234,567 ${ko.financial.wonUnit}`)).toBeVisible();
    expect(screen.getByText("1,234,567")).toHaveClass(
      "font-mono",
      "tabular-nums",
    );
    expect(screen.getByText(ko.financial.wonUnit)).toBeVisible();
  });
});
