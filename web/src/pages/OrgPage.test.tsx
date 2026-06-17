import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";

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

const REGION = "r1";
const regions = [
  { id: REGION, name: "수도권", created_at: "2026-01-01T00:00:00Z" },
];
const branches = [
  {
    id: "b1",
    region_id: REGION,
    name: "강남지점",
    created_at: "2026-01-01T00:00:00Z",
  },
];

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
    api,
  };
}

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const adminSession: AuthSession = { access_token: "a", roles: ["ADMIN"] };

describe("OrgPage", () => {
  it("redirects a non-admin away from /settings/org", async () => {
    renderApp(
      "/settings/org",
      makeAuthContext({ access_token: "a", roles: ["RECEPTIONIST"] }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "지역·지점 관리" }),
      ).not.toBeInTheDocument();
    });
  });

  it("lists regions and branches", async () => {
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    // "수도권" appears both in the region list and the branch-region <select>.
    expect((await screen.findAllByText("수도권")).length).toBeGreaterThan(0);
    expect(screen.getByText("강남지점")).toBeVisible();
  });

  it("creates a region", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/regions", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          { id: "r2", name: "충청권", created_at: "2026-01-01T00:00:00Z" },
          { status: 201 },
        );
      }),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    await screen.findAllByText("수도권");
    await user.type(screen.getByLabelText("지역명"), "충청권");
    await user.click(screen.getByRole("button", { name: "지역 등록" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({ name: "충청권" });
    });
  });

  it("creates a branch referencing a region", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/branches", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          {
            id: "b2",
            region_id: REGION,
            name: "분당지점",
            created_at: "2026-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    await screen.findByText("강남지점");
    await user.type(screen.getByLabelText("지점명"), "분당지점");
    await user.selectOptions(screen.getByLabelText("지역"), REGION);
    await user.click(screen.getByRole("button", { name: "지점 등록" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({
        name: "분당지점",
        region_id: REGION,
      });
    });
  });
});
