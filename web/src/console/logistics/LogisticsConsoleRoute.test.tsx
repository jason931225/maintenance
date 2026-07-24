import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { logisticsStrings as text } from "../../i18n/logistics";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { LogisticsConsoleRoute } from "./LogisticsConsoleRoute";

const session = (branches: string[] = ["branch-a"], incarnation = "session-a"): AuthSession => ({
  access_token: "token",
  user_id: "user-1",
  org_id: "org-1",
  client_session_incarnation: incarnation,
  branches,
});

const client = () => ({ GET: vi.fn(), POST: vi.fn() }) as unknown as ConsoleApiClient;

function mounted(api: ConsoleApiClient, currentSession = session()) {
  return (
    <AuthTestProvider session={currentSession} overrides={{ api }}>
      <LogisticsConsoleRoute />
    </AuthTestProvider>
  );
}

function authzResponse(capabilities: unknown[]) {
  return new Response(
    JSON.stringify({
      roles: [],
      branch_scope: { kind: "branches", branches: ["branch-a"] },
      capabilities,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("LogisticsConsoleRoute", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers the receive affordance from a parsed MeAuthzResponse allow capability", async () => {
    const api = client();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        authzResponse([
          {
            feature: "logistics_receive",
            permission: "allow",
            branch_scope: { kind: "branches", branches: ["branch-a"] },
          },
        ]),
      ),
    );
    render(mounted(api));
    expect(await screen.findByRole("form", { name: text.createAsn })).toBeVisible();
    expect(screen.queryByRole("form", { name: text.release })).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("denies request_only capabilities without leaking any control", async () => {
    const api = client();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        authzResponse([
          { feature: "logistics_receive", permission: "request_only", branch_scope: { kind: "all" } },
        ]),
      ),
    );
    render(mounted(api));
    expect(await screen.findByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("form")).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("denies a session branch outside the capability's branch scope", async () => {
    const api = client();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        authzResponse([
          {
            feature: "logistics_receive",
            permission: "allow",
            branch_scope: { kind: "branches", branches: ["branch-a"] },
          },
        ]),
      ),
    );
    render(mounted(api, session(["branch-b"])));
    expect(await screen.findByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("renders the truthful no-branch state when the JWT carries no branch", async () => {
    const api = client();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authzResponse([])));
    render(mounted(api, session([])));
    expect(await screen.findByText(text.noBranch)).toBeVisible();
    expect(screen.queryByRole("form")).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("selects the acting branch in-module when the session spans branches", async () => {
    const user = userEvent.setup();
    const api = client();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        authzResponse([
          { feature: "logistics_receive", permission: "allow", branch_scope: { kind: "all" } },
        ]),
      ),
    );
    render(mounted(api, session(["branch-a", "branch-b"])));
    const picker = await screen.findByLabelText(text.branch);
    expect(picker).toHaveValue("branch-a");
    await user.selectOptions(picker, "branch-b");
    expect(picker).toHaveValue("branch-b");
    expect(await screen.findByRole("form", { name: text.createAsn })).toBeVisible();
  });
});
