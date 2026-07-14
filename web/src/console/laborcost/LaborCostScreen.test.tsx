import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ko } from "../../i18n/ko";
import { LaborCostScreen } from "./LaborCostScreen";
import { formatLaborHours, laborCostStrings } from "./strings";

describe("LaborCostScreen", () => {
  it("formats hours with the labor-cost string contract", () => {
    const strings = laborCostStrings();

    expect(formatLaborHours(7.5, strings.hourUnit)).toBe(`7.5${strings.hourUnit}`);
  });

  it("sources composition and projection units from laborCostStrings", () => {
    const locale = ko.console.laborcost as typeof ko.console.laborcost & { hourUnit: string };
    const previousUnit = locale.hourUnit;
    const testUnit = "test-unit";
    locale.hourUnit = testUnit;

    try {
      render(
        <LaborCostScreen
          periods={[]}
          hours={{ regular: 7.5, overtime: 0, night: 0, holiday: 0 }}
          trend={[1, 2, 3]}
          isLoading={false}
          onDrill={vi.fn()}
        />,
      );

      expect(
        screen.getByRole("button", {
          name: ko.console.charts.drill(locale.hoursRegular, `7.5${testUnit}`),
        }),
      ).toBeVisible();

      const projection = screen.getByRole("region", {
        name: ko.console.charts.projection.title(locale.trendTitle),
      });
      expect(
        within(projection)
          .getAllByRole("button")
          .some((button) => button.getAttribute("aria-label")?.includes(testUnit)),
      ).toBe(true);
    } finally {
      locale.hourUnit = previousUnit;
    }
  });
});
