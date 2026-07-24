import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { OperationsIntelligencePage } from "./OperationsIntelligencePage";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { ko } from "../i18n/ko";

function makeAuthContext(session: AuthSession): AuthContextValue {
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: {} as AuthContextValue["api"],
  };
}

function renderPage(session: AuthSession = { access_token: "a", roles: ["ADMIN"] }) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter>
        <OperationsIntelligencePage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("OperationsIntelligencePage", () => {
  it("renders a governed scenario workbench instead of an autonomous AI panel", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { name: ko.intelligence.title }),
    ).toBeVisible();
    expect(screen.getByText("운영 의사결정 워크벤치")).toBeVisible();
    expect(screen.getByText("자동 변경 없음")).toBeVisible();
    expect(screen.getByText("검토 초안")).toBeVisible();
    expect(screen.getByText("AI는 보조")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "품질 검토" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/자동 실행/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/데모/u)).not.toBeInTheDocument();
  });

  it("connects each admin-visible decision domain to source evidence and workflow conversion routes", () => {
    renderPage();

    const pricingCard = screen.getByRole("heading", {
      name: "렌탈 가격·입찰 마진",
    }).closest("section");
    expect(pricingCard).toBeTruthy();
    expect(within(pricingCard as HTMLElement).getByText("PricingScenario")).toBeVisible();
    expect(
      within(pricingCard as HTMLElement).getByRole("link", {
        name: "견적 워크벤치",
      }),
    ).toHaveAttribute("href", "/financial?tab=quote");
    expect(
      within(pricingCard as HTMLElement).getByRole("link", { name: "승인 초안" }),
    ).toHaveAttribute(
      "href",
      "/approvals?source=intelligence&domain=rental-pricing",
    );

    expect(
      screen.getByRole("heading", { name: "장비 매각·보유·교체" }),
    ).toBeVisible();
    expect(screen.getByText("AssetLifecycleDecision")).toBeVisible();
    expect(screen.getByText("CapacityPlan")).toBeVisible();
    expect(screen.getByText("MaintenanceForecast")).toBeVisible();
    expect(screen.getByText("MES 준비도")).toBeVisible();
  });

  it("hides admin-only conversion links from executive-only readers", () => {
    renderPage({ access_token: "e", roles: ["EXECUTIVE"] });

    const pricingCard = screen.getByRole("heading", {
      name: "렌탈 가격·입찰 마진",
    }).closest("section");
    expect(pricingCard).toBeTruthy();
    expect(
      within(pricingCard as HTMLElement).getByRole("link", {
        name: "견적 워크벤치",
      }),
    ).toHaveAttribute("href", "/financial?tab=quote");
    expect(
      within(pricingCard as HTMLElement).queryByRole("link", { name: "승인 초안" }),
    ).not.toBeInTheDocument();

    const reserveCard = screen.getByRole("heading", {
      name: "예비 장비·부품 정책",
    }).closest("section");
    expect(reserveCard).toBeTruthy();
    expect(
      within(reserveCard as HTMLElement).queryByRole("link", { name: "운영 현황" }),
    ).not.toBeInTheDocument();
    expect(
      within(reserveCard as HTMLElement).getByRole("link", { name: "가용 장비" }),
    ).toHaveAttribute("href", "/equipment?source=intelligence&view=availability");

    const mesCard = screen.getByRole("heading", { name: "MES 준비도" }).closest("section");
    expect(mesCard).toBeTruthy();
    expect(
      within(mesCard as HTMLElement).getByText("이 실행 경로는 권한 있는 관리자에게 요청하세요."),
    ).toBeVisible();
  });
});
