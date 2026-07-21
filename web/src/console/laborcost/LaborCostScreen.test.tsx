import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
          projectionResult={{
            point_estimate: 4,
            ci95_low: 2,
            ci95_high: 6,
            cvar95: 1,
            assumptions: {
              ewma_volatility: 20,
              student_t_nu: 4,
              drift: 1,
              simulations: 1_000,
              seed: 7,
            },
          }}
          isLoading={false}
          loadError={null}
          onRetry={vi.fn()}
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
      expect(
        within(projection).getByText(
          ko.console.charts.projection.assumptionEwmaVolatility(`20${testUnit}`),
        ),
      ).toBeVisible();
    } finally {
      locale.hourUnit = previousUnit;
    }
  });

  it.each([
    ["list" as const, laborCostStrings().listError],
    ["detail" as const, laborCostStrings().detailError],
  ])("renders an accessible %s error with retry", async (loadError, message) => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    render(
      <LaborCostScreen
        periods={loadError === "detail" ? [{ runId: "r1", periodLabel: "2026-04-01", status: "STAGED" }] : []}
        hours={{ regular: 100, overtime: 0, night: 0, holiday: 0 }}
        trend={[100, 110, 120]}
        isLoading={false}
        loadError={loadError}
        onRetry={onRetry}
        onDrill={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("region", { name: laborCostStrings().compositionTitle })).not.toBeInTheDocument();
    expect(screen.queryByText(laborCostStrings().emptyReason)).not.toBeInTheDocument();
    if (loadError === "detail") expect(screen.getByText("2026-04-01")).toBeVisible();

    await user.click(screen.getByRole("button", { name: laborCostStrings().retry }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
