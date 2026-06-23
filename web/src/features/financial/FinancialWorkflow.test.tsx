import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../../AppRouter";
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
const purchaseId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const quoteId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const evidenceId = "cccccccc-3333-4333-8333-cccccccccccc";

type PurchaseStatus = components["schemas"]["PurchaseStatus"];

const equipmentLookup: components["schemas"]["EquipmentLookupResponse"] = {
  id: equipmentId,
  branch_id: branchId,
  equipment_no: "D-25-290",
  management_no: "290",
  model: "GTS25DE",
  status: "rented",
  specification: "좌식",
  ton_text: "2.5T",
  customer: { id: "c1", name: "케이앤엘" },
  site: { id: "s1", name: "본사" },
};

function purchase(
  status: PurchaseStatus,
  extra: Partial<components["schemas"]["PurchaseRequestSummary"]> = {},
): components["schemas"]["PurchaseRequestSummary"] {
  return {
    id: purchaseId,
    branch_id: branchId,
    equipment_id: equipmentId,
    statement_evidence_id: evidenceId,
    vendor_name: "한빛부품",
    amount_won: 500_000,
    status,
    created_at: "2026-06-16T00:00:00Z",
    updated_at: "2026-06-16T00:00:00Z",
    ...extra,
  };
}

const quoteSummary: components["schemas"]["RentalQuoteSummary"] = {
  id: quoteId,
  branch_id: branchId,
  equipment_id: equipmentId,
  acquisition_value: 30_000_000,
  current_residual_value: 12_000_000,
  effective_residual_value: 12_000_000,
  residual_was_floored: false,
  cumulative_repair_cost: 1_000_000,
  monthly_total: 650_000,
  lines: [
    { code: "DEPRECIATION", label: "감가상각", amount: 450_000 },
    { code: "PROFIT", label: "이윤", amount: 200_000 },
  ],
  created_at: "2026-06-16T00:00:00Z",
};

const ledgerEntries: components["schemas"]["CostLedgerEntrySummary"][] = [
  {
    id: "dddddddd-4444-4444-8444-dddddddddddd",
    branch_id: branchId,
    equipment_id: equipmentId,
    source: "PURCHASE_EXECUTION",
    amount_won: 500_000,
    memo: "정기 부품 교체",
    residual_before_won: 12_000_000,
    residual_after_won: 11_500_000,
    entry_at: "2026-06-16T01:00:00Z",
  },
];

function lookupHandler() {
  return http.get("*/api/v1/equipment/lookup", () =>
    HttpResponse.json(equipmentLookup),
  );
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
        <AppRouter />
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
const mechanicSession = session(["MECHANIC"]);

async function lookupEquipment(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText("호기 번호", { exact: true }),
    "290",
  );
  await user.click(screen.getByRole("button", { name: "호기 번호" }));
  await screen.findByText("GTS25DE");
}

describe("financial purchase request workflow", () => {
  it("drives the request -> resolution -> execution chain", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    let current = purchase("STATEMENT_ATTACHED");

    server.use(
      lookupHandler(),
      http.post("*/api/v1/financial/purchase-requests", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(current, { status: 201 });
      }),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/submit",
        () => {
          current = purchase("REQUEST_SUBMITTED");
          return HttpResponse.json(current);
        },
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/approve-admin",
        () => {
          current = purchase("ADMIN_APPROVED");
          return HttpResponse.json(current);
        },
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/prepare-expenditure",
        () => {
          current = purchase("READY_TO_EXECUTE", { expenditure_no: "EXP-1" });
          return HttpResponse.json(current);
        },
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/execute",
        () => {
          current = purchase("EXECUTED", { expenditure_no: "EXP-1" });
          return HttpResponse.json(current);
        },
      ),
    );

    renderApp(makeAuthContext(adminSession));

    await user.click(await screen.findByRole("button", { name: "구매요청서 작성" }));
    await lookupEquipment(user);

    await user.type(screen.getByLabelText("거래처명"), "한빛부품");
    await user.type(screen.getByLabelText("금액 (원)"), "500000");
    await user.type(
      screen.getByLabelText("거래명세표 증빙 번호"),
      evidenceId,
    );
    await user.click(screen.getByRole("button", { name: "작성" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
          equipment_id: equipmentId,
          branch_id: branchId,
          vendor_name: "한빛부품",
          amount_won: 500000,
          statement_evidence_id: evidenceId,
        }),
      );
    });
    expect(await screen.findByText("구매요청서를 작성했습니다.")).toBeVisible();

    // STATEMENT_ATTACHED -> submit
    await user.click(await screen.findByRole("button", { name: "결재 상신" }));
    // REQUEST_SUBMITTED -> admin approve
    await user.click(await screen.findByRole("button", { name: "관리자 승인" }));
    // ADMIN_APPROVED -> prepare expenditure (dialog)
    await user.click(
      await screen.findByRole("button", { name: "지출결의 등록" }),
    );
    const expDialog = await screen.findByRole("dialog");
    await user.type(
      within(expDialog).getByLabelText("지출결의 번호"),
      "EXP-1",
    );
    await user.click(within(expDialog).getByRole("button", { name: "등록" }));

    // READY_TO_EXECUTE -> execute (confirm dialog)
    await user.click(await screen.findByRole("button", { name: "집행" }));
    const execDialog = await screen.findByRole("dialog");
    await user.click(within(execDialog).getByRole("button", { name: "집행" }));

    // Reaches EXECUTED: no further actions offered.
    expect(
      await screen.findByText("현재 단계에서 가능한 작업이 없습니다."),
    ).toBeVisible();
  });

  it("routes above-threshold requests through executive approval", async () => {
    const user = userEvent.setup();

    server.use(
      lookupHandler(),
      http.get(
        "*/api/v1/financial/purchase-requests/:id",
        () =>
          HttpResponse.json(
            purchase("EXECUTIVE_PENDING", { amount_won: 5_000_000 }),
          ),
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/approve-executive",
        () =>
          HttpResponse.json(
            purchase("READY_TO_EXECUTE", { amount_won: 5_000_000 }),
          ),
      ),
    );

    // Executive can final-approve but not execute.
    renderApp(makeAuthContext(session(["EXECUTIVE"])));

    await user.type(
      await screen.findByLabelText("구매요청서 번호로 불러오기"),
      purchaseId,
    );
    await user.click(screen.getByRole("button", { name: "불러오기" }));

    await user.click(
      await screen.findByRole("button", { name: "임원 최종 승인" }),
    );
    // Now READY_TO_EXECUTE; executive lacks PurchaseExecute, so no execute button.
    expect(
      await screen.findByText("현재 단계에서 가능한 작업이 없습니다."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "집행" }),
    ).not.toBeInTheDocument();
  });

  it("hides execute and approve controls from a role without the feature", async () => {
    const user = userEvent.setup();

    server.use(
      lookupHandler(),
      http.get("*/api/v1/financial/purchase-requests/:id", () =>
        HttpResponse.json(purchase("REQUEST_SUBMITTED")),
      ),
    );

    // Receptionist can create/submit but NOT approve. A submitted request has
    // only the admin-approve action, which the receptionist must not see.
    renderApp(makeAuthContext(receptionistSession));

    await user.type(
      await screen.findByLabelText("구매요청서 번호로 불러오기"),
      purchaseId,
    );
    await user.click(screen.getByRole("button", { name: "불러오기" }));

    expect(
      await screen.findByText("현재 단계에서 가능한 작업이 없습니다."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "관리자 승인" }),
    ).not.toBeInTheDocument();
  });

  it("hides the create button from a role without PurchaseRequestCreate (Allow)", async () => {
    server.use(lookupHandler());
    // Mechanic only has RequestOnly on PurchaseRequestCreate, so the create
    // button (which needs Allow) must not render.
    renderApp(makeAuthContext(mechanicSession));

    expect(
      await screen.findByRole("button", { name: "불러오기" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "구매요청서 작성" }),
    ).not.toBeInTheDocument();
  });
});

describe("rental quote", () => {
  it("creates a rental quote and renders the computed total", async () => {
    const user = userEvent.setup();
    const created = vi.fn();

    server.use(
      lookupHandler(),
      http.post("*/api/v1/financial/rental-quotes", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(quoteSummary, { status: 201 });
      }),
    );

    renderApp(makeAuthContext(adminSession));
    await user.click(await screen.findByRole("tab", { name: "임대 견적" }));
    await lookupEquipment(user);
    await user.click(screen.getByRole("button", { name: "견적 생성" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
          equipment_id: equipmentId,
          branch_id: branchId,
        }),
      );
    });
    expect(await screen.findByText("견적을 생성했습니다.")).toBeVisible();
    expect(screen.getAllByText(/650,000/).length).toBeGreaterThan(0);
    expect(screen.getByText("감가상각")).toBeVisible();
  });
});

describe("cost ledger", () => {
  it("renders ledger entries for the selected equipment", async () => {
    const user = userEvent.setup();

    server.use(
      lookupHandler(),
      http.get(
        "*/api/v1/financial/equipment/:id/cost-ledger",
        () => HttpResponse.json(ledgerEntries),
      ),
    );

    renderApp(makeAuthContext(adminSession));
    await user.click(await screen.findByRole("tab", { name: "원가 원장" }));
    await lookupEquipment(user);
    await user.click(screen.getByRole("button", { name: "원장 조회" }));

    expect(await screen.findByText("정기 부품 교체")).toBeVisible();
    expect(screen.getByText("구매 집행")).toBeVisible();
  });

  it("denies cost-ledger access to a role without EquipmentCostLedgerRead", async () => {
    const user = userEvent.setup();
    server.use(lookupHandler());

    // Receptionist lacks EquipmentCostLedgerRead; the panel renders no lookup.
    renderApp(makeAuthContext(receptionistSession));
    await user.click(await screen.findByRole("tab", { name: "원가 원장" }));

    expect(
      screen.queryByRole("button", { name: "원장 조회" }),
    ).not.toBeInTheDocument();
  });
});
