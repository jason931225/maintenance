import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FinancialPage } from "../../pages/FinancialPage";
import { createConsoleApiClient } from "../../api/client";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import type { components } from "@maintenance/api-client-ts";
import { branchId } from "../../test/fixtures";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const equipmentId = "44444444-4444-4444-8444-444444444444";

const equipmentLookup: components["schemas"]["EquipmentLookupResponse"] = {
  id: equipmentId,
  branch_id: branchId,
  equipment_no: "D-25-290",
  management_no: "290",
  model: "GTS25DE",
  status: "rented",
  specification: "좌식",
  ton_text: "2.5T",
  maker: "현대",
  vin: null,
  vehicle_registration_no: null,
  customer: { id: "c1", name: "케이앤엘" },
  site: { id: "s1", name: "본사" },
};

function lookupHandler() {
  return http.get("*/api/v1/equipment/lookup", () =>
    HttpResponse.json(equipmentLookup),
  );
}

function soldSummary(): components["schemas"]["AssetLifecycleCostSummary"] {
  return {
    equipment_id: equipmentId,
    equipment_no: "D-25-290",
    status: "매각",
    acquisition_cost_won: 30_000_000,
    acquisition_date: "2024-06-01",
    acquisition_source: "EXPLICIT",
    maintenance_total_won: 4_500_000,
    manual_total_won: 1_500_000,
    purchase_total_won: 3_000_000,
    entry_count: 2,
    outsource_unlinked_won: 4_000_000,
    residual_value_won: 9_000_000,
    sale_price_won: 28_000_000,
    sold_at: "2026-06-12",
    gross_margin_won: -6_500_000,
    tco_won: 34_500_000,
    cost_per_month_won: 187_500,
    cost_per_hour_won: 3_750,
    timeline: [
      {
        id: "dddddddd-4444-4444-8444-dddddddddddd",
        branch_id: branchId,
        equipment_id: equipmentId,
        source: "MANUAL_ADMIN",
        amount_won: 1_500_000,
        memo: "유압 펌프 수리",
        residual_before_won: 10_000_000,
        residual_after_won: 9_500_000,
        entry_at: "2026-06-12T01:00:00Z",
      },
    ],
  };
}

function unsoldNoAcquisitionSummary(): components["schemas"]["AssetLifecycleCostSummary"] {
  return {
    equipment_id: equipmentId,
    equipment_no: "D-25-290",
    status: "임대",
    acquisition_cost_won: null,
    acquisition_date: null,
    acquisition_source: "VEHICLE_VALUE_FALLBACK",
    maintenance_total_won: 1_500_000,
    manual_total_won: 1_500_000,
    purchase_total_won: 0,
    entry_count: 1,
    outsource_unlinked_won: null,
    residual_value_won: 9_000_000,
    sale_price_won: null,
    sold_at: null,
    gross_margin_won: null,
    tco_won: 26_500_000,
    cost_per_month_won: null,
    cost_per_hour_won: null,
    timeline: [],
  };
}

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
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
    api,
  };
}

function renderApp(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/financial"]}>
        <FinancialPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function session(roles: string[]): AuthSession {
  return {
    access_token: roles.join("-").toLowerCase(),
    user_id: "user-1",
    roles,
    branches: [branchId],
  };
}

const adminSession = session(["ADMIN"]);
const receptionistSession = session(["RECEPTIONIST"]);

async function lookupEquipment(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText("호기 번호", { exact: true }),
    "290",
  );
  await user.click(screen.getByRole("button", { name: "호기 번호" }));
  await screen.findByText("GTS25DE");
}

describe("asset lifecycle cost panel", () => {
  it("renders TCO, margin, and per-hour cost for a sold asset", async () => {
    const user = userEvent.setup();
    server.use(
      lookupHandler(),
      http.get("*/api/v1/financial/equipment/:id/lifecycle-cost", () =>
        HttpResponse.json(soldSummary()),
      ),
    );

    renderApp(makeAuthContext(adminSession));
    await user.click(await screen.findByRole("tab", { name: "자산 비용" }));
    await lookupEquipment(user);
    await user.click(screen.getByRole("button", { name: "비용 조회" }));

    // TCO and maintenance splits render with thousands separators.
    expect(await screen.findByLabelText("34,500,000 원")).toBeVisible();
    expect(screen.getByLabelText("4,500,000 원")).toBeVisible();
    // Gross margin (a loss) is shown only when sold.
    expect(screen.getByLabelText("-6,500,000 원")).toBeVisible();
    // Per-hour intensity.
    expect(screen.getByLabelText("3,750 원")).toBeVisible();
    // Outsource cost is surfaced read-only.
    expect(screen.getByLabelText("4,000,000 원")).toBeVisible();
    expect(screen.getByText("보유·매각 검토 신호")).toBeVisible();
    expect(screen.getByText("검토 필요")).toBeVisible();
    expect(screen.getByText("• 매각 손익이 음수입니다.")).toBeVisible();
    expect(
      screen.getByText("• 정비비가 잔존가 대비 높습니다."),
    ).toBeVisible();
  });

  it("handles a NONE/fallback acquisition and NULL per-hour/per-month", async () => {
    const user = userEvent.setup();
    server.use(
      lookupHandler(),
      http.get("*/api/v1/financial/equipment/:id/lifecycle-cost", () =>
        HttpResponse.json(unsoldNoAcquisitionSummary()),
      ),
    );

    renderApp(makeAuthContext(adminSession));
    await user.click(await screen.findByRole("tab", { name: "자산 비용" }));
    await lookupEquipment(user);
    await user.click(screen.getByRole("button", { name: "비용 조회" }));

    // The vehicle-value fallback note is shown.
    expect(
      await screen.findByText("취득원가가 없어 차량가액으로 대체했습니다."),
    ).toBeVisible();
    // Per-month and per-hour cost are unavailable (rendered as the em dash).
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    // No gross-margin row for an unsold asset.
    expect(screen.queryByText("매각손익")).not.toBeInTheDocument();
    expect(screen.getByText("• 취득원가가 대체값 또는 미등록 상태입니다.")).toBeVisible();
  });

  it("denies the panel to a role without EquipmentCostLedgerRead", async () => {
    const user = userEvent.setup();
    server.use(lookupHandler());

    renderApp(makeAuthContext(receptionistSession));
    await user.click(await screen.findByRole("tab", { name: "자산 비용" }));

    // The read-gated panel renders no lookup control for a denied role.
    expect(
      screen.queryByRole("button", { name: "비용 조회" }),
    ).not.toBeInTheDocument();
  });
});
