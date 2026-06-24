import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BranchChip } from "./Topbar";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
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

function renderChip(session: AuthSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <BranchChip />
    </AuthContext.Provider>,
  );
}

const branchName = "(주)KNL 본사";

describe("BranchChip", () => {
  it("resolves and shows the active branch NAME, not the UUID", async () => {
    server.use(
      http.get("*/api/v1/branches", () =>
        HttpResponse.json([
          {
            id: branchId,
            region_id: "00000000-0000-4000-8000-000000000000",
            name: branchName,
            deactivated_at: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ]),
      ),
    );

    renderChip({ access_token: "a", roles: ["ADMIN"], branches: [branchId] });

    expect(await screen.findByText(`지점: ${branchName}`)).toBeVisible();
    // The raw branch UUID (or its tail) must never appear.
    expect(screen.queryByText(/지점:.*1111/)).not.toBeInTheDocument();
  });

  it("falls back to a neutral label when the branch is unresolvable", async () => {
    server.use(
      http.get("*/api/v1/branches", () => HttpResponse.json([])),
    );

    renderChip({ access_token: "a", roles: ["ADMIN"], branches: [branchId] });

    expect(await screen.findByText("지점: 지점 미확인")).toBeVisible();
    expect(screen.queryByText(new RegExp(branchId.slice(-4)))).not.toBeInTheDocument();
  });

  it("falls back to the neutral label when the branch fetch fails", async () => {
    server.use(
      http.get("*/api/v1/branches", () => new HttpResponse(null, { status: 500 })),
    );

    renderChip({ access_token: "a", roles: ["ADMIN"], branches: [branchId] });

    expect(await screen.findByText("지점: 지점 미확인")).toBeVisible();
  });

  it("renders nothing when the session carries no branch", async () => {
    const { container } = renderChip({ access_token: "a", roles: ["ADMIN"] });
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });
});
