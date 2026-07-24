import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";

import { FinancialPage } from "./FinancialPage";
import type { AuthSession } from "../context/auth";
import { AuthTestProvider } from "../test/AuthTestProvider";
import { ko } from "../i18n/ko";

function CurrentLocation() {
  const location = useLocation();
  return (
    <output aria-label="current location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderPage(
  initialEntry: string,
  session: AuthSession = { access_token: "a", roles: ["ADMIN"] },
) {
  return render(
    <AuthTestProvider session={session}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <FinancialPage />
        <CurrentLocation />
      </MemoryRouter>
    </AuthTestProvider>,
  );
}

describe("FinancialPage", () => {
  it("opens the tab requested by a deep link", () => {
    renderPage("/financial?tab=quote");

    expect(
      screen.getByRole("tab", { name: ko.financial.tabs.quote }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: ko.financial.quote.listTitle }),
    ).toBeVisible();
  });

  it("falls back to purchase requests for invalid tab hints", () => {
    renderPage("/financial?tab=unknown");

    expect(
      screen.getByRole("tab", { name: ko.financial.tabs.purchase }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: ko.financial.purchase.listTitle }),
    ).toBeVisible();
  });

  it("keeps the URL tab hint in sync when users switch workbenches", async () => {
    const user = userEvent.setup();
    renderPage("/financial?tab=purchase&source=intelligence");

    await user.click(screen.getByRole("tab", { name: ko.financial.tabs.assetCost }));

    expect(
      screen.getByRole("tab", { name: ko.financial.tabs.assetCost }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("current location")).toHaveTextContent(
      "/financial?tab=assetCost&source=intelligence",
    );
  });

  it("hides command links that the current role cannot open", () => {
    renderPage("/financial?tab=purchase", {
      access_token: "e",
      roles: ["EXECUTIVE"],
    });

    expect(
      screen.queryByRole("link", { name: ko.financial.command.links.approvals }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: ko.financial.command.links.workflows }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: ko.financial.command.links.assets }),
    ).toHaveAttribute("href", "/equipment");
  });
});
