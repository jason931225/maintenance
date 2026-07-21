import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { ConsoleRolloutBoundary } from "./ConsoleRolloutBoundary";

const rollout = {
  flag_key: "console_carbon_copy",
  org_enabled: true,
  org_rollout_enabled: true,
  user_opted_in: true,
  legacy_kill_switch_enabled: false,
  kill_switch_active: false,
  effective_new_console: true,
  effective_route: "new_console",
  effective_route_for_opted_in_user: "new_console",
  effective_route_for_opted_out_user: "legacy",
  overrides_individual_toggles: false,
} as const;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderBoundary(get: ConsoleApiClient["GET"], approved = ["overview"] as const) {
  const api = { GET: get } as ConsoleApiClient;
  return render(
    <MemoryRouter initialEntries={["/console/overview"]}>
      <AuthTestProvider
        session={{ access_token: "token", roles: ["ADMIN"], org_id: "org-1" }}
        overrides={{ api }}
      >
        <Routes>
          <Route
            path="/console/*"
            element={
              <ConsoleRolloutBoundary approvedScreenKeys={approved}>
                <div data-testid="new-console">new console</div>
              </ConsoleRolloutBoundary>
            }
          />
          <Route path="/overview" element={<div>legacy overview</div>} />
        </Routes>
        <LocationProbe />
      </AuthTestProvider>
    </MemoryRouter>,
  );
}

describe("ConsoleRolloutBoundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flash the console while the server decision is loading", async () => {
    let resolve!: (value: { data: typeof rollout }) => void;
    const pending = new Promise<{ data: typeof rollout }>((next) => {
      resolve = next;
    });
    renderBoundary(vi.fn(() => pending) as ConsoleApiClient["GET"]);

    expect(screen.queryByTestId("new-console")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "새 콘솔 사용 가능 여부 확인 중" })).toBeVisible();
    expect(document.querySelector(".console")).toBeNull();
    resolve({ data: rollout });
    expect(await screen.findByTestId("new-console")).toBeInTheDocument();
  });

  it("keeps an allowed console mounted after the request timeout window passes", async () => {
    vi.useFakeTimers();
    renderBoundary(
      vi.fn().mockResolvedValue({ data: rollout }) as ConsoleApiClient["GET"],
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("new-console")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByTestId("new-console")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/console/overview");
  });

  it.each([
    ["legacy route", { ...rollout, effective_route: "legacy" }],
    ["effective false", { ...rollout, effective_new_console: false }],
    ["kill switch", { ...rollout, kill_switch_active: true }],
    ["malformed", { ...rollout, org_enabled: "true" }],
  ])("fails closed for %s", async (_label, response) => {
    renderBoundary(vi.fn().mockResolvedValue({ data: response }) as ConsoleApiClient["GET"]);

    expect(await screen.findByText("legacy overview")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    expect(screen.queryByTestId("new-console")).not.toBeInTheDocument();
  });

  it("synchronously fails closed without an API call when the evidence-approved manifest is empty", () => {
    const get = vi.fn().mockResolvedValue({ data: rollout }) as ConsoleApiClient["GET"];
    renderBoundary(get, []);

    expect(screen.getByText("legacy overview")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    expect(screen.queryByTestId("new-console")).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("aborts a never-settling rollout request and redirects to legacy overview", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const get = vi.fn((_path: string, options?: { signal?: AbortSignal }) => {
      requestSignal = options?.signal;
      return new Promise(() => {});
    }) as unknown as ConsoleApiClient["GET"];

    renderBoundary(get);
    expect(screen.getByRole("status", { name: "새 콘솔 사용 가능 여부 확인 중" })).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(requestSignal?.aborted).toBe(true);
    expect(screen.getByText("legacy overview")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    expect(screen.queryByTestId("new-console")).not.toBeInTheDocument();
  });

  it("latches denial when an abort-ignoring request resolves allowed during timeout", async () => {
    vi.useFakeTimers();
    const get = vi.fn((_path: string, options?: { signal?: AbortSignal }) =>
      new Promise<{ data: typeof rollout }>((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          resolve({ data: rollout });
        });
      }),
    ) as unknown as ConsoleApiClient["GET"];

    renderBoundary(get);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText("legacy overview")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    expect(screen.queryByTestId("new-console")).not.toBeInTheDocument();
  });

  it("fails closed on transport errors", async () => {
    renderBoundary(vi.fn().mockRejectedValue(new Error("offline")) as ConsoleApiClient["GET"]);

    expect(await screen.findByText("legacy overview")).toBeInTheDocument();
    expect(screen.queryByTestId("new-console")).not.toBeInTheDocument();
  });
});
