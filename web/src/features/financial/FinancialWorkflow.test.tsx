import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { FinancialPage } from "../../pages/FinancialPage";
import type { components } from "@maintenance/api-client-ts";
import { branchId } from "../../test/fixtures";
import { waitForRouteReady } from "../../test/routeReady";

const mockStepUpAssertion = {
  ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credential: { id: "passkey-assertion" },
};
const mockAssertPasskeyStepUp = vi.hoisted(() => vi.fn());

vi.mock("../../auth/webauthn", () => {
  class MockOtpRedeemError extends Error {
    readonly status: number | undefined;
    constructor(status: number | undefined) {
      super(`OTP redeem failed with status ${String(status)}`);
      this.name = "OtpRedeemError";
      this.status = status;
    }
  }
  class MockSignupError extends Error {
    readonly status: number | undefined;
    constructor(status: number | undefined) {
      super(`signup failed with status ${String(status)}`);
      this.name = "SignupError";
      this.status = status;
    }
  }
  return {
    OtpRedeemError: MockOtpRedeemError,
    SignupError: MockSignupError,
    acceptPrivacyConsent: vi.fn(),
    approveDeviceLoginSession: vi.fn(),
    approveDeviceLoginWithPasskey: vi.fn(),
    assertPasskeyStepUp: mockAssertPasskeyStepUp,
    finishPasskeyLogin: vi.fn(),
    finishPasskeyRegistration: vi.fn(),
    getPrivacyConsentStatus: vi.fn(),
    issueAdminOtp: vi.fn(),
    issueEnrollHandoff: vi.fn(),
    logout: vi.fn(),
    pollDeviceLogin: vi.fn(),
    redeemOtp: vi.fn(),
    refreshToken: vi.fn(),
    resetUserCredentials: vi.fn(),
    signupOpen: vi.fn(),
    startDeviceLogin: vi.fn(),
    startPasskeyLogin: vi.fn(),
    startPasskeyRegistration: vi.fn(),
  };
});

const server = setupServer();

vi.setConfig({ testTimeout: 20_000 });

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
beforeEach(() => {
  mockAssertPasskeyStepUp.mockResolvedValue(mockStepUpAssertion);
  // Every FinancialPage mount reads the authenticated branch queue. Individual
  // scenarios register a later handler when the queue itself is under test;
  // direct lookup/create/action cases still need this truthful baseline.
  server.use(
    http.get("*/api/v1/financial/purchase-requests", () =>
      HttpResponse.json(purchaseQueue([purchase("STATEMENT_ATTACHED")])),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  mockAssertPasskeyStepUp.mockReset();
});
afterAll(() => {
  server.close();
});

const equipmentId = "44444444-4444-4444-8444-444444444444";
const purchaseId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const quoteId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const evidenceId = "cccccccc-3333-4333-8333-cccccccccccc";
const quoteAttachmentId = "99999999-9999-4999-8999-999999999999";
const knlOrgId = "00000000-0000-0000-0000-0000000000a1";
const nonKnlOrgId = "33333333-3333-3333-3333-333333333333";

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
  maker: "현대",
  vin: null,
  vehicle_registration_no: null,
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
    work_order_id: null,
    statement_evidence_id: evidenceId,
    purchase_type: "REGULAR",
    vendor_name: "한빛부품",
    amount_won: 500_000,
    status,
    requester: {
      user_id: "user-1",
      display_name: "김요청",
    },
    lines: [
      {
        id: "line-1",
        line_no: 1,
        item: "유압 필터",
        quantity: 2,
        unit_supply_price_won: 200_000,
        vat_won: 40_000,
        vat_overridden: false,
        line_total_won: 440_000,
      },
      {
        id: "line-2",
        line_no: 2,
        item: "배송비",
        quantity: 1,
        unit_supply_price_won: 55_000,
        vat_won: 5_000,
        vat_overridden: true,
        line_total_won: 60_000,
      },
    ],
    quote_attachments: [
      {
        id: quoteAttachmentId,
        file_name: "hanbit-quote.pdf",
        content_type: "application/pdf",
        size_bytes: 2048,
        role: "QUOTE",
        download_url: `/api/v1/financial/purchase-requests/${purchaseId}/attachments/${quoteAttachmentId}/download`,
        created_at: "2026-06-16T00:00:00Z",
      },
    ],
    policy: {
      equipment_required: false,
      statement_evidence_required: false,
      price_anomaly: false,
      quote_update_required: false,
      submit_blocked: false,
      messages: [],
    },
    created_at: "2026-06-16T00:00:00Z",
    updated_at: "2026-06-16T00:00:00Z",
    ...extra,
  };
}

function purchaseQueue(
  items: components["schemas"]["PurchaseRequestSummary"][],
  offset = 0,
) {
  return {
    items,
    limit: 50,
    offset,
    total: items.length,
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

function evidenceStatusHandler(thumbnailUrl = "https://example.test/statement.jpg") {
  return http.get("*/api/v1/evidence/:evidenceId/status", () =>
    HttpResponse.json({
      id: evidenceId,
      processing_status: "READY",
      content_type: "image/jpeg",
      thumbnail_url: thumbnailUrl,
    }),
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
        <FinancialPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

async function renderFinancialApp(ctx: AuthContextValue) {
  renderApp(ctx);
  await waitForRouteReady("구매·정산");
}

function session(roles: string[], orgId = knlOrgId): AuthSession {
  return {
    access_token: roles.join("-").toLowerCase(),
    user_id: "user-1",
    roles,
    branches: [branchId],
    org_id: orgId,
  };
}

const adminSession = session(["ADMIN"]);
const receptionistSession = session(["RECEPTIONIST"]);
const mechanicSession = session(["MECHANIC"]);

async function lookupEquipment(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.queryByLabelText("호기 연결 구매");
  if (toggle && !toggle.matches(":checked")) {
    await user.click(toggle);
  }
  changeInput(await screen.findByLabelText("호기 번호", { exact: true }), "290");
  await user.click(screen.getByRole("button", { name: "호기 번호" }));
  await screen.findByText("GTS25DE");
}

function changeInput(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}

function fillPurchaseLine(
  item = "유압 필터",
  quantity = "1",
  unitPrice = "454546",
) {
  changeInput(screen.getByLabelText("품목 1"), item);
  changeInput(screen.getByLabelText("수량 1"), quantity);
  changeInput(screen.getByLabelText("공급가액(단가) 1"), unitPrice);
}

function purchaseStatusFilter() {
  return within(screen.getByRole("region", { name: "상태" })).getByRole(
    "combobox",
    { name: "상태" },
  );
}

describe("financial purchase request workflow", () => {
  it("loads the authenticated branch queue and sends a repeated status filter", async () => {
    const seenQueries: URLSearchParams[] = [];
    server.use(
      http.get("*/api/v1/financial/purchase-requests", ({ request }) => {
        seenQueries.push(new URL(request.url).searchParams);
        return HttpResponse.json(purchaseQueue([purchase("REQUEST_SUBMITTED")]));
      }),
    );

    await renderFinancialApp(makeAuthContext(adminSession));

    expect((await screen.findAllByText("한빛부품"))[0]).toBeVisible();
    fireEvent.change(purchaseStatusFilter(), { target: { value: "REQUEST_SUBMITTED" } });

    await waitFor(() => {
      expect(seenQueries.length).toBeGreaterThanOrEqual(2);
    });
    expect(seenQueries[0]?.get("branch_id")).toBe(branchId);
    expect(seenQueries[0]?.get("limit")).toBe("50");
    expect(seenQueries[0]?.get("offset")).toBe("0");
    expect(seenQueries.at(-1)?.getAll("status")).toEqual(["REQUEST_SUBMITTED"]);
  });

  it("fences a stale queue response after the status filter changes", async () => {
    let releaseInitial: (() => void) | undefined;
    const initial = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    server.use(
      http.get("*/api/v1/financial/purchase-requests", async ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        if (status === "REQUEST_SUBMITTED") {
          return HttpResponse.json(
            purchaseQueue([purchase("REQUEST_SUBMITTED", { vendor_name: "필터 결과" })]),
          );
        }
        await initial;
        return HttpResponse.json(
          purchaseQueue([purchase("EXECUTED", { vendor_name: "오래된 결과" })]),
        );
      }),
    );

    await renderFinancialApp(makeAuthContext(adminSession));
    fireEvent.change(purchaseStatusFilter(), { target: { value: "REQUEST_SUBMITTED" } });
    expect((await screen.findAllByText("필터 결과"))[0]).toBeVisible();
    releaseInitial?.();
    await waitFor(() => {
      expect(screen.queryByText("오래된 결과")).not.toBeInTheDocument();
    });
  });

  it("loads later queue pages without losing the selected request", async () => {
    const user = userEvent.setup();
    const first = purchase("STATEMENT_ATTACHED", { vendor_name: "첫 요청" });
    const second = purchase("REQUEST_SUBMITTED", {
      id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
      vendor_name: "다음 요청",
    });
    const requestedOffsets: number[] = [];
    const firstPage = [
      first,
      ...Array.from({ length: 49 }, (_, index) =>
        purchase("STATEMENT_ATTACHED", {
          id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          vendor_name: `첫 페이지 ${String(index + 2)}`,
        }),
      ),
    ];
    server.use(
      http.get("*/api/v1/financial/purchase-requests", ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
        requestedOffsets.push(offset);
        return HttpResponse.json(
          offset === 0
            ? { items: firstPage, limit: 50, offset: 0, total: 51 }
            : { items: [second], limit: 50, offset: 50, total: 51 },
        );
      }),
    );

    await renderFinancialApp(makeAuthContext(adminSession));
    const firstRow = await screen.findByRole("button", { name: /첫 요청/ });
    await user.click(firstRow);
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    expect((await screen.findAllByText("다음 요청"))[0]).toBeVisible();
    expect(requestedOffsets).toEqual([0, 50]);
    expect(screen.getByRole("button", { name: /첫 요청/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows a truthful denied state and allows transient queue failures to retry", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    server.use(
      http.get("*/api/v1/financial/purchase-requests", () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json({ error: { code: "forbidden" } }, { status: 403 })
          : HttpResponse.json(purchaseQueue([purchase("STATEMENT_ATTACHED")]));
      }),
    );
    await renderFinancialApp(makeAuthContext(adminSession));
    expect(await screen.findByText("이 페이지에 접근할 권한이 없습니다.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();

    server.use(
      http.get("*/api/v1/financial/purchase-requests", () => {
        attempts += 1;
        return attempts === 2
          ? HttpResponse.json({ error: { code: "unavailable" } }, { status: 503 })
          : HttpResponse.json(purchaseQueue([purchase("STATEMENT_ATTACHED")]));
      }),
    );
    fireEvent.change(purchaseStatusFilter(), { target: { value: "STATEMENT_ATTACHED" } });
    expect(await screen.findByText("데이터를 불러오지 못했습니다.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect((await screen.findAllByText("한빛부품"))[0]).toBeVisible();
  });

  it("drops a delayed create completion after the queue context changes", async () => {
    const user = userEvent.setup();
    let releaseCreate: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    server.use(
      lookupHandler(),
      evidenceStatusHandler(),
      http.get("*/api/v1/financial/purchase-requests", ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        return HttpResponse.json(
          purchaseQueue(
            status === "REQUEST_SUBMITTED"
              ? [purchase("REQUEST_SUBMITTED", { vendor_name: "필터 기준" })]
              : [],
          ),
        );
      }),
      http.post("*/api/v1/financial/purchase-requests", async () => {
        await createStarted;
        return HttpResponse.json(purchase("STATEMENT_ATTACHED"), { status: 201 });
      }),
    );

    await renderFinancialApp(makeAuthContext(adminSession));
    await user.click(await screen.findByRole("button", { name: "구매요청서 작성" }));
    await lookupEquipment(user);
    changeInput(screen.getByLabelText("거래처명"), "한빛부품");
    fillPurchaseLine();
    changeInput(screen.getByLabelText("거래명세표 증빙 번호"), evidenceId);
    changeInput(screen.getByLabelText("비고"), "정기 부품 교체");
    await user.click(screen.getByRole("button", { name: "작성" }));

    fireEvent.change(purchaseStatusFilter(), { target: { value: "REQUEST_SUBMITTED" } });
    expect((await screen.findAllByText("필터 기준"))[0]).toBeVisible();
    releaseCreate?.();
    await waitFor(() => {
      expect(screen.queryByText("구매요청서를 작성했습니다.")).not.toBeInTheDocument();
    });
  });

  it("drops a delayed status action after the queue context changes", async () => {
    const user = userEvent.setup();
    const original = purchase("STATEMENT_ATTACHED", { vendor_name: "원래 요청" });
    const filtered = purchase("EXECUTED", { vendor_name: "필터 기준" });
    let releaseSubmit: (() => void) | undefined;
    const submitStarted = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    server.use(
      http.get("*/api/v1/financial/purchase-requests", ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        return HttpResponse.json(purchaseQueue(status === "EXECUTED" ? [filtered] : [original]));
      }),
      http.post("*/api/v1/financial/purchase-requests/:id/submit", async () => {
        await submitStarted;
        return HttpResponse.json(purchase("REQUEST_SUBMITTED", { vendor_name: "원래 요청" }));
      }),
    );

    await renderFinancialApp(makeAuthContext(adminSession));
    await user.click(await screen.findByRole("button", { name: "결재 상신" }));
    fireEvent.change(purchaseStatusFilter(), { target: { value: "EXECUTED" } });
    expect((await screen.findAllByText("필터 기준"))[0]).toBeVisible();
    releaseSubmit?.();
    await waitFor(() => {
      expect(screen.queryAllByText("원래 요청")).toHaveLength(0);
    });
  });

  it("drives the request -> resolution -> execution chain", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    const adminApproved = vi.fn();
    const expenditurePrepared = vi.fn();
    const executed = vi.fn();
    const queueRequests = vi.fn();
    let current = purchase("STATEMENT_ATTACHED");

    server.use(
      lookupHandler(),
      evidenceStatusHandler(),
      http.get("*/api/v1/financial/purchase-requests", () => {
        queueRequests();
        return HttpResponse.json(purchaseQueue([current]));
      }),
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
        async ({ request }) => {
          adminApproved(await request.json());
          current = purchase("ADMIN_APPROVED");
          return HttpResponse.json(current);
        },
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/prepare-expenditure",
        async ({ request }) => {
          expenditurePrepared(await request.json());
          current = purchase("READY_TO_EXECUTE", { expenditure_no: "EXP-1" });
          return HttpResponse.json(current);
        },
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/execute",
        async ({ request }) => {
          executed(await request.json());
          current = purchase("EXECUTED", { expenditure_no: "EXP-1" });
          return HttpResponse.json(current);
        },
      ),
    );

    await renderFinancialApp(makeAuthContext(adminSession));

    await user.click(
      await screen.findByRole(
        "button",
        { name: "구매요청서 작성" },
        { timeout: 5_000 },
      ),
    );
    await lookupEquipment(user);

    changeInput(screen.getByLabelText("거래처명"), "한빛부품");
    fillPurchaseLine();
    changeInput(screen.getByLabelText("거래명세표 증빙 번호"), evidenceId);
    changeInput(screen.getByLabelText("비고"), "정기 부품 교체");
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
    await waitFor(() => {
      expect(queueRequests.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const statementThumb = await screen.findByAltText("거래명세표 사진 미리보기");
    expect(statementThumb).toHaveAttribute("src", "https://example.test/statement.jpg");

    // STATEMENT_ATTACHED -> submit
    await user.click(await screen.findByRole("button", { name: "결재 상신" }));
    await waitFor(() => {
      expect(queueRequests.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    // REQUEST_SUBMITTED -> admin approve
    await user.click(await screen.findByRole("button", { name: "관리자 승인" }));
    // ADMIN_APPROVED -> prepare expenditure (dialog)
    await user.click(
      await screen.findByRole("button", { name: "지출결의 등록" }),
    );
    const expDialog = await screen.findByRole("dialog");
    changeInput(within(expDialog).getByLabelText("지출결의 번호"), "EXP-1");
    await user.click(within(expDialog).getByRole("button", { name: "등록" }));

    // READY_TO_EXECUTE -> execute (confirm dialog)
    await user.click(await screen.findByRole("button", { name: "집행" }));
    const execDialog = await screen.findByRole("dialog");
    await user.click(within(execDialog).getByRole("button", { name: "집행" }));

    // Reaches EXECUTED: no further actions offered.
    expect(
      await screen.findByText("현재 단계에서 가능한 작업이 없습니다."),
    ).toBeVisible();
    expect(mockAssertPasskeyStepUp).toHaveBeenCalledTimes(3);
    expect(adminApproved).toHaveBeenCalledWith({ step_up: mockStepUpAssertion });
    expect(expenditurePrepared).toHaveBeenCalledWith({
      expenditure_no: "EXP-1",
      step_up: mockStepUpAssertion,
    });
    expect(executed).toHaveBeenCalledWith({ step_up: mockStepUpAssertion });
  });

  it("keeps the mature purchase intake compact with lines, quotes, policy, requester, and preferences", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    const savedPreferences = vi.fn();
    const current = purchase("STATEMENT_ATTACHED", {
      equipment_id: null,
      statement_evidence_id: null,
      purchase_type: "OTHER",
      requester: {
        user_id: "user-1",
        display_name: "김요청",
      },
      policy: {
        equipment_required: false,
        statement_evidence_required: false,
        price_anomaly: true,
        quote_update_required: true,
        submit_blocked: true,
        messages: [
          "기존 정기구매 단가와 1원 이상 차이가 있어 견적서 업데이트가 필요합니다.",
        ],
      },
    });

    server.use(
      http.get("*/api/v1/financial/purchase-requests", () =>
        HttpResponse.json(purchaseQueue([current])),
      ),
      http.get("*/api/v1/financial/purchase-requests/preferences", () =>
        HttpResponse.json({
          feature_key: "purchase_requests",
          schema_version: 1,
          preferences: {
            density: "compact",
            sidebar_collapsed: false,
            line_columns: [
              "item",
              "quantity",
              "unit_supply_price_won",
              "vat_won",
              "line_total_won",
            ],
          },
        }),
      ),
      http.put(
        "*/api/v1/financial/purchase-requests/preferences",
        async ({ request }) => {
          const body = await request.json();
          savedPreferences(body);
          return HttpResponse.json({
            feature_key: "purchase_requests",
            schema_version: 1,
            preferences: body,
          });
        },
      ),
      http.post("*/api/v1/financial/purchase-requests/attachments/presign", () =>
        HttpResponse.json({
          attachment_id: quoteAttachmentId,
          upload: {
            method: "PUT",
            url: "https://storage.example/upload/quote",
            headers: [["content-type", "application/pdf"]],
            expires_in_secs: 900,
          },
          file_name: "hanbit-quote.pdf",
          content_type: "application/pdf",
          size_bytes: 2048,
          role: "QUOTE",
          upload_state: "PENDING",
        }),
      ),
      http.put("https://storage.example/upload/quote", () => new Response(null, { status: 200 })),
      http.post("*/api/v1/financial/purchase-requests/attachments/:id/confirm", () =>
        HttpResponse.json({
          id: quoteAttachmentId,
          branch_id: branchId,
          file_name: "hanbit-quote.pdf",
          content_type: "application/pdf",
          size_bytes: 2048,
          role: "QUOTE",
          upload_state: "CONFIRMED",
          created_at: "2026-06-16T00:00:00Z",
        }),
      ),
      http.post("*/api/v1/financial/purchase-requests", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(current, { status: 201 });
      }),
    );

    await renderFinancialApp(makeAuthContext(session(["ADMIN"], nonKnlOrgId)));

    await user.click(await screen.findByRole("button", { name: "구매요청서 작성" }));

    const intake = await screen.findByRole("form", { name: "구매요청 작성" });
    expect(within(intake).getByLabelText("거래처명")).toBeVisible();
    expect(within(intake).getByLabelText("구매유형")).toBeVisible();
    expect(within(intake).getByText("현재 사용자")).toBeVisible();
    expect(within(intake).getByText("정책 체크")).toBeVisible();
    expect(within(intake).getByRole("table")).toBeVisible();
    expect(within(intake).getByLabelText("품목 1")).toBeVisible();
    expect(within(intake).getByLabelText("수량 1")).toBeVisible();
    expect(within(intake).getByLabelText("공급가액(단가) 1")).toBeVisible();
    expect(within(intake).getByLabelText("부가세 1")).toHaveValue("0");
    expect(within(intake).getByText("견적서")).toBeVisible();
    expect(within(intake).getByText("작성 → 결재 상신 → 관리자 승인 → 지출결의 → 집행")).toBeVisible();

    const layout = screen.getByTestId("purchase-request-compact-layout");
    expect(layout).toHaveClass("gap-3");
    expect(layout).toHaveClass("lg:grid-cols-[minmax(0,1fr)_22rem]");

    await user.selectOptions(within(intake).getByLabelText("구매유형"), "OTHER");
    changeInput(within(intake).getByLabelText("거래처명"), "비장비 공급사");
    expect(within(intake).queryByText("등록 거래처 후보와 일치합니다.")).not.toBeInTheDocument();
    changeInput(within(intake).getByLabelText("품목 1"), "사무실 소모품");
    changeInput(within(intake).getByLabelText("수량 1"), "2");
    changeInput(within(intake).getByLabelText("공급가액(단가) 1"), "100000");
    expect(within(intake).getByLabelText("부가세 1")).toHaveValue("20000");
    expect(within(intake).getByText("220,000 원")).toBeVisible();

    await user.click(within(intake).getByRole("button", { name: "레이아웃 저장" }));
    await waitFor(() => {
      expect(savedPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ preferences: expect.objectContaining({ density: "compact" }) }),
      );
    });

    await user.upload(within(intake).getByLabelText("견적서 업로드"), new File(["quote"], "hanbit-quote.pdf", { type: "application/pdf" }));
    changeInput(within(intake).getByLabelText("비고"), "장비와 무관한 운영 구매");
    await user.click(within(intake).getByRole("button", { name: "작성" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
          equipment_id: null,
          statement_evidence_id: null,
          purchase_type: "OTHER",
          vendor_name: "비장비 공급사",
          amount_won: 220000,
          quote_attachment_ids: [quoteAttachmentId],
          lines: [
            expect.objectContaining({
              item: "사무실 소모품",
              quantity: 2,
              unit_supply_price_won: 100000,
              vat_won: null,
            }),
          ],
        }),
      );
    });

    expect(await screen.findByText("요청자")).toBeVisible();
    expect(screen.getByText("김요청")).toBeVisible();
    expect(screen.getByText("hanbit-quote.pdf")).toBeVisible();
    expect(screen.getAllByText(/견적서 업데이트가 필요/)[0]).toBeVisible();
  });
  it("hides KNL-only equipment fields for non-KNL purchase requests", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    const current = purchase("STATEMENT_ATTACHED", {
      equipment_id: null,
      statement_evidence_id: null,
      requester: {
        user_id: "user-1",
        display_name: "김요청",
      },
      policy: {
        equipment_required: false,
        statement_evidence_required: false,
        price_anomaly: false,
        quote_update_required: false,
        submit_blocked: false,
        messages: [],
      },
    });

    server.use(
      http.post("*/api/v1/financial/purchase-requests", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(current, { status: 201 });
      }),
    );

    await renderFinancialApp(makeAuthContext(session(["ADMIN"], nonKnlOrgId)));
    await user.click(await screen.findByRole("button", { name: "구매요청서 작성" }));

    const intake = await screen.findByRole("form", { name: "구매요청 작성" });
    expect(within(intake).queryByLabelText("호기 연결 구매")).not.toBeInTheDocument();
    expect(within(intake).queryByLabelText("호기 번호")).not.toBeInTheDocument();

    changeInput(within(intake).getByLabelText("거래처명"), "비장비 공급사");
    changeInput(within(intake).getByLabelText("품목 1"), "사무실 소모품");
    changeInput(within(intake).getByLabelText("공급가액(단가) 1"), "100000");
    changeInput(within(intake).getByLabelText("비고"), "호기 없는 타 법인 구매");
    await user.click(within(intake).getByRole("button", { name: "작성" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: branchId,
          equipment_id: null,
          statement_evidence_id: null,
          amount_won: 110000,
          lines: [
            expect.objectContaining({
              item: "사무실 소모품",
              quantity: 1,
              unit_supply_price_won: 100000,
              vat_won: null,
            }),
          ],
        }),
      );
    });
  });

  it("routes above-threshold requests through executive approval", async () => {
    const user = userEvent.setup();
    const executiveApproved = vi.fn();

    server.use(
      lookupHandler(),
      evidenceStatusHandler("https://example.test/executive-statement.jpg"),
      http.get(
        "*/api/v1/financial/purchase-requests/:id",
        () =>
          HttpResponse.json(
            purchase("EXECUTIVE_PENDING", { amount_won: 5_000_000 }),
          ),
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/approve-executive",
        async ({ request }) => {
          executiveApproved(await request.json());
          return HttpResponse.json(
            purchase("READY_TO_EXECUTE", { amount_won: 5_000_000 }),
          );
        },
      ),
    );

    // Executive can final-approve but not execute.
    await renderFinancialApp(makeAuthContext(session(["EXECUTIVE"])));

    changeInput(await screen.findByLabelText("구매요청서 번호로 불러오기"), purchaseId);
    await user.click(screen.getByRole("button", { name: "불러오기" }));

    const statementThumb = await screen.findByAltText("거래명세표 사진 미리보기");
    expect(statementThumb).toHaveAttribute(
      "src",
      "https://example.test/executive-statement.jpg",
    );

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
    expect(mockAssertPasskeyStepUp).toHaveBeenCalledOnce();
    expect(executiveApproved).toHaveBeenCalledWith({
      step_up: mockStepUpAssertion,
    });
  });

  it("sends passkey proof when rejecting a submitted purchase request", async () => {
    const user = userEvent.setup();
    const rejected = vi.fn();

    server.use(
      http.get("*/api/v1/financial/purchase-requests/:id", () =>
        HttpResponse.json(purchase("REQUEST_SUBMITTED")),
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/reject",
        async ({ request }) => {
          rejected(await request.json());
          return HttpResponse.json(purchase("REJECTED", { rejection_memo: "예산 초과" }));
        },
      ),
    );

    renderApp(makeAuthContext(adminSession));

    changeInput(await screen.findByLabelText("구매요청서 번호로 불러오기"), purchaseId);
    await user.click(screen.getByRole("button", { name: "불러오기" }));
    await user.click(await screen.findByRole("button", { name: "반려" }));
    const rejectDialog = await screen.findByRole("dialog");
    changeInput(within(rejectDialog).getByLabelText("반려 사유"), "예산 초과");
    await user.click(within(rejectDialog).getByRole("button", { name: "반려" }));

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledOnce();
      expect(rejected).toHaveBeenCalledWith({
        memo: "예산 초과",
        step_up: mockStepUpAssertion,
      });
    });
  });

  it("does not send a sensitive purchase action after cancelled passkey step-up", async () => {
    const user = userEvent.setup();
    const adminApproved = vi.fn();
    const cancelled = Object.assign(new Error("cancelled by user"), {
      name: "NotAllowedError",
    });
    mockAssertPasskeyStepUp.mockRejectedValueOnce(cancelled);

    server.use(
      http.get("*/api/v1/financial/purchase-requests/:id", () =>
        HttpResponse.json(purchase("REQUEST_SUBMITTED")),
      ),
      http.post(
        "*/api/v1/financial/purchase-requests/:id/approve-admin",
        async ({ request }) => {
          adminApproved(await request.json());
          return HttpResponse.json(purchase("ADMIN_APPROVED"));
        },
      ),
    );

    renderApp(makeAuthContext(adminSession));

    changeInput(await screen.findByLabelText("구매요청서 번호로 불러오기"), purchaseId);
    await user.click(screen.getByRole("button", { name: "불러오기" }));
    await user.click(await screen.findByRole("button", { name: "관리자 승인" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "패스키 승인이 취소되어 요청을 보내지 않았습니다.",
    );
    expect(adminApproved).not.toHaveBeenCalled();
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
    await renderFinancialApp(makeAuthContext(receptionistSession));

    changeInput(await screen.findByLabelText("구매요청서 번호로 불러오기"), purchaseId);
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
    await renderFinancialApp(makeAuthContext(mechanicSession));

    expect(
      await screen.findByRole("button", { name: "불러오기" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "구매요청서 작성" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the server's reason when a create is rejected (no silent failure)", async () => {
    const user = userEvent.setup();
    const serverReason = "거래명세표 증빙을 찾을 수 없습니다.";

    server.use(
      lookupHandler(),
      // The create rejects with a 4xx carrying the real reason. Before #19.18
      // the panel's catch{} discarded response.error and the operator saw a
      // generic "won't create"; the fix must render this exact message.
      http.post("*/api/v1/financial/purchase-requests", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: serverReason } },
          { status: 404 },
        ),
      ),
    );

    await renderFinancialApp(makeAuthContext(adminSession));

    await user.click(await screen.findByRole("button", { name: "구매요청서 작성" }));
    await lookupEquipment(user);
    changeInput(screen.getByLabelText("거래처명"), "한빛부품");
    fillPurchaseLine();
    changeInput(screen.getByLabelText("거래명세표 증빙 번호"), evidenceId);
    changeInput(screen.getByLabelText("비고"), "정기 부품 교체");
    await user.click(screen.getByRole("button", { name: "작성" }));

    // The server's actual reason renders in an alert, not a generic failure.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(serverReason);
    expect(alert).not.toHaveTextContent("구매요청서를 작성하지 못했습니다.");
  });

  it("surfaces the server's reason when a submit is rejected (no silent failure)", async () => {
    const user = userEvent.setup();
    const serverReason =
      "거래명세표가 아직 보존 검증 중입니다. 잠시 후 다시 상신하세요.";

    server.use(
      lookupHandler(),
      http.post("*/api/v1/financial/purchase-requests", () =>
        HttpResponse.json(purchase("STATEMENT_ATTACHED"), { status: 201 }),
      ),
      // Submit rejects with WORM-pending reason — before the fix runAction's
      // catch{} always rendered the generic submitFailed; the fix must surface
      // this exact server message.
      http.post("*/api/v1/financial/purchase-requests/:id/submit", () =>
        HttpResponse.json(
          {
            error: {
              code: "conflict",
              message: serverReason,
            },
          },
          { status: 409 },
        ),
      ),
    );

    await renderFinancialApp(makeAuthContext(adminSession));

    // Create a request first so the submit button appears.
    await user.click(await screen.findByRole("button", { name: "구매요청서 작성" }));
    await lookupEquipment(user);
    changeInput(screen.getByLabelText("거래처명"), "한빛부품");
    fillPurchaseLine();
    changeInput(screen.getByLabelText("거래명세표 증빙 번호"), evidenceId);
    changeInput(screen.getByLabelText("비고"), "정기 부품 교체");
    await user.click(screen.getByRole("button", { name: "작성" }));

    // Submit the request.
    await user.click(await screen.findByRole("button", { name: "결재 상신" }));

    // The server's actual reason renders in an alert, not the generic failure.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(serverReason);
    expect(alert).not.toHaveTextContent("결재 상신에 실패했습니다.");
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

    await renderFinancialApp(makeAuthContext(adminSession));
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

    await renderFinancialApp(makeAuthContext(adminSession));
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
    await renderFinancialApp(makeAuthContext(receptionistSession));
    await user.click(await screen.findByRole("tab", { name: "원가 원장" }));

    expect(
      screen.queryByRole("button", { name: "원장 조회" }),
    ).not.toBeInTheDocument();
  });
});
