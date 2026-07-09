import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { branchId, workOrderListItems } from "../../test/fixtures";
import { CommandPalette } from "./CommandPalette";

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

function authValue(): AuthContextValue {
  const session: AuthSession = {
    access_token: "test-token",
    user_id: "user-1",
    display_name: "테스터",
    roles: ["ADMIN"],
    branches: [branchId],
    feature_grants: [],
  };
  return {
    session,
    restoring: false,
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(session.access_token),
  };
}

function renderPalette(onPinObject?: (candidate: { kind: string; code: string }) => void) {
  return render(
    <AuthContext.Provider value={authValue()}>
      <MemoryRouter initialEntries={["/work-hub"]}>
        <CommandPalette onClose={() => undefined} onPinObject={onPinObject as never} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("CommandPalette (UI-M2a)", () => {
  it("returns pending work + screens + people from the real APIs (AC5)", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({
          items: workOrderListItems,
          limit: 100,
          offset: 0,
          total: workOrderListItems.length,
        }),
      ),
      http.get("*/api/messenger/members", () =>
        HttpResponse.json({
          items: [{ id: "22222222-2222-4222-8222-222222222222", display_name: "홍길동", team: "MAINTENANCE" }],
        }),
      ),
    );

    renderPalette();

    // Screens (client-side, instant) — a role-visible nav item.
    expect(screen.getByText("배차")).toBeInTheDocument();
    // Pending work (real /api/v1/work-orders) — resolved once the fetch lands.
    expect(await screen.findByText(/케이앤엘/)).toBeInTheDocument();
    // People (real /api/messenger/members, NOT the admin /api/v1/users).
    expect(await screen.findByText("홍길동")).toBeInTheDocument();

    // Each object row carries its issued code / id for routing.
    expect(screen.getAllByText(/WO-/).length).toBeGreaterThan(0);
  });

  it("fetches both pages once on open, then narrows client-side as the query changes (no refetch)", async () => {
    let workRequests = 0;
    let memberRequests = 0;
    server.use(
      http.get("*/api/v1/work-orders", () => {
        workRequests += 1;
        return HttpResponse.json({
          items: workOrderListItems,
          limit: 100,
          offset: 0,
          total: workOrderListItems.length,
        });
      }),
      http.get("*/api/messenger/members", () => {
        memberRequests += 1;
        return HttpResponse.json({
          items: [
            { id: "22222222-2222-4222-8222-222222222222", display_name: "홍길동", team: "MAINTENANCE" },
            { id: "33333333-3333-4333-8333-333333333333", display_name: "김철수", team: "MAINTENANCE" },
          ],
        });
      }),
    );

    renderPalette();

    // Both pages fetched exactly once on open.
    expect(await screen.findByText("홍길동")).toBeInTheDocument();
    expect(screen.getByText("김철수")).toBeInTheDocument();
    expect(workRequests).toBe(1);
    expect(memberRequests).toBe(1);

    // Typing narrows the cached people page client-side (200ms-debounced),
    // without any further network fetch.
    const input = screen.getByRole("combobox", { name: ko.shell.commandPalette.searchLabel });
    fireEvent.change(input, { target: { value: "홍길동" } });

    await waitFor(() => {
      expect(screen.queryByText("김철수")).not.toBeInTheDocument();
    });
    expect(screen.getByText("홍길동")).toBeInTheDocument();
    expect(workRequests).toBe(1);
    expect(memberRequests).toBe(1);
  });

  it("pins an object result (not navigate) when onPinObject is provided — the ConsoleShell path", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () => HttpResponse.json({ items: [], limit: 100, offset: 0, total: 0 })),
      http.get("*/api/messenger/members", () =>
        HttpResponse.json({
          items: [{ id: "22222222-2222-4222-8222-222222222222", display_name: "홍길동", team: "MAINTENANCE" }],
        }),
      ),
    );
    const pinned: { kind: string; code: string }[] = [];
    renderPalette((c) => pinned.push(c));

    fireEvent.click(await screen.findByText("홍길동"));

    expect(pinned).toEqual([
      expect.objectContaining({ kind: "person", code: "22222222-2222-4222-8222-222222222222" }),
    ]);
  });

  it("omits work/people rows when their APIs deny (deny-by-omission), keeping screens", async () => {
    let workOrdersRequested = false;
    let membersRequested = false;
    server.use(
      http.get("*/api/v1/work-orders", () => {
        workOrdersRequested = true;
        return HttpResponse.json({ error: "forbidden" }, { status: 403 });
      }),
      http.get("*/api/messenger/members", () => {
        membersRequested = true;
        return HttpResponse.json({ error: "forbidden" }, { status: 403 });
      }),
    );

    renderPalette();

    expect(screen.getByText("배차")).toBeInTheDocument();
    await waitFor(() => {
      expect(workOrdersRequested).toBe(true);
      expect(membersRequested).toBe(true);
    });
    // No object sections when both providers error.
    expect(screen.queryByText("대기 업무")).not.toBeInTheDocument();
    expect(screen.queryByText("사람")).not.toBeInTheDocument();
  });

  it("announces the active keyboard result through aria-activedescendant", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () => HttpResponse.json({ items: [], limit: 100, offset: 0, total: 0 })),
      http.get("*/api/messenger/members", () => HttpResponse.json({ items: [] })),
    );

    renderPalette();

    const input = screen.getByRole("combobox", {
      name: ko.shell.commandPalette.searchLabel,
    });
    const firstActiveId = input.getAttribute("aria-activedescendant");
    expect(firstActiveId).toBeTruthy();
    expect(document.getElementById(firstActiveId ?? "")).not.toBeNull();

    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => {
      expect(input.getAttribute("aria-activedescendant")).not.toBe(firstActiveId);
    });
    const nextActiveId = input.getAttribute("aria-activedescendant");
    expect(nextActiveId).toBeTruthy();
    expect(document.getElementById(nextActiveId ?? "")).not.toBeNull();
  });
});
