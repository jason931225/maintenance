import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../../api/client";
import { AuthContext, type AuthContextValue } from "../../../context/auth";
import type { components } from "@maintenance/api-client-ts";
import { PurchaseRequestsWorkspace } from "./PurchaseRequestsWorkspace";

const branchId = "00000000-0000-4000-8000-000000000001";
const requestId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

type PurchaseStatus = components["schemas"]["PurchaseStatus"];

function request(
  status: PurchaseStatus,
  extra: Partial<components["schemas"]["PurchaseRequestSummary"]> = {},
): components["schemas"]["PurchaseRequestSummary"] {
  return {
    id: requestId,
    branch_id: branchId,
    equipment_id: null,
    work_order_id: null,
    statement_evidence_id: null,
    purchase_type: "REGULAR",
    vendor_name: "한빛부품",
    amount_won: 500_000,
    status,
    requester: { user_id: "requester-1", display_name: "김요청" },
    lines: [{
      id: "line-1",
      line_no: 1,
      item: "유압 필터",
      quantity: 1,
      unit_supply_price_won: 454_545,
      vat_won: 45_455,
      vat_overridden: false,
      line_total_won: 500_000,
    }],
    quote_attachments: [],
    policy: {
      equipment_required: false,
      statement_evidence_required: false,
      price_anomaly: false,
      quote_update_required: false,
      submit_blocked: false,
      messages: [],
    },
    expenditure_no: null,
    rejection_memo: null,
    created_at: "2026-07-24T00:00:00Z",
    updated_at: "2026-07-24T00:00:00Z",
    ...extra,
  };
}

function renderWorkspace(
  roles: readonly string[],
  current: components["schemas"]["PurchaseRequestSummary"],
  post: (path: unknown, options?: unknown) => Promise<unknown> = () => Promise.resolve({ data: current }),
) {
  const api = createConsoleApiClient("purchase-workspace-test-token");
  const GET = vi.spyOn(api, "GET").mockImplementation((path: unknown) => {
    if (path === "/api/v1/financial/purchase-requests") {
      return Promise.resolve({ data: { items: [current], limit: 50, offset: 0, total: 1 } });
    }
    if (path === "/api/v1/financial/purchase-requests/preferences") return Promise.resolve({ data: undefined });
    return Promise.reject(new Error(`unexpected GET ${String(path)}`));
  });
  const POST = vi.spyOn(api, "POST").mockImplementation(post as never);
  const authValue = {
    session: {
      access_token: "purchase-workspace-test-token",
      user_id: "user-1",
      org_id: "org-1",
      branches: [branchId],
      roles: [...roles],
      feature_grants: [],
    },
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api,
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  } as unknown as AuthContextValue;

  return {
    api,
    authValue,
    GET,
    POST,
    ...render(
      <AuthContext.Provider value={authValue}>
        <PurchaseRequestsWorkspace api={api} roles={roles} />
      </AuthContext.Provider>,
    ),
  };
}

describe("PurchaseRequestsWorkspace", () => {
  it("renders the branch-scoped generated-client queue and submits the selected draft", async () => {
    const user = userEvent.setup();
    const submitted = request("REQUEST_SUBMITTED");
    const { GET, POST } = renderWorkspace(
      ["ADMIN"],
      request("STATEMENT_ATTACHED"),
      (path) => {
        if (path === "/api/v1/financial/purchase-requests/{purchaseRequestId}/submit") {
          return Promise.resolve({ data: submitted });
        }
        return Promise.reject(new Error(`unexpected POST ${String(path)}`));
      },
    );

    expect(await screen.findByRole("heading", { name: "구매요청서" })).toBeVisible();
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/financial/purchase-requests",
      expect.objectContaining({
        params: expect.objectContaining({ query: expect.objectContaining({ branch_id: branchId }) }),
      }),
    );

    await user.click(screen.getByRole("button", { name: /한빛부품/ }));
    await user.click(screen.getByRole("button", { name: "결재 상신" }));

    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith(
        "/api/v1/financial/purchase-requests/{purchaseRequestId}/submit",
        expect.objectContaining({ params: { path: { purchaseRequestId: requestId } } }),
      );
    });
  });

  it("omits an admin-only approval action for a receptionist even when the server-visible row is submitted", async () => {
    const user = userEvent.setup();
    renderWorkspace(["RECEPTIONIST"], request("REQUEST_SUBMITTED"));

    await user.click(await screen.findByRole("button", { name: /한빛부품/ }));
    expect(screen.queryByRole("button", { name: "관리자 승인" })).not.toBeInTheDocument();
  });

  it("retains the selected request and exposes a truthful mutation error when submit is rejected", async () => {
    const user = userEvent.setup();
    renderWorkspace(
      ["ADMIN"],
      request("STATEMENT_ATTACHED"),
      (path) => {
        if (path === "/api/v1/financial/purchase-requests/{purchaseRequestId}/submit") {
          return Promise.resolve({ data: undefined, error: { error: { message: "증빙 상태를 확인할 수 없습니다." } } });
        }
        return Promise.reject(new Error(`unexpected POST ${String(path)}`));
      },
    );

    await user.click(await screen.findByRole("button", { name: /한빛부품/ }));
    await user.click(screen.getByRole("button", { name: "결재 상신" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("증빙 상태를 확인할 수 없습니다.");
    expect(screen.getByRole("button", { name: /한빛부품/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "결재 상신" })).toBeVisible();
  });

  it("aborts an in-flight branch queue when its authenticated session is replaced", async () => {
    const replacementBranchId = "00000000-0000-4000-8000-000000000002";
    const signals: AbortSignal[] = [];
    const api = createConsoleApiClient("purchase-workspace-test-token");
    const GET = vi.spyOn(api, "GET").mockImplementation((path, options) => {
      if (path === "/api/v1/financial/purchase-requests") {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        if (!signal) return Promise.reject(new Error("queue signal missing"));
        signals.push(signal);
        if (signals.length === 1) {
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("request aborted", "AbortError"));
            }, { once: true });
          });
        }
        return Promise.resolve({ data: { items: [], limit: 50, offset: 0, total: 0 } });
      }
      if (path === "/api/v1/financial/purchase-requests/preferences") {
        return Promise.resolve({ data: undefined });
      }
      return Promise.reject(new Error(`unexpected GET ${String(path)}`));
    });
    const authValue = {
      session: {
        access_token: "purchase-workspace-test-token",
        user_id: "user-1",
        org_id: "org-1",
        branches: [branchId],
        roles: ["ADMIN"],
        feature_grants: [],
      },
      restoring: false,
      login: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
      acceptTokens: vi.fn(),
      clearPasskeySetup: vi.fn(),
      api,
      viewAs: undefined,
      enterViewAs: vi.fn(),
      exitViewAs: vi.fn(),
    } as unknown as AuthContextValue;
    const { rerender } = render(
      <AuthContext.Provider value={authValue}>
        <PurchaseRequestsWorkspace api={api} roles={["ADMIN"]} />
      </AuthContext.Provider>,
    );

    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    const initialSession = authValue.session;
    if (!initialSession) throw new Error("test session missing");
    rerender(
      <AuthContext.Provider value={{
        ...authValue,
        session: { ...initialSession, branches: [replacementBranchId] },
      }}>
        <PurchaseRequestsWorkspace api={api} roles={["ADMIN"]} />
      </AuthContext.Provider>,
    );

    await waitFor(() => {
      expect(signals[0]?.aborted).toBe(true);
    });
    await waitFor(() => {
      expect(signals).toHaveLength(2);
    });
    expect(GET).toHaveBeenLastCalledWith(
      "/api/v1/financial/purchase-requests",
      expect.objectContaining({
        params: expect.objectContaining({
          query: expect.objectContaining({ branch_id: replacementBranchId }),
        }),
        signal: signals[1],
      }),
    );
  });

  it("aborts an in-flight lifecycle mutation when its authenticated session is replaced", async () => {
    const user = userEvent.setup();
    let mutationSignal: AbortSignal | undefined;
    const { api, authValue, rerender } = renderWorkspace(
      ["ADMIN"],
      request("STATEMENT_ATTACHED"),
      (_path, options) => {
        mutationSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
        return new Promise((_, reject) => {
          mutationSignal?.addEventListener("abort", () => {
            reject(new DOMException("request aborted", "AbortError"));
          }, { once: true });
        });
      },
    );

    await user.click(await screen.findByRole("button", { name: /한빛부품/ }));
    await user.click(screen.getByRole("button", { name: "결재 상신" }));
    await waitFor(() => {
      expect(mutationSignal).toBeDefined();
    });
    const initialSession = authValue.session;
    if (!initialSession) throw new Error("test session missing");

    rerender(
      <AuthContext.Provider value={{
        ...authValue,
        session: {
          ...initialSession,
          access_token: "replacement-session-token",
          branches: ["00000000-0000-4000-8000-000000000002"],
        },
      }}>
        <PurchaseRequestsWorkspace api={api} roles={["ADMIN"]} />
      </AuthContext.Provider>,
    );

    await waitFor(() => {
      expect(mutationSignal?.aborted).toBe(true);
    });
  });
});
